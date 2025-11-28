import algosdk, { TransactionWithSigner, makePaymentTxnWithSuggestedParamsFromObject } from 'algosdk';
import type { SwapMiddleware, SwapContext, FetchQuoteParams } from '@txnlab/deflex';
import { FirstStageClient } from './FirstStageClientMinimal';
import { getBoxKeyForAsset, getUserAssetBoxKey, getExemptWalletBoxKey } from './boxes';
import { decodeAssetBox, decodeUserDepositBox, type AssetInformation } from './decoders';
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount';
import { AlgorandClient } from '@algorandfoundation/algokit-utils';

const FIRST_STAGE_MAINNET_APP_ID = 3158291365;
const TM_APP_ID = 1002541853n;
const BONFIRE_WALLET = 'BNFIREKGRXEHCFOEQLTX3PU5SUCMRKDU7WHNBGZA4SXPW42OAHZBP7BPHY';
const DEPLOYER_WALLET = 'FJHGNHTMRSQCISPDN2N6FTFKXM64S2X52M6BYONH7ZMON3SPRUZTSAHV54';

export class FirstStageMiddleware implements SwapMiddleware {
  readonly name = 'FirstStageDeflex'
  readonly version = '1.0.0'
  private readonly appId: bigint
  private readonly fsClientCache = new Map<string, FirstStageClient>()
  private readonly fsReferralAddress?: string

  constructor(fsReferralAddress?: string) {
    this.appId = BigInt(FIRST_STAGE_MAINNET_APP_ID)
    this.fsReferralAddress = fsReferralAddress
  }

  private getClient(sender: string, algodClient: algosdk.Algodv2): FirstStageClient {
    if (!this.fsClientCache.has(sender)) {
      const algokitClient = AlgorandClient.fromClients({ algod: algodClient });
      const fsClient = new FirstStageClient({
        appId: this.appId,
        algorand: algokitClient,
        defaultSigner: algosdk.makeEmptyTransactionSigner(),
      });
      this.fsClientCache.set(sender, fsClient);
    }
    return this.fsClientCache.get(sender)!;
  }

  private async getBoxReferences(
    userAddr: string,
    assetId: bigint,
    algodClient: algosdk.Algodv2
  ): Promise<{ appId: bigint; name: Uint8Array; write?: boolean }[]> {
    const assetBox = { appId: this.appId, name: getBoxKeyForAsset(Number(assetId)) };
    const userBox = { appId: this.appId, name: getUserAssetBoxKey(Number(assetId), userAddr), write: true };

    const gBox = await getExemptWalletBoxKey('g', userAddr);
    const rBox = await getExemptWalletBoxKey('r', userAddr, algodClient);

    return [
      assetBox,
      userBox,
      { appId: this.appId, name: gBox, write: false },
      { appId: this.appId, name: rBox, write: false },
    ];
  }

  async shouldApply(params: { fromASAID: bigint; toASAID: bigint }): Promise<boolean> {
    return params.fromASAID !== 0n || params.toASAID !== 0n;
  }

