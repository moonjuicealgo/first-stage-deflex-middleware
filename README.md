# first-stage-deflex-middleware

**FirstStageMiddleware** is middleware for TxnLab's [Haystack Router](https://github.com/TxnLab/haystack-js) router that lets it swap First Stage assets on Algorand. It adds the calls the First Stage contract needs around the swap, pays the asset's buy or sell tax, and handles both **fixed-input** and **fixed-output** swaps.

Published on npm: [first-stage-deflex-middleware](https://www.npmjs.com/package/first-stage-deflex-middleware)

---

## Features

- Swaps any **First Stage asset** through the Haystack router, in either direction.
- Pays **buy and sell taxes** exactly, using the contract's own quote: per-side rates, hook shares and volume-based multipliers included.
- Works with **fixed-input** swaps, and **fixed-output** on sides with no tax. See [Fixed-output swaps](#fixed-output-swaps).
- **`swapTax`** returns the tax on each side of a quote, so a swap page can show what the trade really costs.
- Optionally names a First Stage **referral address**, which earns half the protocol fee on each taxed trade. See [Referral share](#referral-share).
- Reads the deployment it talks to at runtime, so it works **before and after First Stage's contract upgrade** without a change on your side (see below).

---

## Installation

```bash
npm install first-stage-deflex-middleware @txnlab/haystack-router algosdk
# or with yarn
yarn add first-stage-deflex-middleware @txnlab/haystack-router algosdk
```

`@txnlab/haystack-router` (3.0 or later) and `algosdk` (3.x) are peer dependencies.

## Example usage

```ts
import { RouterClient } from '@txnlab/haystack-router'
import { FirstStageMiddleware } from 'first-stage-deflex-middleware'

const firstStage = new FirstStageMiddleware({ referralAddress: 'YOUR_REFERRAL_ADDRESS' })

const router = new RouterClient({
  apiKey: 'YOUR_API_KEY_HERE',
  middleware: [firstStage],
})

// Quote. `address` is required: the middleware sizes its calls and the tax for that wallet.
const quote = await router.newQuote({
  address: 'YOUR_WALLET_ADDRESS',
  fromASAID: 2154668640, // MOOJ
  toASAID: 0, // ALGO
  amount: 10_000_000_000, // base units
  type: 'fixed-input',
})

// What the trade really moves, tax included (see "Showing the tax").
const tax = await firstStage.swapTax(quote, 'YOUR_WALLET_ADDRESS')

// Swap
const swap = await router.newSwap({
  quote,
  address: 'YOUR_WALLET_ADDRESS',
  signer: yourTransactionSigner,
  slippage: 1,
})
const result = await swap.execute()
console.log('Swap confirmed in round', result.confirmedRound)
```

## Showing the tax

`swapTax(quote, address)` returns `{ from, to }`: the tax on each side of the quote, in base units of that side's asset. It is 0 for assets that are not First Stage assets and for tax-exempt wallets.

The middleware already moves the router's request in two of the four cases, so the quote's own figure is the true one there. In the other two, adjust it by the tax:

| Swap | What the quote's `quote` means | What the user really gets or pays |
| --- | --- | --- |
| fixed-input, selling a First Stage asset | output, already net of the sell tax | `quote.quote` |
| fixed-output, buying a First Stage asset | input needed, already covering the buy tax | `quote.quote` |
| fixed-input, buying a First Stage asset | output **before** the buy tax | `quote.quote - tax.to` |
| fixed-output, selling a First Stage asset | input **before** the sell tax | `quote.quote + tax.from` |

## The buy tax buffer

FirstStage taxes a buy on what actually arrives, so if the price improves between the quote and the trade, a tax sized from the quote comes up short and the trade fails with `Insufficient tax payment`. The middleware therefore pays a buy's tax on 0.5% more than the quote. Set `buyTaxBufferBps` to change it.

The contract refunds an overpayment of one whole token or more, in the same call. A smaller one is not refunded, and stays in the contract. On a 3% tax the buffer is at most about 0.015% of the trade. `swapTax` reports the tax without the buffer.

## Fixed-output swaps

Quoting fixed-output works on any token, and `swapTax` reports the tax on it. Building one on a taxed side does not: `beforeSwap` throws. The router sends a slippage buffer on top of a fixed-output swap and takes back what it did not use, and FirstStage refuses a bracket whose tokens both left and came back (`Send or receive in one transfer, not both`), or where more arrived than the tax was sized for (`Insufficient tax payment`).

To let someone type what they want to receive, quote fixed-output, then swap the input it gives as fixed-input. In simulations on MainNet that landed within 0.01% above the amount asked for.

```ts
const estimate = await router.newQuote({ ...params, type: 'fixed-output' })
const tax = await firstStage.swapTax(estimate, address)
const quote = await router.newQuote({ ...params, type: 'fixed-input', amount: estimate.quote + tax.from })
```

## Referral share

The protocol's fee is 5% of the tax (`protocol_fee_bps`), and half of it goes to the referrer a trade names, paid in ALGO inside the trade. On a 3% token that is about 7.5 bps of the trade. No approval is needed. Two conditions:

- **Name the referrer** as the bottom call's last argument, which `referralAddress` does. The zero address, or the trader's own, earns nothing.
- **Let the tax settle.** The fee is what the bottom call swaps through the AMM adapter, so a group that does not name the adapter pays no one. The middleware names it, along with the route the swap needs.

## Notes for integrators

- **Build the swap from `newQuote()`,** not from a raw `fetchQuote()` response. The middleware sizes the tax from the quote's original request amount, which only `newQuote()` carries.
- **Group size.** The middleware adds transactions around the swap and reserves room for them by lowering the quote's `maxGroupSize`, so pass the largest `maxGroupSize` you can (16 is the default). Per First Stage asset in the trade:
  - 3 always: `general_operations_top`, the tax transfer and `general_operations_bottom`;
  - +1 if the wallet has not opted in to the asset;
  - +2 the first time the wallet holds the asset: the payment and call that create its record;
  - +1 if the asset pays a share of its tax to a hook;
  - +2 if the asset settles its tax into another asset (tax mode 2).
- **Exempt wallets** are left alone entirely: no tax, no record, no app calls.
- **Deployment.** The middleware talks to the MainNet First Stage app (`3158291365`) by default. Pass `new FirstStageMiddleware({ referralAddress, appId })` to point it at another deployment. The burn wallet, admin account, pool application and settlement adapter are read from that app.
- **Quoting before a wallet connects.** The tax is quoted by simulating a contract call from `address`, and algod will not simulate a call from the zero address. Use any funded address as a stand-in, such as the MainNet fee sink, and quote again with the user's address before building the swap.

## First Stage's contract upgrade

First Stage is upgrading its MainNet contract so that tax settles inside each trade. The upgraded contract needs a few extra references and, for some assets, an extra transaction or two in the group.

You don't need to do anything. The middleware reads whether the deployment has the new settlement adapter and builds the group that deployment accepts. It caches what it reads for 60 seconds, so a running server switches over within a minute of the upgrade, with no redeploy. Version 2.0.0 is tested against both the current MainNet contract and the upgraded one on TestNet.

## Testing

- `npm run test-mainnet` (`tests/mainnetMiddlewareTest.ts`) builds the group against MainNet and runs it through algod's simulate endpoint. Set `FS_TEST_ADDRESS` to check a particular wallet and `FS_TEST_ASSET` to check one asset.
- `npm run test-testnet` (`tests/testnetBuyTaxTest.ts`) covers what MainNet cannot: an asset with a buy tax and a liquidity tax bucket.
- `tests/testnetRouteTest.ts` runs routes through a given deployment, configured with `FS_TEST_*` environment variables (algod, app, asset, pool, pair, DEX). It is how the upgraded contract was tested, including hooked assets and tax mode 2.
