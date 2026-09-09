import algosdk, {
  TransactionWithSigner,
  makePaymentTxnWithSuggestedParamsFromObject,
} from 'algosdk';
import type {
  SwapMiddleware,
  SwapContext,
  QuoteContext,
  FetchQuoteParams,
  QuoteType,
} from '@txnlab/deflex';
import { FirstStageClient } from './FirstStageClientMinimal';
import {
  getBoxKeyForAsset,
  getUserAssetBoxKey,
  getExemptWalletBoxKey,
  ZERO_ADDRESS,
} from './boxes';
import { decodeAssetBox, type AssetInformation } from './decoders';
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount';
import { AlgorandClient } from '@algorandfoundation/algokit-utils';

const FIRST_STAGE_MAINNET_APP_ID = 3158291365;
const TM_APP_ID = 1002541853n;
const BONFIRE_WALLET = 'BNFIREKGRXEHCFOEQLTX3PU5SUCMRKDU7WHNBGZA4SXPW42OAHZBP7BPHY';
const DEPLOYER_WALLET = 'FJHGNHTMRSQCISPDN2N6FTFKXM64S2X52M6BYONH7ZMON3SPRUZTSAHV54';
const DEFAULT_ALGOD_SERVER = 'https://mainnet-api.algonode.cloud';

/** MBR for the 40-byte key / 48-byte value user_asset_info box the freeze call creates. */
const USER_BOX_MBR = 37_700;
/** An asset box is a 249-byte AssetInformation struct. */
const MIN_ASSET_BOX_LENGTH = 249;

/** general_operations_top, the tax transfer, and general_operations_bottom. */
const TXNS_PER_FIRST_STAGE_ASSET = 3;
/** MBR payment + freeze call, needed once per asset to create the user box. */
const TXNS_PER_FREEZE = 2;
const TXNS_PER_OPT_IN = 1;

/**
 * Deflex asks each hook independently, so one swap resolves the same asset several times.
 * Caching collapses that into a single round trip while staying short enough that a client
 * kept alive across swaps still sees a newly created user box or a reconfigured tax rate.
 */
const CACHE_TTL_MS = 60_000;

type Side = 'from' | 'to';

interface CacheEntry<T> {
  at: number;
  value: Promise<T>;
}

const ceilDiv = (numerator: bigint, denominator: bigint): bigint =>
  denominator === 0n ? 0n : (numerator + denominator - 1n) / denominator;

const isNotFound = (err: any): boolean =>
  err?.status === 404 || err?.response?.status === 404 || /not found/i.test(String(err?.message));

/**
 * Per-asset state the hooks need. Resolved once per swap and reused, because Deflex calls
 * shouldApply/adjustQuoteParams/beforeSwap/afterSwap independently and each one would
 * otherwise repeat the same algod round trips.
 */
interface AssetPlan {
  assetId: bigint;
  info: AssetInformation | null;
  exempt: boolean;
  optedIn: boolean;
  userBoxExists: boolean;
}

export class FirstStageMiddleware implements SwapMiddleware {
  readonly name = 'FirstStageDeflex';
  readonly version = '1.0.2';
  private readonly appId: bigint;
  private readonly fsReferralAddress?: string;

  private algod?: algosdk.Algodv2;
  private fsClient?: FirstStageClient;
  private fsClientAlgod?: algosdk.Algodv2;
  private readonly assetInfoCache = new Map<string, CacheEntry<AssetInformation | null>>();
  private readonly planCache = new Map<string, CacheEntry<AssetPlan>>();

  constructor(fsReferralAddress?: string) {
    this.appId = BigInt(FIRST_STAGE_MAINNET_APP_ID);
    this.fsReferralAddress = fsReferralAddress;
  }

  /**
   * Deflex only passes an algod client on the hook contexts, not on adjustQuoteParams, so we
   * hold on to the one it gave us in shouldApply (always called first).
   */
  private resolveAlgod(algod?: algosdk.Algodv2): algosdk.Algodv2 {
    if (algod) this.algod = algod;
    if (!this.algod) this.algod = new algosdk.Algodv2('', DEFAULT_ALGOD_SERVER, '');
    return this.algod;
  }

  private getClient(algodClient: algosdk.Algodv2): FirstStageClient {
    if (!this.fsClient || this.fsClientAlgod !== algodClient) {
      this.fsClient = new FirstStageClient({
        appId: this.appId,
        algorand: AlgorandClient.fromClients({ algod: algodClient }),
        defaultSigner: algosdk.makeEmptyTransactionSigner(),
      });
      this.fsClientAlgod = algodClient;
    }
    return this.fsClient;
  }