    private async hasUserBox(fsClient: FirstStageClient, address: string, assetId: bigint): Promise<boolean> {
  try {
    const key = getUserAssetBoxKey(Number(assetId), address);
    await fsClient.appClient.getBoxValue(key);
    return true;
  } catch {
    return false;
  }
}

async adjustQuoteParams(
  params: FetchQuoteParams & {
    address?: string
    amount?: number
    maxGroupSize?: number
    algodClient: algosdk.Algodv2
  }
): Promise<FetchQuoteParams> {
  if (!params.address) throw new Error('Address required for FirstStageMiddleware');

  let reservedTxns = 0n;
  let adjustedAmount = BigInt(params.amount ?? 0);

  const assets = [params.fromASAID, params.toASAID];

  for (const assetId of assets) {
    if (!assetId || assetId === 0n) continue;

    const assetInfo = await this.getAssetInfo(BigInt(assetId), params.algodClient);
    if (!assetInfo) continue;

    if (assetInfo.sell_tax || assetInfo.buy_tax) reservedTxns += 3n;

    if (assetInfo.sell_tax && assetId === params.fromASAID) {
      adjustedAmount = (adjustedAmount * (10_000n - assetInfo.total_tax_bps)) / 10_000n;
    }

    if (assetInfo.buy_tax && assetId === params.toASAID) {
      adjustedAmount = (adjustedAmount * 10_000n) / (10_000n - assetInfo.total_tax_bps);
    }
  }

  const maxGroupSize = Math.max(1, (params.maxGroupSize ?? 16) - Number(reservedTxns));

  return {
    ...params,
    amount: Number(adjustedAmount),
    maxGroupSize,
    optIn: false,
    _fsAdjustedAmount: adjustedAmount,
  } as FetchQuoteParams & { _fsAdjustedAmount?: bigint };
}

  async beforeSwap(context: SwapContext): Promise<TransactionWithSigner[]> {
    const txns: TransactionWithSigner[] = [];
    const { address, fromASAID, toASAID, algodClient, signer, suggestedParams } = context;
    const fsClient = this.getClient(address, algodClient);

    const assetIds = Array.from(new Set([fromASAID ?? 0n, toASAID ?? 0n]));

    for (const assetId of assetIds) {
      if (!assetId || assetId === 0n) continue;

      const optedIn = await this.isOptedIn(address, assetId, algodClient);

if (!optedIn) {
  const optInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: address,
    receiver: address,
    assetIndex: Number(assetId),
    amount: 0,
    suggestedParams,
  });
  txns.push({ txn: optInTxn, signer });
}

      const assetInfo = await this.getAssetInfo(assetId, algodClient);
      if (!assetInfo) continue;

      const boxes = await this.getBoxReferences(address, assetId, algodClient);

              const freezeEligible = await this.isFreezeEligible(fsClient, address, assetId);
const userBoxExists = await this.hasUserBox(fsClient, address, assetId);

if (freezeEligible && !userBoxExists) {

      if (assetId === fromASAID || assetId === toASAID) {

          const mbrTxn = makePaymentTxnWithSuggestedParamsFromObject({
            sender: address,
            receiver: fsClient.appClient.appAddress,
            amount: 37_700,
            suggestedParams,
          });
          const freezeTx = await fsClient.createTransaction.freeze({
            sender: address,
            signer,
            args: { asset: assetId, refreezeAddress: address, mbr: { txn: mbrTxn, signer } },
            boxReferences: boxes,
            extraFee: AlgoAmount.MicroAlgos(2000n),
          });
          for (const t of freezeTx.transactions) txns.push({ txn: t, signer });
        }
      }

