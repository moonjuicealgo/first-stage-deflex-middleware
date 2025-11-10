import algosdk, { TransactionSigner, Transaction, Algodv2, makeApplicationCallTxnFromObject } from 'algosdk';
import { FirstStageMiddleware } from '../src/index';

// ---------- CONFIG ----------
const ALGOD_SERVER = 'https://mainnet-api.algonode.cloud';
const ALGOD_TOKEN = '';
const ALGOD_PORT = '';

const TEST_ADDRESS = 'NOLXAGDW6KLLX3GRIVGU72HPHW7WWUN2VE7GUZOLYKEG7FGM6FENVFFEXQ';

// ---------- SETUP ----------
const algodClient = new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_SERVER, ALGOD_PORT);
const middleware = new FirstStageMiddleware();

// ---------- DUMMY SIGNER ----------
const dummySigner: TransactionSigner = async (txns: Transaction[]) =>
  txns.map(() => new Uint8Array());

// ---------- HELPERS ----------
function inspectTransactions(txns: { txn: Transaction }[]) {
  if (!txns || txns.length === 0) {
    console.log('⚠️ No transactions returned');
    return;
  }

  console.log('\n===== Transaction Group =====');
  txns.forEach((wrapped, i) => {
    const tx = wrapped.txn;
    console.log(`#${i + 1} Type: ${tx.type} | Fee: ${tx.fee}`);
    console.log(`   Sender: ${algosdk.encodeAddress(tx.sender.publicKey)}`);
    if (tx.type === 'axfer') {
      console.log(`   AssetTransfer: ${tx.assetTransfer?.assetIndex} (${tx.assetTransfer?.amount})`);
    }
    if (tx.type === 'appl') {
      const args = tx.applicationCall?.appArgs?.map(a => Buffer.from(a).toString()) ?? [];
      console.log(`   AppCall → ID: ${tx.applicationCall?.appIndex}, Args: [${args.join(', ')}]`);
console.log('   Box References:');
tx.applicationCall?.boxes?.forEach((b, i) => {
  console.log(`     #${i + 1} AppID: ${b.appIndex}, Name (hex): ${Buffer.from(b.name).toString('hex')}`);
  console.log(`             Name (base64): ${Buffer.from(b.name).toString('base64')}`);
});

    }
    console.log('----------------------------');
  });
}

// ---------- TEST FUNCTIONS ----------
async function testAdjustQuoteParams() {
  const params = {
    fromASAID: 2154668640n,
    toASAID: 312769n,
    amount: 1_000_000,
    address: TEST_ADDRESS,
    maxGroupSize: 16,
    type: 'fixed-input' as const,
  };

  const adjusted = await middleware.adjustQuoteParams(params as any);
  console.log('Adjusted quote params:', adjusted);
}

async function testBeforeSwap() {
  const suggestedParams = await algodClient.getTransactionParams().do();

  const context = {
    address: TEST_ADDRESS,
    fromASAID: 2154668640n,
    toASAID: 312769n,
    algodClient,
    signer: dummySigner,
    suggestedParams,
  };

    const fromInfo = await middleware.getAssetInfo(context.fromASAID, context.algodClient);
  const toInfo = await middleware.getAssetInfo(context.toASAID, context.algodClient);

  console.log('From Asset Info:', fromInfo);
  console.log('To Asset Info:', toInfo);

  const txns = await middleware.beforeSwap(context as any);
  console.log('Before swap txns:');
  inspectTransactions(txns);
}

async function testAfterSwap() {
  const suggestedParams = await algodClient.getTransactionParams().do();


  const context = {
    address: TEST_ADDRESS,
    fromASAID: 2154668640n,
    toASAID: 312769n,
    algodClient,
    signer: dummySigner,
    suggestedParams,
    quote: { amount: 100_000_000 },
  };

  const txns = await middleware.afterSwap(context as any);
  console.log('\n After swap txns:');
  inspectTransactions(txns);
}

// ---------- RUN ALL TESTS ----------
async function main() {
  console.log('--- Testing adjustQuoteParams ---');
  await testAdjustQuoteParams();

  console.log('--- Testing beforeSwap ---');
  await testBeforeSwap();

  console.log('--- Testing afterSwap ---');
  await testAfterSwap();
}

main().catch(console.error);

