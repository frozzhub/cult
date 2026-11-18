# CULT Worker HTTP contract (curve design, 16 Nov 2026)

What `public/` codes against. Source: `src/index.js` (routes), `src/trade.js` (trading), `src/live.js` (state). Everything is JSON, `cache-control: no-store`. Errors are `{ "error": "<words to show>" }` with a 4xx status; a 429 is the rate limit (`Too many requests. Wait a minute and try again.`, see below); anything unexpected is a 500 with `Something went wrong. Try again.`

Money in this API is raw integers as strings (`"332397766917"`) where it could pass 2^53, USD as plain numbers. The coin has 6 decimals; SOL is lamports.

## The rule behind every number

The mint withholds 10% of every transfer in the account that receives it (the curve's cap; it can never change).
- Tokens arriving in a **wallet** are free: the Worker releases the withheld part back into the same account (the *refund*). Buys and wallet-to-wallet sends net 0%.
- Tokens arriving in a **program-owned account** (any pool's vault) pay the 10%: the Worker sweeps it to the treasury. So every **sell** pays 10%, on the curve, on DAMM v2 after graduation, and on any other pool.
- There is no buy tax, no join fee, no pool program of ours. Jupiter routes the trade, so the same calls work before and after graduation.

## GET /api/state

Same shape as before, with these changes (all other fields are unchanged: `price`, `supply`, `eligibleSupply`, `totals`, `avgDrop24`, `wall`, `members`, `drops`, `decimals`, `profiles`, `nextDropAt`, `dropMinutes`, `minHoldUsd`, `streaks`, `xHandle`, `demo`, `live`, `cluster`, `ticker`, `mint`, `dryRuns`):

| Field | Now |
|---|---|
| `sellTaxBps` | `1000` (from `SELL_TAX_BPS`). The page should show `sellTaxBps / 100` and never hard-code 15 |
| `pool` | **new.** `{ stage, progressBps?, raisedSol?, thresholdSol?, pool? }`. `stage` is `"curve"` (progress to graduation: `progressBps` 0 to 10000, `raisedSol` of `thresholdSol`), `"graduating"` (curve full, waiting for the migration to DAMM v2), `"graduated"`, or `"unknown"` (no read in the last 10 minutes, or no launch yet: show nothing). Read from the cron's last look, never a live RPC |
| `trade` | `true` once `MINT` is set AND `PAYOUT_WALLET` is a valid address (the trade panel can open). While it is `false`, every trading route below answers `Trading opens at launch.` (503) |
| `pending` | USD value of the tax paid by sells since the last round, at the price when each sell happened. No join fees any more |
| `wall.latest[]` | `{ wallet, soldUsd, paidUsdc, at }` as before: `soldUsd` is the gross value sold, `paidUsdc` the USD value of the 10% that was withheld |
| `wall.top[]`, `members[]`, `drops[]` | unchanged |
| `totals.volumeUsd` | gross value of all buys and sells |
| **removed** | `clientRpc`, `buyFeeBps`, `accounts`, `pendingFromJoins`, `totals.joinFeesUsd`. Delete every use: buying is free, there is no client-side RPC and no pool account to read |

Before launch (`MINT` empty) the state is `{ live: false, ... }` with `pool: undefined`.

## GET /api/wallet/:address, GET /api/chart?range=24h|7d|all

Unchanged. The chart's price per trade is the USD price when it was recorded (Jupiter), and the last point is the live price.

## GET /api/quote?side=buy|sell&amount=`<raw>`&slippageBps=`<10..2000, default 100>`

`amount` is raw units of what you give: lamports for a buy, raw coin for a sell. Rate limit: 120 per minute per caller.

```json
{
  "side": "sell",
  "amountIn": "100000000000",
  "outAmount": "2693936",          // what Jupiter pays out (lamports for a sell, raw coin for a buy). The tax is already inside it
  "minOut": "2666996",             // with slippage (Jupiter's otherAmountThreshold, rounded down)
  "slippageBps": 100,
  "priceImpactBps": 49,            // WITHOUT the 10% tax (Jupiter's own figure counts the tax as impact)
  "tax": { "bps": 1000, "amount": "10000000000" },   // a sell: the withheld coin, raw. A buy: { "bps": 0, "amount": "0" }
  "taxUsd": 0.0006,                // sells only, when a price is known
  "route": "Dynamic Bonding Curve"
}
```

For a **buy** the response also has `refund: { amount }` (the tax that comes back to the buyer, estimated as `outAmount x 10 / 90`) and `outAfterRefund` (= `outAmount + refund`): that is what the buyer ends with, and what the page should show as "you get". `minOut` is the floor on the swap itself, before the refund.

Errors: `Pick buy or sell.`, `Enter an amount.`, `There's no route for that amount. Try a smaller one.` (400), `Couldn't get a price just now. Try again in a moment.` (503), `Trading opens at launch.` (503, see `trade` above).

## POST /api/trade

Body `{ "wallet": "<base58>", "side": "buy"|"sell", "amount": "<raw>", "slippageBps": 100, "atomic": true|false? }`. Rate limit: 20 per minute per caller.

Returns the quote fields above (`taxUsd` included, for a sell, when a price is known), except that `refund` is the MODE here and the estimated amount moves to `refundAmount` (a buy only):

```json
{ "transaction": "<base64 versioned transaction>", "refund": "atomic" | "after" | "none", "refundAmount": "111111", "lastValidBlockHeight": 123456789, "outAfterRefund": "...", "...": "the other quote fields" }
```

The wallet signs it and sends it itself (`signAndSendTransaction`, or `signTransaction` and the page's own RPC `sendRawTransaction`). There is no relay: `/api/send` is gone. The transaction is Jupiter's own swap, read instruction by instruction and compiled by the Worker (only expected programs, the wallet is the only signer, SOL wrapped only into the wallet's own account).

`refund` says how a **buy's** tax comes back:
- `"atomic"`: the refund instruction is in the same transaction, already signed by the fee key (`transaction` has two required signatures; the wallet's slot is empty). The buyer ends with the full amount in one transaction.
- `"after"`: a plain swap; the Worker refunds the buyer's account seconds later (the Helius webhook and the cron). Until then a wallet shows about 90% of the coin. This is the default (`ATOMIC_REFUND` is `"0"`).
- `"none"`: a sell (no refund), or a buyer whose token account has a delegate or close authority (those accounts pay the tax, like any program-owned account).

Pass `atomic: true` to ask for an atomic buy, `atomic: false` to force `"after"`. **Whether Phantom (and Solflare, Backpack) keep our co-signature is not proven.** Phantom's docs say it may add Lighthouse guard instructions to a transaction before it is sent, which would change the message after the fee key signed it and fail the send with a signature error. Their docs do not say whether a partially signed transaction is left alone. So the server default is `"after"`. To switch: make one small mainnet buy with `atomic: true` from each wallet; if it lands, set `ATOMIC_REFUND` to `"1"`. The page should treat a signature-verification failure on an atomic buy as "retry with `atomic: false`".

Errors: `Connect your wallet first.`, `Pick buy or sell.`, `Enter an amount.`, `That amount is too small.`, `That route is too big for one transaction. Try a smaller amount.`, `There's no route for that amount. Try a smaller one.` (400), `Couldn't get a price just now. Try again in a moment.` (503), `Couldn't build that trade just now. Try again in a moment.` (503), `Trading opens at launch.` (503, as for the quote).

## GET /api/tx/:signature

`{ "status": "sent" | "confirmed" | "failed" }`. Poll it after sending (every second or two). `sent` covers "not seen yet" and "in a block, not confirmed". Rate limit: 120 per minute per caller. `Trading opens at launch.` (503) while `trade` is `false`.

## POST /api/refund/hint

Body `{ "sig": "<signature>" }`. Call it after a buy confirms (when `refund` was `"after"`), and again until it says `refunded`. The Worker reads that transaction from the chain (the browser's word is only a nudge to look now), queues the token accounts it touched and runs the refund. Same effect as the Helius webhook, so it only matters when the webhook is slow. Returns `{ "queued": 2, "refunded": false }`: `queued` is how many of the transaction's token accounts were looked at, and `refunded` is read from the chain on every call: `true` once none of the wallet-owned accounts it touched holds withheld tokens any more (a pool vault's tax does not count; a read that failed, or a signature the chain does not know yet, is `false`). **To know a buyer's refund landed, call this again every two seconds until `refunded` is `true`, for at most 30 seconds (the limit below is 20 a minute)** (the first call usually answers `false`: the refund is sent after the answer). `/api/wallet/:address` only refreshes once a round, so it is the wrong signal. In the rare delegated-account case the withheld tokens are swept instead of refunded and `refunded` still turns `true`. Errors: `That isn't a signature.` (400, the value is not a base58 signature), `Trading opens at launch.` (503). Rate limit: 20 per minute per caller. Safe to call as often as the limit allows.

## POST /api/hook (Helius, not the page)

Header `authorization: <HELIUS_WEBHOOK_SECRET>`, body an array of enhanced transactions for the mint. Queues touched token accounts, refunds wallet-owned ones right away (after answering), records buys and sells. `503` when no price is known yet so Helius sends it again.

## Profiles

`/api/auth/*`, `/api/me`, `/api/x/*`, `/api/profile/*`: unchanged.

## What the page must change

1. **Trade panel:** drop the pool read, the client-side RPC, the browser quote maths and the `/api/send` call. Quote with `GET /api/quote`, build with `POST /api/trade`, sign and send with the wallet, then poll `/api/tx/:sig` and (for `refund: "after"`) call `/api/refund/hint`.
2. **Copy:** 10% (read `sellTaxBps`), not 15%. Buys are free; say the refund comes back (`outAfterRefund`). Show the sell tax explicitly before a sell: `tax.amount` of the coin, `taxUsd`.
3. **Remove** every use of `clientRpc`, `buyFeeBps`, `accounts`, `pendingFromJoins`, `totals.joinFeesUsd`.
4. **Add** the curve progress from `pool` (progress bar to graduation; `"graduating"` and `"graduated"` states).
5. **Rate limit:** every trading route can answer 429 `Too many requests. Wait a minute and try again.` Trades and refund hints share a bucket of 20 a minute per caller, quotes and status reads one of 120 a minute. Show the words and wait; do not retry in a loop.
6. The mint is Token-2022: wallets that don't show Token-2022 balances correctly will show the net amount until the refund lands.
