import algosdk, { Transaction, TransactionSigner } from 'algosdk';
import { FirstStageMiddleware } from '../src/index';

/**
 * The middleware around a real pool swap, against the FirstStage that MainNet is being
 * upgraded to (TestNet app 774294818, deployed from the same build).
 *
 * testnetBuyTaxTest stands a plain transfer in for the swap. This one routes through a real
 * Tinyman v2 pool, as Deflex or Haystack would, because the new FirstStage settles its tax
 * inside the trade through its AMM adapter: what the group has to name, and how much opcode
 * budget it has, depend on the router's transactions being there.
 *
 * Each group is simulated twice. Strictly, as it will be sent: it must pass. Then with
 * unnamed resources allowed, which reports anything the group failed to name, so a failure
 * says what is missing rather than only that something is.
 *
 * The goal it holds the middleware to: no more transactions than the three per asset it has
 * always added (top, tax transfer, bottom), so a router quote loses no more group slots than
 * it does today.
 */
// Every default is TestNet; each can be overridden to aim at another token, pool or network
// (LocalNet runs Pact, which no TestNet First Stage token has graduated into).
const env = process.env;
const ALGOD_SERVER = env.FS_TEST_ALGOD ?? 'https://testnet-api.algonode.cloud';
const ALGOD_TOKEN = env.FS_TEST_ALGOD_TOKEN ?? '';
const APP_ID = BigInt(env.FS_TEST_APP ?? 774294818);
const ASSET = BigInt(env.FS_TEST_ASSET ?? 774632374);
const POOL = env.FS_TEST_POOL ?? 'L4HX2VWXEVKI2ASWWBELLUCP3KPATZ4IXXICJAMKQPUDTGC7WYK557LCMU';
// What the pool pairs the token with: ALGO unless set.
const PAIR = BigInt(env.FS_TEST_PAIR ?? 0);
// 'tinyman' (the validator app) or 'pact' (the pool's own app, FS_TEST_POOL_APP).
const DEX = env.FS_TEST_DEX ?? 'tinyman';
const TINYMAN_VALIDATOR = BigInt(env.FS_TEST_TINYMAN ?? 148607000);
const POOL_APP = BigInt(env.FS_TEST_POOL_APP ?? 0);
// A registered, non-exempt holder of ASSET - or, to test a first swap, any funded wallet.
const USER = env.FS_TEST_ADDRESS ?? 'SZ52YIRBX4SH2YOV4WMX6UID4F2OKV4PKDOJ6ENUUSZOBFDU2ULCTDVC4U';
const BUY_IN = BigInt(env.FS_TEST_BUY_IN ?? 200_000);
const SELL_IN = BigInt(env.FS_TEST_SELL_IN ?? 1_000_000_000);
const SIDES = (env.FS_TEST_SIDES ?? 'buy,sell').split(',');

// algosdk takes the port on its own; one left in the URL is ignored and it falls back to 80.
const algodUrl = new URL(ALGOD_SERVER);
const algod = new algosdk.Algodv2(ALGOD_TOKEN, `${algodUrl.protocol}//${algodUrl.hostname}`, algodUrl.port);
const signer: TransactionSigner = algosdk.makeEmptyTransactionSigner();
const enc = new TextEncoder();