  private async getBoxReferences(
    userAddr: string,
    assetId: bigint,
    algodClient: algosdk.Algodv2
  ): Promise<{ appId: bigint; name: Uint8Array }[]> {
    return [
      { appId: this.appId, name: getBoxKeyForAsset(Number(assetId)) },
      { appId: this.appId, name: getUserAssetBoxKey(Number(assetId), userAddr) },
      { appId: this.appId, name: await getExemptWalletBoxKey('g', userAddr) },
      { appId: this.appId, name: await getExemptWalletBoxKey('r', userAddr, algodClient) },
    ];
  }

  async shouldApply(context: QuoteContext): Promise<boolean> {
    const algod = this.resolveAlgod(context.algodClient);
    const [from, to] = await Promise.all([
      this.getAssetInfo(BigInt(context.fromASAID ?? 0n), algod),
      this.getAssetInfo(BigInt(context.toASAID ?? 0n), algod),
    ]);
    return from !== null || to !== null;
  }

  async adjustQuoteParams(
    params: FetchQuoteParams & {
      address?: string | null;
      algodClient?: algosdk.Algodv2;
    }
  ): Promise<FetchQuoteParams> {
    if (!params.address) throw new Error('Address required for FirstStageMiddleware');

    const algod = this.resolveAlgod(params.algodClient);
    const type: QuoteType = params.type ?? 'fixed-input';
    const fromASAID = BigInt(params.fromASAID ?? 0n);
    const toASAID = BigInt(params.toASAID ?? 0n);

    let reservedTxns = 0;
    let adjustedAmount = BigInt(params.amount ?? 0);

    for (const assetId of new Set([fromASAID, toASAID])) {
      if (!assetId) continue;

      const plan = await this.getPlan(params.address, assetId, algod);
      if (!plan.optedIn) reservedTxns += TXNS_PER_OPT_IN;
      if (!plan.info || plan.exempt) continue;

      // The top/tax/bottom trio is added for every registered asset, taxed or not: the asset
      // is frozen at rest, so without them the swap transfer itself cannot settle.
      reservedTxns += TXNS_PER_FIRST_STAGE_ASSET;
      if (!plan.userBoxExists) reservedTxns += TXNS_PER_FREEZE;

      const bps = plan.info.total_tax_bps;
      if (bps === 0n) continue;

      // fixed-input sell: the requested amount has to cover both the swap and the tax, so the
      // router is quoted on the post-tax remainder.
      if (type === 'fixed-input' && plan.info.sell_tax && assetId === fromASAID) {
        adjustedAmount = (adjustedAmount * (10_000n - bps)) / 10_000n;
      }

      // fixed-output buy: the tax comes out of what the router delivers, so ask for enough
      // extra that the user is left with the amount they requested.
      if (type === 'fixed-output' && plan.info.buy_tax && assetId === toASAID) {
        adjustedAmount = ceilDiv(adjustedAmount * (10_000n + bps), 10_000n);
      }
    }

    const maxGroupSize = Math.max(1, (params.maxGroupSize ?? 16) - reservedTxns);

    return {
      ...params,
      amount: adjustedAmount,
      maxGroupSize,
      optIn: false,
    };
  }

  async beforeSwap(context: SwapContext): Promise<TransactionWithSigner[]> {
    const txns: TransactionWithSigner[] = [];
    const { address, fromASAID, toASAID, algodClient, signer, suggestedParams } = context;
    const algod = this.resolveAlgod(algodClient);
    const fsClient = this.getClient(algod);

    for (const assetId of new Set([fromASAID ?? 0n, toASAID ?? 0n])) {
      if (!assetId) continue;

      const plan = await this.getPlan(address, assetId, algod);

      // Quotes are requested with optIn: false, so any opt-in the swap needs is ours to add.
      if (!plan.optedIn) {
        txns.push({
          txn: algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
            sender: address,
            receiver: address,
            assetIndex: Number(assetId),
            amount: 0,
            suggestedParams,
          }),
          signer,
        });
      }

      // Exempt wallets are never frozen and the contract short-circuits both hooks for them,
      // so adding the calls would only burn group slots (and the tax would be unrecoverable).
      if (!plan.info || plan.exempt) continue;

      const boxes = await this.getBoxReferences(address, assetId, algod);
      const validity = {
        firstValidRound: BigInt(suggestedParams.firstValid),
        lastValidRound: BigInt(suggestedParams.lastValid),
      };

