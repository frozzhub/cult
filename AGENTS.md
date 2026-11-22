# AGENTS.md

This file is the entry point for an AI agent (or a person in a hurry) analysing this repository. Everything in it was checked against the code. Where the code and a document disagree, the code is right. File and test names are given so you can check each claim yourself.

For the long-form explanation read [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md). For the HTTP contract read [docs/API.md](docs/API.md).

## 1. Orientation

CULT ($CULT) is a Solana memecoin. This repository is its backend and website.

- The token is a Token-2022 mint with a 10% `TransferFee` extension. It launched on a Meteora Dynamic Bonding Curve (DBC) paired with USDC (`QUOTE_MINT` in `wrangler.jsonc`; empty means SOL, which an earlier rehearsal used). At about $28,400 market cap, after about $5,879 USDC has been raised (the curve starts at about $1,935), it graduates into a Meteora DAMM v2 CULT/USDC pool with permanently locked liquidity.
- Buying is meant to cost nothing: the 10% the mint withholds on a buy is released back to the buyer. Selling pays the 10%.
- The sell tax is collected by a single wallet (the payout wallet), sold for USDC on Jupiter, and paid to holders every 10 minutes. Holders who have held longer get a larger weight.
- The curve's trading fees arrive as USDC, straight into the same wallet and so straight into the holder pot. The round does not swap SOL.
- The site's Buy and Sell take and pay SOL. Jupiter routes SOL to USDC to CULT, so the user never needs USDC.
- The Meteora DBC config address is `<USDC DBC config, published at launch>`. It is not created yet.
- The backend is one Cloudflare Worker plus one D1 (SQLite) database. A cron trigger runs it every minute. There is no on-chain program of our own in the live design.
- Site: https://cults.bid. X: @thecultponzi. The mint address is not in this repository. It is published on cults.bid at launch (`MINT` in `wrangler.jsonc` is empty until then).
- The payout wallet is `HrEKXpJvACWNxQJgQGhqNmJgQpwgC6kjtPD4dyDK2AH5` (`PAYOUT_WALLET` in `wrangler.jsonc`).

Things in the tree that are not the live design: `programs/` and `programs-tests/` (an earlier custom pool and transfer hook, in Rust), `scripts/launch.mjs`, `scripts/devnet-*.mjs`, `public/classic/`, `test/programs.e2e.mjs`, `test/devnet.live.mjs`, `spikes/`. The live path is the Worker in `src/` and the Meteora launch scripts `scripts/launch-curve.mjs`, `scripts/create-config.mjs`, `scripts/verify-launch.mjs`.

## 2. File map

### `src/` (the Worker)

| File | Owns |
|---|---|
| `index.js` | Entry point. `fetch` routes `/api/*`, serves static assets, handles per-caller rate limits. `scheduled` runs `tick()` every minute and the X profile sync. Also holds the demo-data generators (`DEMO=1`, or `?demo=1` on devnet only). |
| `indexer.js` | The engine. `tick` (the cron body), the lock and `fence`, `payoutProblem` (start-up refusals), `pollMint` (history poller), `handleWebhook`, `hintSignature`, `recordTrade`, price cache `cachedPrices`, the round steps in `STEPS` (`snapshot`, `sweep`, `swap`, `allocate`, `paying`), the pure helpers `allocate`, `weigh`, `rentMicro`, `splitBatch`. |
| `fees.js` | The refund and sweep engine: `enqueue`, `runFees`, `settleBatches`, `scanWithheld`. State lives in `fee_accounts` and `fee_batches`. |
| `token22.js` | Token-2022 byte parsing (`parseTokenAccount`, `parseMint`), the pure rule `classify` (refund or sweep), instruction builders (`buildFeeTx`, `refundIx`), `feeOn`, `onCurve`, `treasuryAta`. |
| `trades.js` | Reads buys and sells out of transactions (`rpcChanges`, `enhancedChanges`, `readTrade`). |
| `jupiter.js` | Jupiter quotes and swaps. `inspect` (static rules on every swap instruction), `outcomeProblem` (simulate and compare balances), `treasurySwap`, `swapTx`, `impactBps`. |
| `chain.js` | RPC access with failover and backoff, balances, simulation, `sendTx` (with optional rebroadcast), `settleSent` (decides from a signature whether a send landed), `buildPayoutTx`, `payoutKeypair`, `LockLost`. |
| `dbc.js` | Meteora curve (SOL or USDC quoted): `readCurve`, `refreshCurve`, `publicStage`, `poolRefusal`/`poolProblem` (is this pool ours), `migrate` (graduation), `claimFees` (curve trading fees), `claimDammFees` (post-graduation LP fees), `dbcTick`. |
| `damm.js` | Reads and claims the locked DAMM v2 position owned by the payout wallet. |
| `trade.js` | Site trading API: `/api/quote`, `/api/trade`, `/api/tx/:sig`, `/api/refund/hint`. Builds unsigned swap transactions for the user's wallet. Optional atomic refund (`atomicBuy`). |
| `live.js` | Reads D1 into the JSON that `/api/state`, `/api/wallet/:address`, `/api/chart` return. Leaves dry-run rounds out of every paid figure. |
| `profiles.js`, `auth.js` | Optional member profiles: Sign In With Solana, link an X account. Not part of the money path. |
| `config.js` | All settings in one place (`config(env)`), `streakMult`, `dropMs`. |