      const balance = await this.getUserBalance(address, assetId, algodClient);
      const topTx = await fsClient.createTransaction.generalOperationsTop({
        sender: address,
        signer,
        args: { flagtop: 1n, asset: assetId, userBalance: balance },
        boxReferences: boxes,
        extraFee: AlgoAmount.MicroAlgos(1000n),
      });
      for (const t of topTx.transactions) txns.push({ txn: t, signer });
    }

    return txns;
  }


  async afterSwap(context: SwapContext): Promise<TransactionWithSigner[]> {
  const txns: TransactionWithSigner[] = [];
  const ZERO_ADDRESS = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
  const { address, fromASAID, toASAID, signer, quote, algodClient } = context;
  const fsClient = this.getClient(address, algodClient);

    const FS_REFERRAL = this.fsReferralAddress ?? ZERO_ADDRESS
  const handleIfFirstStage = async (assetId: bigint, isFromAsset: boolean, isToAsset: boolean) => {
    if (!assetId || assetId === 0n) return;

    const assetInfo = await this.getAssetInfo(assetId, algodClient);
    if (!assetInfo) return;

let taxAmount = 0n;

const isFixedOutput = (quote as any).type === 'fixed-output';
const baseForTax = BigInt((quote as any)[isFixedOutput ? 'quote' : 'amount'] ?? 0) * 10_000n / BigInt(isFixedOutput ? (10_000n - (assetInfo.total_tax_bps ?? 0)) : 10_000n);



if (isFromAsset && assetInfo.sell_tax) {
  taxAmount = (baseForTax * BigInt(assetInfo.total_tax_bps)) / 10_000n;
} else if (isToAsset && assetInfo.buy_tax) {
  taxAmount = (baseForTax * BigInt(assetInfo.total_tax_bps)) / 10_000n;
}


    const taxTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: address,
      receiver: fsClient.appClient.appAddress,
      assetIndex: Number(assetId),
      amount: Number(taxAmount),
      suggestedParams: context.suggestedParams,
    });

    const poolAccount = (assetInfo as any).main_pool ?? ZERO_ADDRESS;
    const info = await algodClient.getAssetByID(Number(assetId)).do();
    const projectAccount = info.params.reserve ?? ZERO_ADDRESS;

    const bottomTx = await fsClient.createTransaction.generalOperationsBottom({
      sender: address,
      signer,
      args: [2n, assetId, { txn: taxTxn, signer }, FS_REFERRAL],
      accountReferences: [poolAccount, BONFIRE_WALLET, DEPLOYER_WALLET, projectAccount],
      appReferences: [TM_APP_ID],
      extraFee: AlgoAmount.MicroAlgos(11_000n),
    });

    for (const t of bottomTx.transactions) txns.push({ txn: t, signer });
  };

  await handleIfFirstStage(fromASAID, true, fromASAID === toASAID);
  await handleIfFirstStage(toASAID, false, true);

  return txns;
}

  private async isOptedIn(address: string, assetId: bigint, algod: algosdk.Algodv2): Promise<boolean> {
    try {
      const info = await algod.accountAssetInformation(address, Number(assetId)).do();
      return Boolean(info && info['assetHolding']);
    } catch (err: any) {
      if (err?.response?.status === 404) return false;
      return true;
    }
  }

public async getAssetInfo(
  assetId: bigint,
  algod?: algosdk.Algodv2
): Promise<AssetInformation | null> {
  const client = algod ?? new algosdk.Algodv2('', 'https://mainnet-api.algonode.cloud', '');
  
  try {
    const key = getBoxKeyForAsset(Number(assetId));
    const res = await client.getApplicationBoxByName(this.appId, key).do();
    return decodeAssetBox(new Uint8Array(res.value));
  } catch {
    return null;
  }
}
  private async getUserBalance(address: string, assetId: bigint, algod: algosdk.Algodv2): Promise<bigint> {
    try {
      const info = await algod.accountAssetInformation(address, Number(assetId)).do();
      return BigInt(info['assetHolding']?.amount ?? 0);
    } catch {
      return 0n;
    }
  }

  private async isFreezeEligible(fsClient: FirstStageClient, address: string, assetId: bigint): Promise<boolean> {
  const exemptResult = await fsClient.checkIsAddressExempt({
    sender: address,
    args: [address, BigInt(assetId)]
  });

  if (exemptResult === true) {
    return false;
  }

  const maybeExemptAppResult = await fsClient.checkIsAddressMaybeExemptApp({
    sender: address,
    args: [address, BigInt(assetId)]
  });

  if (maybeExemptAppResult === true) {
    return false;
  }

  return true;
}

  private async isFrozen(fsClient: FirstStageClient, address: string, assetId: bigint): Promise<boolean> {
    try {
      const key = getUserAssetBoxKey(Number(assetId), address);
      const box = await fsClient.appClient.getBoxValue(key);
      const decoded = decodeUserDepositBox(box);
      return (decoded as any).is_frozen ?? false;
    } catch {
      return false;
    }
  }

}