      if (!plan.userBoxExists) {
        const mbrTxn = makePaymentTxnWithSuggestedParamsFromObject({
          sender: address,
          receiver: fsClient.appClient.appAddress,
          amount: USER_BOX_MBR,
          suggestedParams,
        });

        const freezeTx = await fsClient.createTransaction.freeze({
          sender: address,
          signer,
          args: {
            asset: assetId,
            refreezeAddress: address,
            mbr: { txn: mbrTxn, signer },
          },
          boxReferences: boxes,
          extraFee: AlgoAmount.MicroAlgos(2000n),
          ...validity,
        });

        for (const t of freezeTx.transactions) txns.push({ txn: t, signer });
      }

      // This call carries the box references for the whole group. A transaction may only
      // declare 8 references (and 4 accounts), which the bottom call alone would exceed, so
      // the two calls split them and rely on AVM group resource sharing.
      const topTx = await fsClient.createTransaction.generalOperationsTop({
        sender: address,
        signer,
        args: {
          flagtop: 1n,
          asset: assetId,
          userBalance: await this.getUserBalance(address, assetId, algod),
        },
        boxReferences: boxes,
        accountReferences: [BONFIRE_WALLET, DEPLOYER_WALLET],
        extraFee: AlgoAmount.MicroAlgos(1000n),
        ...validity,
      });

