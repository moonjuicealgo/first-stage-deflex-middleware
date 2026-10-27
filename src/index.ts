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
import { FirstStageClient } from './FirstStageClientMinimal.js';
import {
  getBoxKeyForAsset,
  getUserAssetBoxKey,
  getExemptWalletBoxKey,
  ZERO_ADDRESS,
} from './boxes.js';
import { decodeAssetBox, type AssetInformation } from './decoders.js';
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount';
import { AlgorandClient } from '@algorandfoundation/algokit-utils';

const FIRST_STAGE_MAINNET_APP_ID = 3158291365;
const DEFAULT_ALGOD_SERVER = 'https://mainnet-api.algonode.cloud';

/** MBR for the 40-byte key / 48-byte value user_asset_info box the freeze call creates. */
const USER_BOX_MBR = 37_700;
/** An asset box is a 249-byte AssetInformation struct. */
const MIN_ASSET_BOX_LENGTH = 249;

/** general_operations_top, the tax transfer, and general_operations_bottom. */
const TXNS_PER_FIRST_STAGE_ASSET = 3;
/** MBR payment + freeze call, needed once per asset to create the user box. */
const TXNS_PER_FREEZE = 2;
/**
 * An `increase_budget` call for an asset whose tax pays a hook: the hook's account and its
 * bookkeeping need references and opcode budget that the top and bottom calls have no room
 * for. Only those assets pay this slot.
 */
const TXNS_PER_HOOK = 1;

/** Whether the upgraded contract pays a hook out of this asset's tax. */
const paysHook = (info: AssetInformation | null): boolean => Boolean(info?.hook_app_id);

/**
 * Two `increase_budget` calls for an asset in tax mode 2: its tax settles into another asset
 * (USDC, say) through its own tax pool, and the protocol fee out of that asset into ALGO
 * through the adapter's route. Two pools, their holdings of three assets, the route box and
 * the tax pool's record are more than the top and bottom calls and one padding call hold -
 * FirstStage's own settlement test measures it. Only those assets pay these slots.
 */
const TXNS_PER_TAX_POOL = 2;

/** Whether the upgraded contract settles this asset's tax through a tax pool (mode 2). */
const settlesInTaxAsset = (info: AssetInformation | null): boolean => info?.tax_mode === 2n;
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

const enc = new TextEncoder();

/** The exact tax for one side of a transfer, as the upgraded FirstStage will charge it. */
const QUOTE_TAX_SIDE = algosdk.ABIMethod.fromSignature('quote_tax_amount_side(asset,uint64,bool)uint64');

/** A one-letter prefix and an asset id: the key of FirstStage's per-asset boxes. */
const prefixedAssetKey = (prefix: string, assetId: bigint): Uint8Array =>
  new Uint8Array([...enc.encode(prefix), ...algosdk.encodeUint64(assetId)]);

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

/**
 * The accounts and application general_operations_bottom pays out to. Read from the app's
 * global state rather than hardcoded, so the same middleware works against a TestNet
 * deployment (different burn wallet, different Tinyman app) as against MainNet.
 */
interface AppConfig {
  burnWallet: string;
  admin: string;
  poolAppId: bigint;
  /**
   * The AMM adapter the upgraded FirstStage swaps its tax through, inside the trade - named
   * by its "amm" box. 0 on a FirstStage without one, which settles nothing in the trade.
   */
  adapterAppId: bigint;
  /** The Pact factory the adapter proves a Pact pool against, from its global state; 0 if none. */
  pactFactoryId: bigint;
}

export interface FirstStageMiddlewareOptions {
  /** First Stage referral address, which collects a share of the tax volume. */
  referralAddress?: string;
  /** FirstStage application to talk to. Defaults to the MainNet deployment. */
  appId?: bigint | number;
}

export class FirstStageMiddleware implements SwapMiddleware {
  readonly name = 'FirstStageDeflex';
  readonly version = '2.0.1';
  private readonly appId: bigint;
  private readonly fsReferralAddress?: string;

  private algod?: algosdk.Algodv2;
  private fsClient?: FirstStageClient;
  private fsClientAlgod?: algosdk.Algodv2;
  private readonly assetInfoCache = new Map<string, CacheEntry<AssetInformation | null>>();
  private readonly planCache = new Map<string, CacheEntry<AssetPlan>>();
  private readonly appConfigCache = new Map<string, CacheEntry<AppConfig>>();
  /** Set once the app turns out to have no `quote_tax_amount_side`: the stored rates are used. */
  private quoteUnsupported = false;

