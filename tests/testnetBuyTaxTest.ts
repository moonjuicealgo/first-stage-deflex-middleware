import algosdk, { Transaction, TransactionSigner } from 'algosdk';
import { FirstStageMiddleware } from '../src/index';

/**
 * No MainNet asset has buy_tax enabled, so the buy side of the tax calculation is verified
 * against TestNet, where FirstStage 743789179 (same global state schema and 249-byte asset
 * box as the MainNet deployment) has asset 754512864 registered with buy_tax AND sell_tax,
 * and with a non-zero liquidity_tax_bps. No MainNet asset has one of those either, and this
 * is what proved the contract counts it towards the tax the caller has to transfer.
 *
 * Deflex has no TestNet router, so the swap leg is stood in for by a plain transfer between
 * the test wallet and a whale: that is all the contract sees of the swap anyway, since it
 * only measures how much of the asset the wallet gained or lost across the group.
 */
const ALGOD_SERVER = 'https://testnet-api.algonode.cloud';
const APP_ID = 743789179n;
const ASSET = 754512864n;
const ALGO = 0n;

// Holds the asset and is not exempt.
const USER = process.env.FS_TEST_ADDRESS ?? 'PAHZVFYPTL7NIXSDTJCBXPGR4XVQT2B2EEC37VXEQTQCYPL22FF6Y4U5PU';
// Unfrozen holder that plays the part of the DEX pool.
const WHALE = 'FJHGNHTMRSQCISPDN2N6FTFKXM64S2X52M6BYONH7ZMON3SPRUZTSAHV54';

const algodClient = new algosdk.Algodv2('', ALGOD_SERVER, '');
const dummySigner: TransactionSigner = algosdk.makeEmptyTransactionSigner();

function describe(txns: { txn: Transaction }[], label: string) {
  console.log(` ${label}:`);
  if (txns.length === 0) return console.log('  (none)');
  txns.forEach((w, i) => {
    const t = w.txn;
    const detail = t.assetTransfer
      ? `asset ${t.assetTransfer.assetIndex} amount ${t.assetTransfer.amount}`
      : t.applicationCall
        ? `app ${t.applicationCall.appIndex}`
        : '';
    console.log(`  #${i + 1} ${t.type} fee=${t.fee} ${detail}`);
  });
}

async function simulate(txns: Transaction[]) {
  const atc = new algosdk.AtomicTransactionComposer();
  for (const txn of txns) atc.addTransaction({ txn, signer: dummySigner });

  const res = await atc.simulate(
    algodClient,
    new algosdk.modelsv2.SimulateRequest({
      txnGroups: [],
      allowEmptySignatures: true,
      fixSigners: true,
      allowUnnamedResources: false,
    })
  );

  const group = res.simulateResponse.txnGroups[0];
  if (group.failureMessage) {
    console.log(`  SIMULATE FAILED at ${group.failedAt}: ${group.failureMessage}`);
    return false;
  }

  // The contract refunds tax paid above what it requires, so the refund tells us how far the
  // middleware's arithmetic is from the contract's.
  const refunds = group.txnResults
    .flatMap((r) => r.txnResult.innerTxns ?? [])
    .filter((inner) => inner.txn.txn.type === 'axfer' && inner.txn.txn.assetTransfer?.receiver.toString() === USER)
    .map((inner) => inner.txn.txn.assetTransfer?.amount ?? 0n);

  console.log(`  SIMULATE OK${refunds.length ? ` (tax refunded to user: ${refunds.join(', ')})` : ''}`);
  return true;
}

async function balanceOf(address: string): Promise<bigint> {
  try {
    const info = await algodClient.accountAssetInformation(address, Number(ASSET)).do();
    return BigInt(info['assetHolding']?.amount ?? 0);
  } catch {
    return 0n;
  }
}

async function run(label: string, fromASAID: bigint, toASAID: bigint, requested: bigint, delivered: bigint) {
  console.log(`\n=== ${label} ===`);
  const middleware = new FirstStageMiddleware({ appId: APP_ID });
  const suggestedParams = await algodClient.getTransactionParams().do();

  // Exactly what Deflex does: the middleware adjusts the request, the router works from the
  // adjusted amount, and the quote reports the other side of the trade.
  const adjusted = await middleware.adjustQuoteParams({
    fromASAID,
    toASAID,
    amount: requested,
    address: USER,
    maxGroupSize: 16,
    type: 'fixed-input',
    algodClient,
  } as never);

  // On a sell the router is handed the adjusted amount of the asset; on a buy it delivers the
  // asset and the adjusted amount is the ALGO being spent.
  const routed = toASAID === ASSET ? delivered : BigInt(adjusted.amount);
  console.log(`  requested ${requested} -> routed ${adjusted.amount}, maxGroupSize ${adjusted.maxGroupSize}`);

  const context = {
    address: USER,
    fromASAID,
    toASAID,
    algodClient,
    signer: dummySigner,
    suggestedParams,
    quote: { amount: requested, quote: routed, type: 'fixed-input' },
  };

  const before = await middleware.beforeSwap(context as never);
  const after = await middleware.afterSwap(context as never);

  // Stand-in for the swap: the asset moves to the user on a buy, away from them on a sell.
  const isBuy = toASAID === ASSET;
  const swapLeg = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: isBuy ? WHALE : USER,
    receiver: isBuy ? USER : WHALE,
    assetIndex: Number(ASSET),
    amount: isBuy ? routed : routed,
    suggestedParams,
  });

  describe(before, 'beforeSwap');
  console.log(` swap stand-in: ${isBuy ? 'whale -> user' : 'user -> whale'} ${routed}`);
  describe(after, 'afterSwap');

  const tax = after.find((t) => t.txn.assetTransfer)?.txn.assetTransfer?.amount ?? 0n;
  const delta = isBuy ? routed - tax : routed + tax;
  console.log(`  middleware pays ${tax} tax on a wallet delta of ${delta}`);

  return simulate([...before.map((t) => t.txn), swapLeg, ...after.map((t) => t.txn)]);
}

async function main() {
  const middleware = new FirstStageMiddleware({ appId: APP_ID });
  const info = await middleware.getAssetInfo(ASSET, algodClient);
  console.log(`FirstStage ${APP_ID} on TestNet, asset ${ASSET}`);
  console.log(
    `  total tax ${info?.total_tax_bps} bps (project ${info?.project_tax_bps},` +
      ` burn ${info?.burn_tax_bps}, reflection ${info?.reflection_tax_bps},` +
      ` freeze ${info?.freeze_tax_bps}, liquidity ${info?.liquidity_tax_bps})`
  );
  console.log(`  buy_tax ${info?.buy_tax}, sell_tax ${info?.sell_tax}`);
  console.log(`  user holds ${await balanceOf(USER)}, whale holds ${await balanceOf(WHALE)}`);

  // Buy: spend 10 ALGO, router delivers 1_000_000_000 units of the asset.
  const buyOk = await run('buy (ALGO -> asset, buy_tax)', ALGO, ASSET, 10_000_000n, 1_000_000_000n);

  // Sell: ask to sell 1_000_000_000 units; the delivered ALGO is irrelevant to the tax.
  const sellOk = await run('sell (asset -> ALGO, sell_tax)', ASSET, ALGO, 1_000_000_000n, 0n);

  console.log(`\nbuy ${buyOk ? 'PASS' : 'FAIL'}, sell ${sellOk ? 'PASS' : 'FAIL'}`);
}

main().catch((e) => console.error('FATAL', e?.message ?? e));