### Other directories

| Path | What |
|---|---|
| `migrations/` | D1 schema, `0001` to `0007`. |
| `public/` | The site (static). `v2/` is the live front end. |
| `scripts/` | Operator tools. `launch-curve.mjs`, `create-config.mjs`, `verify-launch.mjs`, `migrate-curve.mjs`, `fee-ops.mjs` (manual refund, sweep, claim), `rehearse-curve.mjs`, `watch.mjs` (monitor). `scripts/lib/curve.mjs` holds the curve settings and the on-chain read-back checks. `scripts/test/` has their tests. |
| `test/` | Worker tests (`*.test.js`, run with `node --test`), plus `*.live.mjs` and `programs.e2e.mjs` which need a network or validator and are not part of `npm test`. `test/fixtures/` holds real mainnet account bytes and transactions. |
| `docs/` | `API.md` (the HTTP contract) and `HOW-IT-WORKS.md` (the mechanism). |
| `wrangler.jsonc` | Deployment config and every non-secret setting, with comments. |

### Settings that matter (`wrangler.jsonc` vars, read by `src/config.js`)

`MINT`, `PAYOUT_WALLET`, `CREATOR`, `DBC_CONFIG` (optional), `QUOTE_MINT` (empty = SOL, or the USDC mint), `SELL_TAX_BPS=1000`, `DROP_MINUTES=10`, `MIN_HOLD_USD=50`, `STREAKS=7:1.25,30:1.5`, `EXCLUDE`, `REFUND_DENY`, `REFUND_MIN_USD`, `REFUND_TX_PER_DAY`, `MAX_SWAP_IMPACT_BPS=300`, `SOL_RESERVE_LAMPORTS=1000000000`, `MIN_PAYOUT_USDC=0.01`, `BATCH_SIZE=8`, `SLIPPAGE_BPS=100`, `DRY_RUN` (default on; only `"0"` turns it off), `REFUNDS_DRY_RUN`, `ATOMIC_REFUND`.

Secrets (names only): `PAYOUT_SECRET_KEY`, `SOLANA_RPC_URL`, `CRON_RPC_URL`, `HELIUS_WEBHOOK_SECRET`, `JUP_API_KEY`, `X_CLIENT_ID`, `X_CLIENT_SECRET`.

## 3. Money flows

Every flow below is driven by `tick()` in `src/indexer.js` (once a minute) unless it says otherwise. The cron holds a lock in D1 (`kv` row `lock`, 15 minutes, refreshed by `fence()` before every step and every send).

### 3a. A buy