  constructor(config?: string | FirstStageMiddlewareOptions) {
    const options = typeof config === 'string' ? { referralAddress: config } : (config ?? {});
    this.appId = BigInt(options.appId ?? FIRST_STAGE_MAINNET_APP_ID);
    this.fsReferralAddress = options.referralAddress;
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

  private getAppConfig(algod: algosdk.Algodv2): Promise<AppConfig> {
    return this.memo(this.appConfigCache, this.appId.toString(), async () => {
      const app = await algod.getApplicationByID(this.appId).do();
      const state = app.params.globalState ?? [];

      const toBytes = (value: unknown): Uint8Array =>
        typeof value === 'string' ? Buffer.from(value, 'base64') : (value as Uint8Array);
      const find = (name: string) =>
        state.find((kv) => Buffer.from(toBytes(kv.key)).toString('utf-8') === name)?.value;

      const address = (name: string): string => {
        const raw = find(name)?.bytes;
        if (!raw) throw new Error(`FirstStage app ${this.appId} has no ${name} in global state`);
        return algosdk.encodeAddress(toBytes(raw));
      };

      return {
        burnWallet: address('global_burn_wallet'),
        admin: address('global_admin'),
        poolAppId: BigInt(find('pool_app_id')?.uint ?? 0),
        adapterAppId: await this.readBoxUint(algod, enc.encode('amm')),
        pactFactoryId: await this.readAdapterFactory(algod),
      };
    });
  }

  private async getBoxReferences(
    userAddr: string,
    assetId: bigint,
    algodClient: algosdk.Algodv2
  ): Promise<{ appId: bigint; name: Uint8Array }[]> {
    const boxes = [
      { appId: this.appId, name: getBoxKeyForAsset(Number(assetId)) },
      { appId: this.appId, name: getUserAssetBoxKey(Number(assetId), userAddr) },
      { appId: this.appId, name: await getExemptWalletBoxKey('g', userAddr) },
      { appId: this.appId, name: await getExemptWalletBoxKey('r', userAddr, algodClient) },
    ];
    // The upgraded FirstStage settles the tax in the trade: it looks up its adapter ("amm")
    // and whether the main pool is Pact ("v" + asset, absent for Tinyman). A box it only
    // checks for still has to be named, and each name also adds 1KB to the group's box read
    // budget, which a 505-byte record needs.
    if ((await this.getAppConfig(algodClient)).adapterAppId) {
      boxes.push({ appId: this.appId, name: enc.encode('amm') });
      boxes.push({ appId: this.appId, name: prefixedAssetKey('v', assetId) });
    }
    return boxes;
  }

  /** A FirstStage box holding one uint64, or 0 when the box does not exist. */
  /**
   * What a mode-2 asset's tax swap reaches: its tax pool and that pool's app, and the
   * adapter's route out of the tax asset into ALGO. The route is the protocol admin's choice,
   * one pool per tax asset, stored in the adapter's "r" box as the pool's address, its app and
   * which DEX it is; with no route set, the adapter skips that swap and the trade still goes.
   */
  private async taxPoolRoute(
    info: AssetInformation,
    assetId: bigint,
    algod: algosdk.Algodv2,
    tinymanApp: bigint
  ): Promise<{ taxAsset: bigint; taxPool: string; taxPoolApp: bigint; routePool?: string; routeApp?: bigint }> {
    const taxAsset = info.tax_asset_id ?? 0n;
    const taxPoolApp = (await this.readBoxUint(algod, prefixedAssetKey('x', assetId))) || tinymanApp;
    const { adapterAppId } = await this.getAppConfig(algod);
    let routePool: string | undefined;
    let routeApp: bigint | undefined;
    try {
      const res = await algod.getApplicationBoxByName(adapterAppId, prefixedAssetKey('r', taxAsset)).do();
      const raw = new Uint8Array(res.value);
      routePool = algosdk.encodeAddress(raw.slice(0, 32));
      routeApp = algosdk.decodeUint64(raw.slice(32, 40), 'bigint') || tinymanApp;
    } catch (err: any) {
      if (!isNotFound(err)) throw err;
    }
    return { taxAsset, taxPool: info.tax_asset_pool ?? ZERO_ADDRESS, taxPoolApp, routePool, routeApp };
  }

  /** The adapter's `pact_factory_id`: a mode-2 swap through a Pact pool reads it to prove the pool. */
  private async readAdapterFactory(algod: algosdk.Algodv2): Promise<bigint> {
    const adapter = await this.readBoxUint(algod, enc.encode('amm'));
    if (!adapter) return 0n;
    const app = await algod.getApplicationByID(adapter).do();
    const entry = (app.params.globalState ?? []).find(
      (kv) => Buffer.from(typeof kv.key === 'string' ? Buffer.from(kv.key, 'base64') : kv.key).toString() === 'pact_factory_id'
    );
    return BigInt(entry?.value.uint ?? 0);
  }

  private async readBoxUint(algod: algosdk.Algodv2, name: Uint8Array): Promise<bigint> {
    try {
      const res = await algod.getApplicationBoxByName(this.appId, name).do();
      return algosdk.decodeUint64(new Uint8Array(res.value).slice(0, 8), 'bigint');
    } catch (err: any) {
      if (isNotFound(err)) return 0n;
      throw err;
    }
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
      if (paysHook(plan.info)) reservedTxns += TXNS_PER_HOOK;
      if (settlesInTaxAsset(plan.info)) reservedTxns += TXNS_PER_TAX_POOL;
      if (!plan.userBoxExists) reservedTxns += TXNS_PER_FREEZE;

      // fixed-input sell: the requested amount has to cover both the swap and the tax, so the
      // router is quoted on the post-tax remainder.
      if (type === 'fixed-input' && assetId === fromASAID) {
        adjustedAmount -= await this.taxOn(params.address, plan.info, assetId, adjustedAmount, false, algod);
      }

      // fixed-output buy: the tax comes out of what the router delivers, so ask for enough
      // extra that the user is left with the amount they requested.
      if (type === 'fixed-output' && assetId === toASAID) {
        adjustedAmount += await this.taxOnTop(params.address, plan.info, assetId, adjustedAmount, true, algod);
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
      const appConfig = await this.getAppConfig(algod);
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
          // Freezing also checks the asset's hook-protection box ("p" + asset), so the hook
          // the tax pays cannot be frozen: 7 boxes and the asset, 8 of 8.
          boxReferences: appConfig.adapterAppId ? [...boxes, { appId: this.appId, name: prefixedAssetKey('p', assetId) }] : boxes,
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
        // The upgraded FirstStage no longer pays the admin inside a trade, and the two settlement
        // boxes above take the slot it used: 6 boxes, the asset and the burn wallet are 8 of 8.
        accountReferences: appConfig.adapterAppId ? [appConfig.burnWallet] : [appConfig.burnWallet, appConfig.admin],
        extraFee: AlgoAmount.MicroAlgos(1000n),
        ...validity,
      });

      for (const t of topTx.transactions) txns.push({ txn: t, signer });

      if (paysHook(plan.info)) {
        const hookAccount = algosdk.getApplicationAddress(plan.info.hook_app_id!).toString();
        const padTx = await fsClient.createTransaction.increaseBudget({
          sender: address,
          signer,
          args: [],
          accountReferences: [hookAccount],
          assetReferences: [assetId],
          appReferences: [plan.info.hook_app_id!],
          // The hook's event log ("e" + asset), which the bottom call appends this trade to.
          boxReferences: [{ appId: this.appId, name: prefixedAssetKey('e', assetId) }],
          note: enc.encode(`fs-hook-${assetId}`),
          ...validity,
        });
        for (const t of padTx.transactions) txns.push({ txn: t, signer });
      }

      if (settlesInTaxAsset(plan.info) && appConfig.adapterAppId) {
        const route = await this.taxPoolRoute(plan.info, assetId, algod, appConfig.poolAppId);
        const adapterAccount = algosdk.getApplicationAddress(appConfig.adapterAppId).toString();
        const reserve = (await algod.getAssetByID(Number(assetId)).do()).params.reserve;
        const projectAccount = (reserve ?? ZERO_ADDRESS).toString();
        // A pool's holding, or its local state in an AMM, is only available when the account
        // and the asset or app are named on the SAME call - so each side goes on its own call.
        // The route side: turning the tax asset into ALGO for the protocol fee.
        const routeSide = await fsClient.createTransaction.increaseBudget({
          sender: address,
          signer,
          args: [],
          appReferences: [appConfig.adapterAppId, ...(route.routeApp ? [route.routeApp] : [])],
          accountReferences: route.routePool ? [route.routePool] : [],
          assetReferences: [route.taxAsset, 0n],
          boxReferences: [
            { appId: appConfig.adapterAppId, name: prefixedAssetKey('r', route.taxAsset) },
            { appId: this.appId, name: prefixedAssetKey('x', assetId) },
          ],
          note: enc.encode(`fs-route-${assetId}`),
          ...validity,
        });
        // The tax pool side: the token in, the tax asset out, and everyone paid in it.
        const poolSide = await fsClient.createTransaction.increaseBudget({
          sender: address,
          signer,
          args: [],
          // The Pact factory too: the adapter proves a Pact tax pool by reading it.
          appReferences: [route.taxPoolApp, ...(appConfig.pactFactoryId ? [appConfig.pactFactoryId] : [])],
          // And the admin: in mode 2 the protocol's fee, turned to ALGO, is paid out in the trade.
          accountReferences: [route.taxPool, projectAccount, adapterAccount, appConfig.admin],
          assetReferences: [route.taxAsset, assetId],
          note: enc.encode(`fs-taxpool-${assetId}`),
          ...validity,
        });
        for (const t of [...routeSide.transactions, ...poolSide.transactions]) txns.push({ txn: t, signer });
      }
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
        amount: await this.calculateTax(address, assetId, plan.info, side, quote, algod),
        suggestedParams,
      });

      const assetParams = await algod.getAssetByID(Number(assetId)).do();
      const projectAccount = (assetParams.params.reserve ?? ZERO_ADDRESS).toString();
      const poolAccount = plan.info.main_pool || ZERO_ADDRESS;
      const appConfig = await this.getAppConfig(algod);

      // No box references here: the top call already made them available to the group. The
      // pool, the project account, the referral (an ABI account argument), the asset and the
      // pool's app take 5 of this call's 8 reference slots. The upgraded FirstStage swaps the
      // tax through its AMM adapter inside this call, which takes the other three: the
      // adapter, the adapter's own account (it holds the token), and ALGO, which a Pact pool's
      // swap lists and an inner call can only name if the group already has.
      const settles = appConfig.adapterAppId !== 0n;
      const pactApp = settles ? await this.readBoxUint(algod, prefixedAssetKey('v', assetId)) : 0n;
      const bottomTx = await fsClient.createTransaction.generalOperationsBottom({
        sender: address,
        signer,
        args: [2n, assetId, { txn: taxTxn, signer }, referralAddress],
        accountReferences: settles
          ? [poolAccount, projectAccount, algosdk.getApplicationAddress(appConfig.adapterAppId).toString()]
          : [poolAccount, projectAccount],
        appReferences: settles ? [pactApp || appConfig.poolAppId, appConfig.adapterAppId] : [appConfig.poolAppId],
        assetReferences: settles ? [0n] : undefined,
        // Settling in the trade runs the adapter's swap as inner transactions, each paid for
        // here: up to two hops, plus the payouts that follow.
        extraFee: AlgoAmount.MicroAlgos(settles ? 24_000n : 11_000n),
        firstValidRound: BigInt(suggestedParams.firstValid),
        lastValidRound: BigInt(suggestedParams.lastValid),
      });

      for (const t of bottomTx.transactions) txns.push({ txn: t, signer });
    }

    return txns;
  }

  /**
   * The tax a quoted swap pays on each side, in base units of that side's asset - what a swap
   * page shows beside the router's figure. Two of the four cases are already net, because
   * adjustQuoteParams changed what the router was asked; the other two are not:
   * a fixed-input buy delivers `quote.quote - to`, and a fixed-output sell spends
   * `quote.quote + from`. Exempt wallets and assets that are not First Stage pay 0.
   */
  async swapTax(
    quote: NonNullable<SwapContext['quote']>,
    address: string,
    algodClient?: algosdk.Algodv2
  ): Promise<{ from: bigint; to: bigint }> {
    const algod = this.resolveAlgod(algodClient);
    const side = async (assetId: bigint, s: Side): Promise<bigint> => {
      if (!assetId) return 0n;
      const plan = await this.getPlan(address, assetId, algod);
      if (!plan.info || plan.exempt) return 0n;
      return this.calculateTax(address, assetId, plan.info, s, quote, algod);
    };
    const [from, to] = await Promise.all([
      side(BigInt(quote.fromASAID ?? 0), 'from'),
      side(BigInt(quote.toASAID ?? 0), 'to'),
    ]);
    return { from, to };
  }

  /**
   * The tax to transfer for one side of the swap.
   *
   * The contract taxes a sell on everything that left the wallet, the tax transfer included,
   * and a buy on everything that arrived. Underpayment fails the group with "Insufficient tax
   * payment"; overpayment is refunded.
   */
  private async calculateTax(
    address: string,
    assetId: bigint,
    info: AssetInformation,
    side: Side,
    quote: SwapContext['quote'],
    algod: algosdk.Algodv2
  ): Promise<bigint> {
    const isFixedOutput = quote?.type === 'fixed-output';
    // `amount` is the caller's original request, before adjustQuoteParams changed it; `quote`
    // is the other end of the trade, which the router computed from the adjusted amount.
    const requested = BigInt(quote?.amount ?? 0);
    const routed = BigInt(quote?.quote ?? 0);

    if (side === 'from') {
      if (isFixedOutput) {
        // The router needs `routed` units of input; the tax is charged on top of that.
        this.assertQuoted(routed);
        return this.taxOnTop(address, info, assetId, routed, false, algod);
      }
      // The router was quoted on requested - tax, so the wallet's total outflow is `requested`.
      this.assertQuoted(requested);
      return this.taxOn(address, info, assetId, requested, false, algod);
    }

    // Buy side: taxed on what arrives. On a fixed-output buy that is what the user asked for
    // plus the tax itself, which adjustQuoteParams asked the router for.
    if (isFixedOutput) {
      this.assertQuoted(requested);
      return this.taxOnTop(address, info, assetId, requested, true, algod);
    }
    this.assertQuoted(routed);
    return this.taxOn(address, info, assetId, routed, true, algod);
  }

  /** The tax on `amount` moved: the contract's own quote, or the stored rates where it has none. */
  private async taxOn(
    address: string,
    info: AssetInformation,
    assetId: bigint,
    amount: bigint,
    isBuy: boolean,
    algod: algosdk.Algodv2
  ): Promise<bigint> {
    if (amount === 0n) return 0n;
    const quoted = await this.quoteTax(address, assetId, amount, isBuy, algod);
    if (quoted !== null) return quoted;
    const bps = (isBuy ? info.buy_tax : info.sell_tax) ? info.total_tax_bps : 0n;
    return ceilDiv(amount * bps, 10_000n);
  }

  /**
   * The tax when it is itself part of what is taxed: `net` moves and the tax moves with it, so
   * the base is net + tax. Converges in a step or two; the last unit is rounded up, since an
   * overpayment is refunded and an underpayment fails.
   */
  private async taxOnTop(
    address: string,
    info: AssetInformation,
    assetId: bigint,
    net: bigint,
    isBuy: boolean,
    algod: algosdk.Algodv2
  ): Promise<bigint> {
    let tax = await this.taxOn(address, info, assetId, net, isBuy, algod);
    for (let i = 0; i < 4; i++) {
      const next = await this.taxOn(address, info, assetId, net + tax, isBuy, algod);
      if (next <= tax) break;
      tax = next;
    }
    return tax === 0n ? 0n : tax + 1n;
  }

  /**
   * The contract's `quote_tax_amount_side`, by simulation: the side's own rates, any hook's
   * share, and a dynamic rate at this size of trade - none of which the stored rates show.
   * Null on a FirstStage that predates the method, remembered so it is asked only once.
   */
  private async quoteTax(
    address: string,
    assetId: bigint,
    amount: bigint,
    isBuy: boolean,
    algod: algosdk.Algodv2
  ): Promise<bigint | null> {
    if (this.quoteUnsupported) return null;
    try {
      const atc = new algosdk.AtomicTransactionComposer();
      atc.addMethodCall({
        appID: this.appId,
        method: QUOTE_TAX_SIDE,
        methodArgs: [assetId, amount, isBuy],
        sender: address,
        signer: algosdk.makeEmptyTransactionSigner(),
        suggestedParams: await algod.getTransactionParams().do(),
      });
      const res = await atc.simulate(
        algod,
        new algosdk.modelsv2.SimulateRequest({
          txnGroups: [],
          allowEmptySignatures: true,
          allowUnnamedResources: true,
          // A rekeyed wallet's transactions are authorized by another account; without this,
          // algod rejects the unsigned call and no rekeyed wallet could get a quote.
          fixSigners: true,
        })
      );
      const failure = res.simulateResponse.txnGroups[0]?.failureMessage;
      if (failure) throw new Error(failure);
      const result = res.methodResults[0];
      if (result?.decodeError || result?.returnValue === undefined) throw new Error('no return value');
      return BigInt(result.returnValue as bigint);
    } catch (err: any) {
      // A contract without the method rejects the call outright (its router has no match);
      // anything else is a real failure and should not be papered over with the stored rates.
      if (/rejected by ApprovalProgram|err opcode/i.test(String(err?.message))) {
        this.quoteUnsupported = true;
        return null;
      }
      throw err;
    }
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
    // Only the definite answer. `check_is_address_maybe_exempt_app` answers false on every
    // contract this version supports, and a FirstStage built between 2026-10-08 and the
    // MainNet upgrade does not have it at all.
    const exempt = await fsClient.checkIsAddressExempt({
      sender: address,
      args: [address, assetId],
    });
    return exempt === true;
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
