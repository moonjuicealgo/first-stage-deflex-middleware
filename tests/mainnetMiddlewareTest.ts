import algosdk, { Transaction, TransactionSigner } from 'algosdk';
import { FirstStageMiddleware } from '../src/index';

// ---------- CONFIG ----------
const ALGOD_SERVER = 'https://mainnet-api.algonode.cloud';
const ALGOD_TOKEN = '';
const ALGOD_PORT = '';

// Override with FS_TEST_ADDRESS to check the flow for a specific wallet. The default is a
// public MOOJ holder that is neither exempt nor registered yet, so it exercises the full
// path: opt-in check, user box creation (freeze) and the top/tax/bottom trio.
const TEST_ADDRESS =
  process.env.FS_TEST_ADDRESS ?? 'AAALMNIKYS7LY7T57ABW4SIJII66TMHXKSOO5S2MBMNMEXIWCYAYYKNMRU';

const MOOJ = 2154668640n;
const ALGO = 0n;

// ---------- SETUP ----------
const algodClient = new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_SERVER, ALGOD_PORT);
const dummySigner: TransactionSigner = algosdk.makeEmptyTransactionSigner();

// ---------- HELPERS ----------
function inspectTransactions(txns: { txn: Transaction }[]) {
  if (!txns || txns.length === 0) {
    console.log('  (no transactions)');
    return;
  }

  txns.forEach((wrapped, i) => {
    const tx = wrapped.txn;
    const call = tx.applicationCall;
    const refs = call
      ? (call.accounts?.length ?? 0) +
        (call.foreignAssets?.length ?? 0) +
        (call.foreignApps?.length ?? 0) +
        (call.boxes?.length ?? 0)
      : 0;

    console.log(`  #${i + 1} ${tx.type} fee=${tx.fee}`);
    if (tx.assetTransfer) {
      console.log(`     asset ${tx.assetTransfer.assetIndex} amount ${tx.assetTransfer.amount}`);
    }
    if (call) {
      // A single transaction may reference at most 8 resources, of which at most 4 accounts.
      console.log(
        `     app ${call.appIndex} refs=${refs}/8 (accounts=${call.accounts?.length ?? 0}/4,` +
          ` assets=${call.foreignAssets?.length ?? 0}, apps=${call.foreignApps?.length ?? 0},` +
          ` boxes=${call.boxes?.length ?? 0})`
      );
      if (refs > 8) console.log('     ^^ EXCEEDS MaxAppTotalTxnReferences');
      if ((call.accounts?.length ?? 0) > 4) console.log('     ^^ EXCEEDS MaxAppTxnAccounts');
    }
  });
}

/**
 * Builds the group the middleware would inject and runs it through algod's simulate endpoint.
 * The Deflex swap transactions are not included, so this checks exactly what the middleware
 * owns: references, box names, fees and the tax the contract asks for.
 */
async function simulateGroup(txns: { txn: Transaction }[]) {
  if (txns.length === 0) {
    console.log('  nothing to simulate (asset is not First Stage, or the wallet is exempt)');
    return;
  }

  const atc = new algosdk.AtomicTransactionComposer();
  for (const t of txns) atc.addTransaction({ txn: t.txn, signer: dummySigner });

  const result = await atc.simulate(
    algodClient,
    new algosdk.modelsv2.SimulateRequest({
      txnGroups: [],
      allowEmptySignatures: true,
      fixSigners: true,
      allowUnnamedResources: false,
    })
  );

  const group = result.simulateResponse.txnGroups[0];
  if (group.failureMessage) {
    console.log(`  SIMULATE FAILED at ${group.failedAt}: ${group.failureMessage}`);
  } else {
    console.log('  SIMULATE OK');
  }
}

async function runSwap(label: string, fromASAID: bigint, toASAID: bigint, amount: bigint) {
  console.log(`\n=== ${label} ===`);
  const middleware = new FirstStageMiddleware();
  const suggestedParams = await algodClient.getTransactionParams().do();

  const adjusted = await middleware.adjustQuoteParams({
    fromASAID,
    toASAID,
    amount,
    address: TEST_ADDRESS,
    maxGroupSize: 16,
    type: 'fixed-input',
    algodClient,
  } as never);
  console.log(`  requested ${amount} -> routed ${adjusted.amount}, maxGroupSize ${adjusted.maxGroupSize}`);

  // Stands in for the quote Deflex returns: `amount` is the caller's original request and
  // `quote` is what the router says the other side of the trade is worth.
  const quote = { amount, quote: adjusted.amount, type: 'fixed-input' };

  const context = {
    address: TEST_ADDRESS,
    fromASAID,
    toASAID,
    algodClient,
    signer: dummySigner,
    suggestedParams,
    quote,
  };

  const before = await middleware.beforeSwap(context as never);
  const after = await middleware.afterSwap(context as never);

  console.log(' beforeSwap:');
  inspectTransactions(before);
  console.log(' afterSwap:');
  inspectTransactions(after);
  await simulateGroup([...before, ...after]);
}

/** The tax transfer comes out of the wallet, so keep the test sell within what it holds. */
async function sellableAmount(assetId: bigint): Promise<bigint> {
  try {
    const info = await algodClient.accountAssetInformation(TEST_ADDRESS, Number(assetId)).do();
    const balance = BigInt(info['assetHolding']?.amount ?? 0);
    return balance < 1_000_000_000n ? balance / 2n : 1_000_000_000n;
  } catch {
    return 0n;
  }
}

async function main() {
  console.log(`Testing against ${TEST_ADDRESS}`);
  const middleware = new FirstStageMiddleware();
  console.log('MOOJ asset info:', await middleware.getAssetInfo(MOOJ, algodClient));

  const sellAmount = await sellableAmount(MOOJ);
  if (sellAmount > 0n) {
    await runSwap('sell MOOJ for ALGO', MOOJ, ALGO, sellAmount);
  } else {
    console.log('\n=== sell MOOJ for ALGO === skipped: test wallet holds no MOOJ');
  }
  await runSwap('buy MOOJ with ALGO', ALGO, MOOJ, 10_000_000n);
}

main().catch(console.error);