1. The user's wallet signs a swap built by `POST /api/trade` (`trade.js: route`, which calls `jupiter.swapTx`). Every Jupiter instruction goes through `jupiter.inspect` before the wallet sees it.
2. The swap moves CULT from a pool vault into the buyer's token account. Token-2022 withholds 10% of the transfer inside the buyer's account (the `TransferFeeAmount.withheld` field).
3. Instant path: Helius calls `POST /api/hook`. `indexer.handleWebhook` verifies the `authorization` header, queues the touched accounts (`fees.enqueue`), and `refundNow` runs `fees.runFees` for those accounts after the HTTP response (`ctx.waitUntil`). Fallback paths: the page calls `/api/refund/hint` (`indexer.hintSignature`); the cron's `pollMint` reads the mint's history; `fees.scanWithheld` runs every 30 minutes (`FEE_SCAN_MINUTES`).
4. `runFees` claims the account, reads it fresh from chain, and `token22.classify` returns `refund` for a wallet-owned account. `token22.buildFeeTx` (kind `refund`) builds a withdraw-withheld instruction whose source and destination are the same account, signed by the payout key.
5. The batch row (`fee_batches`) is saved with its signature before the send. `chain.sendTx` sends. `fees.settleBatches` marks it from the signature's status on a later run.

### 3b. A sell

1. Same as a buy, in reverse. The 10% is withheld in the pool vault's token account (a program-owned account).
2. `classify` returns `sweep` for any account whose owner is off the ed25519 curve (a pool vault), a frozen, delegated or close-authority account, a denied owner, or an amount under the dust floor.
3. The cron's `runFees` sweeps vaults at most every 5 minutes per vault (`SWEEP_COOLDOWN_MS`). `buildFeeTx` (kind `sweep`) opens the treasury token account if needed and withdraws every listed account's withheld tokens into it. Withheld tokens held in the mint itself go the same way (kind `mint`).
4. `recordTrade` writes a `trades` row and, for a sell, a `sells` row and updates `sellers` (the Wall).

### 3c. A round (every 10 minutes)

`openNext` inserts a `drops` row with status `snapshot` when a new 10-minute boundary passes. Each tick runs up to six steps on the open round, via `STEPS[status]`:

1. `snapshot`: reads every holder (`chain.tokenHolders`, or the D1 index `token_accounts` if the RPC cannot), refuses an empty list or one that lost more than half the holders, then `weigh` computes weights and writes `holders` and `payouts`.
2. `sweep`: queues the mint and runs `fees.runFees` for kinds `sweep` and `mint` with `force`. Waits while any sweep batch is still `sent`.
3. `swap`: `cultLeg` sells the treasury's CULT for USDC on Jupiter (as much as fits `MAX_SWAP_IMPACT_BPS`). With a SOL-quoted curve a second leg swaps SOL above `SOL_RESERVE_LAMPORTS` (plus fees) to USDC. With a USDC-quoted curve that leg is skipped: the fees already arrive as USDC. Each leg goes through `jupiter.treasurySwap`: `inspect`, then `outcomeProblem` (simulation), then signature, then claim in D1, then send.
4. `allocate`: the pot is the payout wallet's whole USDC balance. `allocate()` splits it by weight, subtracts USDC-account rent from holders who have no USDC account, drops amounts under `MIN_PAYOUT_USDC`, sorts largest first and groups into batches of 8. Writes `payouts` and `batches`.
5. `paying`: for each `pending` batch, `chain.buildPayoutTx` builds one transaction (create-account-if-missing plus `transferChecked` per holder), the batch is claimed (`pending` to `sent` with its signature), then sent. Later ticks settle with `chain.settleSent`.
6. `done` (or `skipped` when nobody is eligible).

### 3d. Graduation and fee income (`dbc.js: dbcTick`, every tick)

1. `refreshCurve` reads pool and config and stores the stage in `kv` (`curve`): `curve`, `graduating` (raised at or over the threshold, not migrated), `graduated`.
2. `migrate`: when the stage is `graduating`, builds the DAMM v2 migration with the SDK, simulates it, saves its signature, then sends. The instruction is permissionless, so someone else may migrate first. Needs `MIGRATE_MIN_LAMPORTS` of SOL in the payout wallet. `AUTO_MIGRATE=0` turns it off.
3. `claimFees` (hourly): moves the partner's trading fees from the curve to the payout wallet. `claimDammFees` (hourly, after graduation): claims the fees of the locked DAMM v2 position that the payout wallet owns. Both are in the quote token, so with USDC they land as USDC. Claims under 0.35 USDC (0.005 SOL for a SOL quote) are skipped, and each is simulated first and must raise the wallet's balance of that token.
4. With USDC, these fees go into the wallet's USDC and are part of the next round's pot. The wallet's SOL is a float for gas, refunds, the migration and new holders' USDC account rent. The operator tops it up by hand: nothing refills it automatically.