/** The pool's reserves of the token and of what it pairs with, and its fee. */
async function poolState(): Promise<{ token: bigint; algo: bigint; feeBps: bigint }> {
  if (DEX === 'pact') {
    const app = await algod.getApplicationByID(POOL_APP).do();
    const kv = app.params.globalState ?? [];
    const get = (k: string) => BigInt(kv.find((e) => Buffer.from(e.key).toString() === k)?.value.uint ?? 0);
    // Pact orders its pair with the smaller asset id as A.
    const tokenIsA = ASSET < PAIR;
    return { token: get(tokenIsA ? 'A' : 'B'), algo: get(tokenIsA ? 'B' : 'A'), feeBps: get('FEE_BPS') || 30n };
  }
  const info = await algod.accountApplicationInformation(POOL, Number(TINYMAN_VALIDATOR)).do();
  const kv = info.appLocalState?.keyValue ?? [];
  const get = (k: string) => {
    const hit = kv.find((e) => Buffer.from(e.key).toString() === k);
    return BigInt(hit?.value.uint ?? 0);
  };
  // Tinyman puts the larger asset id first as asset 1.
  const tokenIs1 = ASSET > PAIR;
  return {
    token: get(tokenIs1 ? 'asset_1_reserves' : 'asset_2_reserves'),
    algo: get(tokenIs1 ? 'asset_2_reserves' : 'asset_1_reserves'),
    feeBps: get('total_fee_share'),
  };
}

function swapOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: bigint): bigint {
  const fee = (amountIn * feeBps + 9_999n) / 10_000n;
  const net = amountIn - fee;
  return (reserveOut * net) / (reserveIn + net);
}

/** What the router would put in the group: the input to the pool, then the pool's swap call. */
function routerTxns(sp: algosdk.SuggestedParams, buying: boolean, amountIn: bigint): Transaction[] {
  const inAsset = buying ? PAIR : ASSET;
  const input =
    inAsset === 0n
      ? algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: USER, receiver: POOL, amount: amountIn, suggestedParams: sp })
      : algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
          sender: USER,
          receiver: POOL,
          assetIndex: Number(inAsset),
          amount: amountIn,
          suggestedParams: sp,
        });
  const call =
    DEX === 'pact'
      ? algosdk.makeApplicationNoOpTxnFromObject({
          sender: USER,
          appIndex: Number(POOL_APP),
          appArgs: [enc.encode('SWAP'), algosdk.encodeUint64(0)],
          foreignAssets: [Number(ASSET < PAIR ? ASSET : PAIR), Number(ASSET < PAIR ? PAIR : ASSET)],
          suggestedParams: { ...sp, flatFee: true, fee: 2_000n },
        })
      : algosdk.makeApplicationNoOpTxnFromObject({
          sender: USER,
          appIndex: Number(TINYMAN_VALIDATOR),
          appArgs: [enc.encode('swap'), enc.encode('fixed-input'), algosdk.encodeUint64(0)],
          accounts: [POOL],
          foreignAssets: [Number(ASSET), Number(PAIR)],
          suggestedParams: { ...sp, flatFee: true, fee: 2_000n },
        });
  return [input, call];
}

async function simulate(txns: Transaction[], allowUnnamed: boolean) {
  const atc = new algosdk.AtomicTransactionComposer();
  for (const txn of txns) {
    // The composer assigns the group id; a transaction that already carries one is refused.
    (txn as { group?: Uint8Array }).group = undefined;
    atc.addTransaction({ txn, signer });
  }
  const res = await atc.simulate(
    algod,
    new algosdk.modelsv2.SimulateRequest({
      txnGroups: [],
      allowEmptySignatures: true,
      fixSigners: true,
      allowUnnamedResources: allowUnnamed,
      allowMoreLogging: true,
    })
  );
  return res.simulateResponse.txnGroups[0];
}

