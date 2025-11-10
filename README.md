# first-stage-deflex-middleware

**FirstStageMiddleware** is middleware for the Deflex router that enables swaps of First Stage assets on Algorand. It supports buy and sell taxes, and handles both **fixed-input** and **fixed-output** swaps.

---

## Features

- Supports **First Stage assets**.
- Handles **buy and sell taxes** automatically.
- Works with **fixed-input** and **fixed-output** swaps.
- Allows the optional designation of a First-Stage referral address which collects a portion of tax volume.
- Integrates seamlessly with Txn lab's [Deflex](https://github.com/TxnLab/deflex-js) router js SDK.

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