## 4. D1 tables and row states

Schema is in `migrations/`. Timestamps are milliseconds. Amounts called "raw" use 6 decimals. The first migration's comments mention an older 15% design and `$PAPER`; the later migrations and the code are current.

| Table | Purpose | Row states and meaning |
|---|---|---|
| `kv` | Key-value: `lock` (tick lock), `price`, `mint` (decimals), `curve` (stage), `curve_pool`, `payout_check` (remembered start-up check), `poll_cursor`, `poll_state`, `fee_scan`, `refund_day` (daily refund count), `migrate`, `claim`, `claim_damm`. | A `migrate` or `claim*` value has `state`: `sent` (signature saved, not settled) or `done`. |
| `drops` | One row per round. | `status`: `snapshot`, `sweep`, `swap`, `allocate`, `paying`, `done`, `skipped` (no eligible holder). `swap_sig` and `cult_sig` hold a transaction signature, or `dry-run` (practice round) or `none` (nothing to sell). `error` holds the last retry reason. |
| `payouts` | Each eligible holder's share in a round. | `weight` set at snapshot. `micro` (USDC, 6 decimals), `batch`, `needs_ata` set at allocate. `micro = 0` means below the minimum, so nothing is paid and it rolls over. |
| `batches` | One payout transaction each. | `pending` (not sent), `sent` (signature saved), `confirmed`, `failed` (5 tries used; USDC stays in the wallet for the next round), `split` (replaced by one batch per holder after 2 failures). |
| `holders` | Latest snapshot. | `since` is when the wallet was first seen holding; `seen` is the last round that saw it. Wallets absent from a snapshot are deleted, so their streak starts again. |
| `sellers` | The Wall. | `last_at` of the last sell. A sell resets the streak (`weigh` uses the later of `since` and `last_at`). |
| `sells`, `trades` | Every buy and sell. | `sells.drop_n` is `NULL` until a round claims it; the pot shown on the site is the tax of unclaimed sells. `trades` keys on the transaction signature, so the webhook and the poller can both record one trade once. |
| `token_accounts` | Holder index built from mint history. | Only newer slots overwrite. Used when the RPC cannot list holders. |
| `fee_accounts` | The refund and sweep queue, one row per token account (the mint's own address stands for tokens withheld in the mint). | `queued`, `claimed` (a run took it), `sent` (a transaction with a saved signature exists), `done`, `skip` (given up after 5 failures for a refund account; revived by the next touch an hour later). `again = 1` means touched while in flight. `solo = 1` means its batch failed whole, so it goes alone. Vaults and the mint are never skipped. |
| `fee_batches` | One refund, sweep or mint transaction each. | `sent`, then `confirmed`, `failed` or `lost` (never seen past its blockhash). `items` records each account and the withheld amount read. |
| `profiles`, `nonces`, `sessions`, `x_oauth` | Member profiles and sign-in. | Not in the money path. `sessions` stores only a hash of the cookie token. |

## 5. Invariants and the tests that prove them

All tests are in `test/` and run offline against a local D1 and a fake chain (`test/engine-fakes.js`, `test/fakes.js`). Some use real mainnet account bytes from `test/fixtures/`. Test names are quoted in part so you can `grep` them.

| Invariant | Enforced in | Test |
|---|---|---|
| The tick does nothing unless `PAYOUT_WALLET` is the mint's withdraw-withheld authority. | `indexer.payoutProblem`, `fees.runFees` | `launch-fixes.test.js` "the tick refuses to run when PAYOUT_WALLET isn't the mint's withdraw-withheld authority"; `fees.test.js` "PAYOUT_WALLET must be the mint's withdraw-withheld authority" |
| The tick refuses a mint whose fee differs from `SELL_TAX_BPS`, or that can still be minted or frozen, or that is unreadable. | `payoutProblem` | `launch-fixes.test.js` "the tick also refuses a mint whose fee isn't SELL_TAX_BPS" and "...can't be read" |
| With `CREATOR` or `DBC_CONFIG` set, a pool made by anyone else is refused and never remembered. | `dbc.poolRefusal`, `poolProblem`, `locate` | `dbc.test.js` "poolRefusal", "poolProblem", "locate: a pool found from the mint is refused..."; `launch-fixes.test.js` "with CREATOR (or DBC_CONFIG) set..." |
| A refund returns exactly the withheld amount to the same account. | `token22.buildFeeTx` | `fees.test.js` "every refund gives the account back exactly what it had withheld"; `token22.test.js` "refund transaction: one self-withdraw per account, signed only by the fee key" |
| Only wallet-owned accounts are refunded. Pool vaults, delegated, close-authority, frozen, denied and dust accounts are swept. | `token22.classify` | `token22.test.js` "classify: ..." (four tests); `fees.test.js` "who is refunded and who pays" |
| The webhook path never touches a vault or the mint. | `fees.runFees` (`opts.only`) | `fees.test.js` "a run given a list of accounts (`only`) takes wallet-owned ones..."; `coldstart.test.js` "the webhook only refunds..." |
| A fee batch is saved with its signature before it is sent; two runs cannot act on one account; a crash at any write or send never causes a double action. | `fees.runFees` claim and batch insert | `fees.test.js` "...saved BEFORE it is sent", "two runs at once: every account is acted on by exactly one of them", "killed at every write and every send: nothing is acted on twice..." |
| An unknown outcome is settled from the signature, never by sending again. A transaction seen in a block is never re-sent. | `chain.settleSent` | `launch-fixes.test.js` "a transaction in a block ('processed') is never sent again...", "an unseen transaction waits out a margin...", "if getTransaction can't answer, nothing is sent again" |
| A payout batch is claimed before it is sent; a run that lost the lock stops; nobody is paid twice. | `STEPS.paying`, `fence` | `launch-fixes.test.js` "a tick that really loses its lock stops, and nobody is paid twice", "a batch another run already claimed is not sent again..."; `review-money.test.js` F1, F2 |
| A swap is saved by signature and claimed in D1 before it is sent, once. | `cultLeg`, `STEPS.swap` | `round.test.js` "a CULT swap another run already claimed is not sent a second time", "a CULT swap saved but never sent...", "a SOL swap saved but never sent..." |
| Every Jupiter instruction is inspected before a key signs: known programs only, one signer, wrapping and account creation only in expected shapes, priority fee under 3,000,000 lamports. | `jupiter.inspect` | `jupiter.test.js` "hostile answers are refused, each for its own reason", "a priority fee over the cap..."; `round.test.js` "SOL leg: Jupiter's swap with an extra System transfer to another wallet is refused" |
| The treasury's swap is simulated and the output account must gain at least the quote's minimum; the input must not fall by more than was sold. | `jupiter.outcomeProblem` | `round.test.js` "CULT leg: a simulation that pays out less than the quote is refused" and the other five "leg:" tests |
| Price impact is measured without the coin's own tax; a sale is cut to fit `MAX_SWAP_IMPACT_BPS`, the rest waits. | `jupiter.impactBps`, `cultLeg` | `jupiter.test.js` "impactBps takes the coin's own tax out..."; `round.test.js` "the impact cap ignores the tax", "over the cap the leg re-quotes a smaller amount..." |
| Tokens withheld in the treasury's own account are never released or sold. | `classify` (`treasury` case) | `review2-fees.test.js` N3 |
| The pot is never exceeded; amounts under the minimum are dropped and roll over. | `indexer.allocate` | `logic.test.js` "allocate never pays more than the pot and drops dust"; `launch-fixes.test.js` "allocate: over 300 random rounds nobody is paid below the minimum or below zero, and the total never beats the pot" |
| A holder without a USDC account pays the rent out of their own share. | `allocate`, `rentMicro` | `launch-fixes.test.js` "allocate: a holder opening a USDC account pays the rent...", "rent in micro-USDC rounds up..." |
| Eligibility: holders under $50 skipped; excluded and off-curve (program-owned) addresses never paid; streak 7 days 1.25x, 30 days 1.5x; a sell resets it. | `indexer.weigh`, `config.streakMult` | `logic.test.js` "weigh applies exclusions, the $50 minimum and streak boosts"; `launch-fixes.test.js` "weigh: an address with no key... is never paid"; `review-money.test.js` F7 |
| A bad holder read (empty, or losing over half the holders) stops the round instead of erasing streaks. | `STEPS.snapshot` | `launch-fixes.test.js` "an empty holder list stops the round...", "a holder list that lost more than half the holders stops the round..." |
| A batch that fails twice is split into one transaction per holder, so one closed account blocks only itself. | `splitBatch` | `launch-fixes.test.js` "a batch that fails twice is split..." |
| Every payee gets a create-account-if-missing instruction first. | `chain.buildPayoutTx` | `launch-fixes.test.js` "every payee gets a 'create account if missing' first..." |
| DRY_RUN reads and plans but signs and sends nothing; practice rounds never count in public figures. | `config.dryRun`, `live.js` | `fees.test.js` "DRY_RUN reads and plans but claims nothing..."; `round.test.js` "in DRY_RUN the sweep step goes on without sending anything"; `launch-fixes.test.js` "a practice round (DRY_RUN) is kept out of every paid figure..." and N10 |
| Sweeps (the sell tax) are never braked; only refunds have the daily cap (`REFUND_TX_PER_DAY`). The sell tax goes first in a run. | `fees.runFees` | `fees.test.js` "N2: sweeps and the mint are never braked...", "N1: the sell tax goes first..." |
| A vault or the mint is never given up on; a refund account is given up after 5 failures and revived an hour later. | `fees.settleBatches`, `enqueue` | `fees.test.js` "N1: a vault and the mint are never given up on...", "five failures give an account up; a touch an hour later revives it" |
| The webhook needs the secret; an empty secret is not a secret. | `indexer.handleWebhook` | `coldstart.test.js` "a deployment with no webhook secret (or an empty one) refuses every hook..."; `drop.test.js` |
| A buy or sell is recorded once even if the webhook and the poller both see it. | `recordTrade` (`INSERT OR IGNORE`) | `launch-fixes.test.js` "the same sell seen by the webhook and by the poller is recorded once" |
| Reading a sell: a wallet puts tokens into a program-owned account. The treasury's own sale is never a sell. | `trades.readTrade` | `logic.test.js` "readTrade ..." (two tests); `trades.test.js` (real DBC and DAMM v2 transactions) |
| Migration runs only when the curve is full, is simulated first, saved by signature before the send, and a sent one is only settled. | `dbc.migrate` | `dbc.test.js` "migration: ..." (six tests), "two migrations at once: one is sent, the other finds it has lost the claim" |
| SDK-built transactions may use only expected programs and signers we hold. | `dbc.sign` | `dbc.test.js` "an SDK transaction with an instruction for a program we don't expect, or a signer we don't hold, is refused..." |
| With no price known the round waits; zero is never stored as a price. | `cachedPrices`, `STEPS.snapshot` | `prices.test.js` "with nothing known and no last good value nothing is stored..."; `coldstart.test.js` "no price yet..." |
| Trade and refund-hint endpoints are rate limited per caller. A missing limiter lets requests through (it protects RPC quota, not money). | `index.rateLimited` | `curve-api.test.js` "rate limits: ..."; `launch-fixes.test.js` "rate limits: ..." |

Not covered by a dedicated test: the `SOL_RESERVE_LAMPORTS` floor on its own (it is exercised through `drop.test.js` and `coldstart.test.js` fixtures), and `payoutKeypair`'s check that the secret key matches `PAYOUT_WALLET` (no test pins that error message; `launch-fixes.test.js` exercises a mismatched wallet through the start-up refusal instead).

## 6. Trust assumptions

### What the hot payout key can do

`PAYOUT_SECRET_KEY` is a Worker secret. The cron signs with it, so it is a hot key held by the deployment (Cloudflare) and available to whoever can deploy or read secrets for this Worker. The key is the payout wallet. It is also:

- the mint's withdraw-withheld authority (it can collect all withheld tokens, from any account, into any token account it chooses);
- the Meteora partner fee claimer (it receives curve trading fees);
- the owner of the permanently locked DAMM v2 position (it receives that position's fees, not the liquidity: the lock is permanent by configuration);
- the holder of the treasury token account, the USDC pot and the SOL float;
- when `ATOMIC_REFUND` is on (it is `0` in `wrangler.jsonc`), the co-signer of a site buy, after `jupiter.inspect` has checked the swap and refused any that mentions the payout wallet (`atomicBuy` in `src/trade.js`).

The code only ever pays holders from this wallet, but nothing on chain forces it to. A holder of the key can move everything the wallet holds at any time, and can reassign the withdraw-withheld authority (Token-2022 lets the current authority set a new one). The Worker's refusal checks stop the Worker from running if the authority changes; they do not stop the key holder.

### What an operator could change

| Operator action | Effect | Visible on chain? |
|---|---|---|
| Edit and deploy the Worker (code or vars) | Anything the code can do, including paying fewer holders, changing `EXCLUDE`, `STREAKS`, `MIN_HOLD_USD`, or leaving `DRY_RUN` on so nothing is paid | Only through its consequences: payout transactions stop or change shape |
| Put addresses in `EXCLUDE` or `REFUND_DENY` | Excluded wallets get no payout; denied wallets are not refunded (their withheld tokens go to the treasury) | Payout and refund transactions omit them |
| Skip or alter a round | Weights and amounts are computed off chain in D1 | Payout transactions show who was paid and how much |
| Move funds out of the payout wallet | Takes the pot, treasury CULT and the SOL float | Yes, as ordinary transfers |
| Run the Worker with its own fee and refund rules disabled | Buys would pay the 10% | Yes: buyer accounts keep withheld tokens |

### What is enforced where

On chain (by the token, curve and DAMM v2 programs, set at launch):

- the 10% transfer fee on every transfer of the coin; the mint has no mint authority and no freeze authority (the Worker refuses to run otherwise, and the launch scripts check it);
- the curve's rules and the DAMM v2 pool's rules, including the permanent lock on the liquidity;
- who may call withdraw-withheld (the payout wallet).

Whether the fee rate can still be changed depends on the mint's `transferFeeConfigAuthority`. The launch scripts expect it to be none and `scripts/verify-launch.mjs` fails if it is not, but the Worker itself does not check it (`parseMint` does not read that field). Check it yourself (section 7).

Off chain (by this code, run by the operator):

- who gets refunded and when;
- which holders are eligible and their weights;
- selling the tax for USDC, and the size and timing of each payout;
- the schedule: if the Worker stops, refunds stop (buyers keep only 90% of what they bought until a refund or the 30-minute scan catches up) and payouts stop.

No audit of this code or of the launch has been done. The tests are the repository's own.

### Known edge cases

- Anyone can harvest withheld tokens from any account into the mint (a permissionless Token-2022 instruction). If that happens to a buyer's account before the refund, the buyer is not refunded and the tokens go to the treasury in the next sweep. `fees.test.js` "someone harvested the buyer's withheld tokens into the mint first..." records this as accepted behaviour.
- Accounts with a delegate or a close authority are swept, not refunded, so they pay the 10% on receipt.
- The treasury's own sale of CULT pays the 10% to the pool vault again. It returns at the next sweep.
- A holder who sells resets their streak; a holder who leaves the snapshot (balance zero) loses `since`.

## 7. Verify the live coin yourself

Use any RPC. Replace `<MINT>` with the address published on cults.bid. All reads below are public.

1. The mint account. Call `getAccountInfo` on `<MINT>` with `"encoding": "jsonParsed"`. Expect:
   - owner is the Token-2022 program (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`);
   - `decimals` 6, `mintAuthority` and `freezeAuthority` null;
   - an extension `transferFeeConfig` with `withdrawWithheldAuthority` equal to the payout wallet above;
   - `transferFeeConfigAuthority` null. If it is not null, the fee rate can be changed by that key. This is the field to check;
   - `olderTransferFee` and `newerTransferFee` each showing `transferFeeBasisPoints` 1000 and a `maximumFee` equal to the u64 maximum (no cap).
   The Worker itself reads `newerTransferFee` (`token22.parseMint`).
2. The pool. The curve pool is derived from the mint and the DBC config. Find it with the Meteora SDK's `getPoolByBaseMint`, or from the pool address shown on cults.bid. Check the pool's `creator` and `config` against what is published, that the config's quote mint is USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`), and that its fee claimer is the payout wallet (`dbc.readCurve` returns `feeClaimer`). After graduation the pool is a DAMM v2 CULT/USDC pool whose position is permanently locked.
3. The payout wallet. Read its balances: SOL (the gas float), USDC token account (classic Token program), CULT token account (Token-2022, `token22.treasuryAta`). Its transaction history on Solscan is the full record of refunds, sweeps, swaps and payouts.
4. A payout round. On cults.bid the drops list shows each round with a transaction link (the first confirmed batch). Open it on Solscan. Expect: one transaction signed only by the payout wallet; for each holder, an optional create-token-account instruction and a USDC `transferChecked` from the payout wallet's USDC account; up to 8 holders per transaction. A round normally has several batches; follow the payout wallet's history around the same time to see the others. Add the amounts to compare with the round's `usdc` total from `GET /api/state`.
5. A refund. Find a buy in the payout wallet's history shortly after it. Expect a transaction with a Token-2022 `withdrawWithheldTokensFromAccounts` instruction whose destination is the same account as the source.
6. A sweep. Expect the same instruction with the treasury token account as destination and several pool-vault accounts as sources, or `withdrawWithheldTokensFromMint`.
7. A sell. On the sell transaction, the pool vault's token account `withheld` field increases by about 10% of the amount sold (read it on an explorer that shows Token-2022 extensions, or via `getAccountInfo` with `jsonParsed`).
8. Round records. `GET /api/state` returns `drops`, `totals`, `pending`, `wall`, `members`. Practice (dry-run) rounds appear only under `dryRuns`.

Not independently verifiable from chain data: the weights. They are a function of the holder snapshot and `holders.since`, which live in D1. You can recompute an approximate weight from balances and sell history, but the exact `since` is the first snapshot that saw the wallet.

## 8. Run the tests

```
npm install
npm test            # node --test "test/*.test.js"
npm run check       # every src and test file parses
node --test scripts/test/*.test.mjs   # the operator scripts' tests
```

The Worker tests use `wrangler`'s `getPlatformProxy` for a local D1 and apply `migrations/` to it. They make no network calls (RPC and Jupiter are faked). Files named `*.live.mjs` and `programs.e2e.mjs` need a network or a validator and are not run by `npm test`. `npm run build:programs` and `test:programs` concern the older Rust programs and need a Rust toolchain.
## 9. Where to look for X

| Question | Look at |
|---|---|
| How is "buy is free, sell is taxed" achieved? | `fees.js`, `token22.js: classify`, `trades.js: readTrade`; `docs/HOW-IT-WORKS.md` |
| Who gets refunded, who pays? | `token22.js: classify` |
| What does a refund or sweep transaction contain? | `token22.js: buildFeeTx` |
| How are holders weighted? | `indexer.js: weigh`, `config.js: streakMult`, `STREAKS` |
| How is the pot split? | `indexer.js: allocate`, `STEPS.allocate` |
| How is the tax turned into USDC? | `indexer.js: cultLeg`, `STEPS.swap`; `jupiter.js: treasurySwap` |
| What stops a hostile swap being signed? | `jupiter.js: inspect`, `outcomeProblem` |
| Why can't a payout be sent twice? | `STEPS.paying`, `chain.settleSent`, `fence` in `tick` |
| What does the Worker refuse to run on? | `indexer.js: payoutProblem`, `dbc.js: poolRefusal` |
| How does graduation work? | `dbc.js: migrate`, `readCurve` |
| Where does the fee income come from? | `dbc.js: claimFees`, `claimDammFees` |
| What does the HTTP API return? | `docs/API.md`, `index.js`, `live.js`, `trade.js` |
| What is stored and in what state? | `migrations/`, section 4 above |
| What can be configured? | `wrangler.jsonc`, `config.js` |
| How was the coin launched and verified? | `scripts/launch-curve.mjs`, `scripts/create-config.mjs`, `scripts/verify-launch.mjs`, `scripts/lib/curve.mjs` |
| How are stuck fees handled by hand? | `scripts/fee-ops.mjs` (dry run by default; `--go` sends) |
| What happens if the RPC fails or throttles? | `chain.js: rpc` (failover and backoff), `CRON_RPC_URL` |
| What happens on a crash mid-round? | `docs/HOW-IT-WORKS.md` "Failure handling", `drops.status`, `batches.status` |