      for (const t of topTx.transactions) txns.push({ txn: t, signer });
    }

    return txns;
  }

  async afterSwap(context: SwapContext): Promise<TransactionWithSigner[]> {
    const txns: TransactionWithSigner[] = [];
    const { address, fromASAID, toASAID, signer, quote, algodClient, suggestedParams } = context;
    const algod = this.resolveAlgod(algodClient);
    const fsClient = this.getClient(algod);
    const referralAddress = this.fsReferralAddress ?? ZERO_ADDRESS;

    const sides: [bigint, Side][] = [
      [fromASAID ?? 0n, 'from'],
      [toASAID ?? 0n, 'to'],
    ];

    for (const [assetId, side] of sides) {
      if (!assetId || (side === 'to' && assetId === fromASAID)) continue;

      const plan = await this.getPlan(address, assetId, algod);
      if (!plan.info || plan.exempt) continue;

      const taxTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: address,
        receiver: fsClient.appClient.appAddress,
        assetIndex: Number(assetId),
        amount: this.calculateTax(plan.info, side, quote),
        suggestedParams,
      });

      const assetParams = await algod.getAssetByID(Number(assetId)).do();
      const projectAccount = (assetParams.params.reserve ?? ZERO_ADDRESS).toString();
      const poolAccount = plan.info.main_pool || ZERO_ADDRESS;

      // No box references here: the top call already made them available to the group. The
      // accounts below plus the referral (an ABI account argument) plus the asset and the
      // Tinyman app already put this call at 5 of its 8 reference slots.
      const bottomTx = await fsClient.createTransaction.generalOperationsBottom({
        sender: address,
        signer,
        args: [2n, assetId, { txn: taxTxn, signer }, referralAddress],
        accountReferences: [poolAccount, projectAccount],
        appReferences: [TM_APP_ID],
        extraFee: AlgoAmount.MicroAlgos(11_000n),
        firstValidRound: BigInt(suggestedParams.firstValid),
        lastValidRound: BigInt(suggestedParams.lastValid),
      });

      for (const t of bottomTx.transactions) txns.push({ txn: t, signer });
    }

    return txns;
  }

  /**
   * The contract charges tax on how much of the asset the wallet gained or lost across the
   * group, measured after the tax transfer itself has settled. Overpayment is refunded by the
   * contract, underpayment fails the group with "Insufficient tax payment".
   */
  private calculateTax(info: AssetInformation, side: Side, quote: SwapContext['quote']): bigint {
    const bps = info.total_tax_bps;
    if (bps === 0n) return 0n;
    if (side === 'from' ? !info.sell_tax : !info.buy_tax) return 0n;

    const isFixedOutput = quote?.type === 'fixed-output';
    // `amount` is the caller's original request, before adjustQuoteParams reduced it; `quote`
    // is the other end of the trade, which the router computed from the adjusted amount.
    const requested = BigInt(quote?.amount ?? 0);
    const routed = BigInt(quote?.quote ?? 0);

    if (side === 'from') {
      if (isFixedOutput) {
        // The router needs `routed` units of input; the tax is charged on top of that.
        this.assertQuoted(routed);
        return ceilDiv(routed * bps, 10_000n - bps);
      }
      // The router was quoted on requested - tax, so the wallet's total outflow is `requested`.
      this.assertQuoted(requested);
      return ceilDiv(requested * bps, 10_000n);
    }

    // Buy side: the wallet gains (received - tax), so charging the full rate on the gross
    // received slightly overpays and the contract refunds the difference. That also absorbs
    // the router delivering a little more than it quoted.
    const received = isFixedOutput ? ceilDiv(requested * (10_000n + bps), 10_000n) : routed;
    this.assertQuoted(received);
    return ceilDiv(received * bps, 10_000n);
  }

  private assertQuoted(amount: bigint): void {
    if (amount !== 0n) return;
    throw new Error(
      'FirstStageMiddleware cannot size the tax: the quote carries no amount. Build the swap ' +
        'from a quote returned by DeflexClient.newQuote(), not a raw fetchQuote() response.'
    );
  }

  private memo<T>(
    store: Map<string, CacheEntry<T>>,
    key: string,
    factory: () => Promise<T>
  ): Promise<T> {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    const value = factory();
    store.set(key, { at: Date.now(), value });
    // A failed lookup should not be remembered as an answer.
    value.catch(() => store.delete(key));
    return value;
  }

  /** Resolves (and caches) everything the hooks need to know about one side of the swap. */
  private getPlan(address: string, assetId: bigint, algod: algosdk.Algodv2): Promise<AssetPlan> {
    return this.memo(this.planCache, `${address}:${assetId}`, () =>
      this.buildPlan(address, assetId, algod)
    );
  }

  private async buildPlan(
    address: string,
    assetId: bigint,
    algod: algosdk.Algodv2
  ): Promise<AssetPlan> {
    const info = await this.getAssetInfo(assetId, algod);
    const optedIn = await this.isOptedIn(address, assetId, algod);

    if (!info) {
      return { assetId, info, exempt: false, optedIn, userBoxExists: false };
    }

    const fsClient = this.getClient(algod);
    const [exempt, userBoxExists] = await Promise.all([
      this.isExempt(fsClient, address, assetId),
      this.hasUserBox(fsClient, address, assetId),
    ]);

    return { assetId, info, exempt, optedIn, userBoxExists };
  }

  private async hasUserBox(
    fsClient: FirstStageClient,
    address: string,
    assetId: bigint
  ): Promise<boolean> {
    try {
      await fsClient.appClient.getBoxValue(getUserAssetBoxKey(Number(assetId), address));
      return true;
    } catch (err: any) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  private async isExempt(
    fsClient: FirstStageClient,
    address: string,
    assetId: bigint
  ): Promise<boolean> {
    const exempt = await fsClient.checkIsAddressExempt({
      sender: address,
      args: [address, assetId],
    });
    if (exempt === true) return true;

    const exemptApp = await fsClient.checkIsAddressMaybeExemptApp({
      sender: address,
      args: [address, assetId],
    });
    return exemptApp === true;
  }

  private async isOptedIn(
    address: string,
    assetId: bigint,
    algod: algosdk.Algodv2
  ): Promise<boolean> {
    try {
      const info = await algod.accountAssetInformation(address, Number(assetId)).do();
      return Boolean(info && info['assetHolding']);
    } catch (err: any) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  public getAssetInfo(
    assetId: bigint,
    algod?: algosdk.Algodv2
  ): Promise<AssetInformation | null> {
    if (!assetId) return Promise.resolve(null);
    const client = this.resolveAlgod(algod);
    return this.memo(this.assetInfoCache, assetId.toString(), () =>
      this.fetchAssetInfo(assetId, client)
    );
  }

  private async fetchAssetInfo(
    assetId: bigint,
    algod: algosdk.Algodv2
  ): Promise<AssetInformation | null> {
    try {
      const res = await algod
        .getApplicationBoxByName(this.appId, getBoxKeyForAsset(Number(assetId)))
        .do();
      const buf = new Uint8Array(res.value);

      if (buf.length < MIN_ASSET_BOX_LENGTH) {
        console.warn(`Asset box for asset ${assetId} is too short (${buf.length} bytes). Skipping.`);
        return null;
      }
      return decodeAssetBox(buf);
    } catch (err: any) {
      // A missing box just means the asset is not a First Stage asset.
      if (!isNotFound(err)) {
        console.warn(`Failed to fetch/decode asset box for ${assetId}:`, err);
      }
      return null;
    }
  }

  private async getUserBalance(
    address: string,
    assetId: bigint,
    algod: algosdk.Algodv2
  ): Promise<bigint> {
    try {
      const info = await algod.accountAssetInformation(address, Number(assetId)).do();
      return BigInt(info['assetHolding']?.amount ?? 0);
    } catch (err: any) {
      // general_operations_top asserts this against the on-chain balance, so a guessed value
      // would fail the group with a misleading "Mismatched user balance".
      if (isNotFound(err)) return 0n;
      throw err;
    }
  }
}