async function run(label: string, buying: boolean, amountIn: bigint): Promise<boolean> {
  console.log(`\n=== ${label} ===`);
  const sp = await algod.getTransactionParams().do();
  const { token, algo, feeBps } = await poolState();
  const out = buying ? swapOut(amountIn, algo, token, feeBps) : swapOut(amountIn, token, algo, feeBps);

  const middleware = new FirstStageMiddleware({ appId: APP_ID });
  const fromASAID = buying ? PAIR : ASSET;
  const toASAID = buying ? ASSET : PAIR;
  // A fixed-input request: on a sell the middleware shrinks it by the tax and the router is
  // quoted on the rest, which is what goes into the pool here.
  const requested = amountIn;
  const adjusted = await middleware.adjustQuoteParams({
    fromASAID,
    toASAID,
    amount: requested,
    address: USER,
    maxGroupSize: 16,
    type: 'fixed-input',
    algodClient: algod,
  } as never);
  const routedIn = buying ? amountIn : BigInt(adjusted.amount);
  const routedOut = buying ? out : swapOut(routedIn, token, algo, feeBps);
  console.log(`  requested ${requested}, routed in ${routedIn}, out ${routedOut}; maxGroupSize 16 -> ${adjusted.maxGroupSize}`);

  const context = {
    address: USER,
    fromASAID,
    toASAID,
    algodClient: algod,
    signer,
    suggestedParams: sp,
    quote: { amount: requested, quote: buying ? routedOut : routedOut, type: 'fixed-input' },
  };
  const before = await middleware.beforeSwap(context as never);
  const after = await middleware.afterSwap(context as never);
  const router = routerTxns(sp, buying, routedIn);
  const group = [...before.map((t) => t.txn), ...router, ...after.map((t) => t.txn)];
  console.log(`  ${before.length + after.length} middleware transactions + ${router.length} router = ${group.length}`);

  const strict = await simulate(group, false);
  if (!strict.failureMessage) {
    console.log('  strict simulate: OK');
    // With the wallet's key (TestNet only), send it too: a real confirmation, and holdings for
    // a sell to be tested against.
    if (env.FS_TEST_MNEMONIC_FILE) {
      const { readFileSync } = await import('fs');
      const account = algosdk.mnemonicToSecretKey(readFileSync(env.FS_TEST_MNEMONIC_FILE, 'utf-8').trim());
      if (account.addr.toString() !== USER) throw new Error('FS_TEST_MNEMONIC_FILE is not FS_TEST_ADDRESS');
      const atc = new algosdk.AtomicTransactionComposer();
      for (const txn of group) {
        (txn as { group?: Uint8Array }).group = undefined;
        atc.addTransaction({ txn, signer: algosdk.makeBasicAccountTransactionSigner(account) });
      }
      const sent = await atc.execute(algod, 8);
      console.log(`  sent: confirmed in round ${sent.confirmedRound}, ${sent.txIDs[0]}`);
    }
    return true;
  }
  console.log(`  strict simulate FAILED at ${strict.failedAt}: ${strict.failureMessage.slice(0, 220)}`);
  const loose = await simulate(group, true);
  console.log(`  with unnamed resources: ${loose.failureMessage ? `FAILED: ${loose.failureMessage.slice(0, 220)}` : 'OK'}`);
  const unnamed = loose.unnamedResourcesAccessed;
  if (unnamed) console.log('  group needs, unnamed:', JSON.stringify(unnamed, (_, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 900));
  loose.txnResults.forEach((r, i) => {
    const u = r.unnamedResourcesAccessed;
    if (u) console.log(`  txn ${i} needs, unnamed:`, JSON.stringify(u, (_, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 600));
  });
  const used = loose.appBudgetConsumed;
  const added = loose.appBudgetAdded;
  console.log(`  opcode budget: consumed ${used} of ${added}`);
  return false;
}

async function main() {
  console.log(`FirstStage ${APP_ID} at ${ALGOD_SERVER}, asset ${ASSET} paired with ${PAIR}, ${DEX} pool ${POOL.slice(0, 8)}..., wallet ${USER.slice(0, 8)}...`);
  const buyOk = SIDES.includes('buy') ? await run(`buy ${BUY_IN} base units of ${PAIR || 'ALGO'} worth`, true, BUY_IN) : true;
  const sellOk = SIDES.includes('sell') ? await run(`sell ${SELL_IN} base units of the token`, false, SELL_IN) : true;
  console.log(`\nbuy ${buyOk ? 'PASS' : 'FAIL'}, sell ${sellOk ? 'PASS' : 'FAIL'}`);
  process.exitCode = buyOk && sellOk ? 0 : 1;
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e, e?.cause ?? '', env.FS_TEST_DEBUG ? e?.stack : '');
  process.exitCode = 1;
});
