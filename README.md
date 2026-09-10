# first-stage-deflex-middleware

**FirstStageMiddleware** is middleware for the Deflex router that enables swaps of First Stage assets on Algorand. It supports buy and sell taxes, and handles both **fixed-input** and **fixed-output** swaps.

---

## Features

- Supports **First Stage assets**.
- Handles **buy and sell taxes** automatically.
- Works with **fixed-input** and **fixed-output** swaps.
- Allows the optional designation of a First-Stage referral address which collects a portion of tax volume.
- Integrates seamlessly with TxnLab's [Deflex](https://github.com/TxnLab/deflex-js) router js SDK.
- Published on npm: [first-stage-deflex-middleware](https://www.npmjs.com/package/first-stage-deflex-middleware)
---

## Installation

```bash
npm install first-stage-deflex-middleware
# or with yarn
yarn add first-stage-deflex-middleware

## Example Usage

```ts
import { DeflexClient } from '@txnlab/deflex'
import { FirstStageMiddleware } from 'first-stage-deflex-middleware'

// Create a Deflex client with FirstStageMiddleware
const deflex = new DeflexClient({
  apiKey: 'YOUR_API_KEY_HERE',
  middleware: [new FirstStageMiddleware('YOUR_REFERRALL_ADDRESS')]
})

// Fetch a quote
const quote = await deflex.newQuote({
  address: 'YOUR_WALLET_ADDRESS',
  fromASAID: 2154668640, // MOOJ
  toASAID: 0,   // ALGO
  amount: 10_000_000_000,     // in base units
  type: 'fixed-input',
  maxGroupSize: 16,
  maxDepth: 4,
  disabledProtocols: [],
  optIn: false,
})

// Execute the swap
const swap = await deflex.newSwap({
  quote,
  address: 'YOUR_WALLET_ADDRESS',
  signer: yourTransactionSigner,
  slippage: 1,
})

const result = await swap.execute()
console.log('Swap confirmed in round', result.confirmedRound)
```

## Notes for integrators

- Build the swap from a quote returned by `newQuote()`, not from a raw `fetchQuote()` response.
  The middleware sizes the tax from the quote's original request amount, which only
  `newQuote()` carries.
- The middleware injects up to six transactions per First Stage asset (asset opt-in, the MBR
  payment and freeze call that create the user box, then `general_operations_top`, the tax
  transfer and `general_operations_bottom`). It reserves those slots by lowering
  `maxGroupSize` on the quote request, so pass the largest `maxGroupSize` you can afford.
- Wallets that are exempt from First Stage taxes are left alone entirely - no tax, no freeze
  and no app calls.
- The middleware talks to the MainNet FirstStage app by default. Pass
  `new FirstStageMiddleware({ referralAddress, appId })` to point it at another deployment;
  the burn wallet, admin account and pool application are read from that app's global state.
- `tests/mainnetMiddlewareTest.ts` builds the injected group against MainNet and runs it
  through algod's simulate endpoint: `npm run test-mainnet` (set `FS_TEST_ADDRESS` to check a
  particular wallet, `FS_TEST_ASSET` to check one asset).
- `tests/testnetBuyTaxTest.ts` (`npm run test-testnet`) covers what MainNet cannot: an asset
  with a buy tax and with a liquidity tax bucket.
