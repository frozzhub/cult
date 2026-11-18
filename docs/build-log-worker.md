# Worker build log (16 Nov 2026, branch kay/launch-prep)

Scope: `src/`, `test/`, `migrations/` (new files only), `wrangler.jsonc`, the pool read and buy quote in `public/app.js`
(plus the "free to join" wording there, per Kay's later message). Nothing deployed, no Cloudflare resources made, no
transaction sent on any cluster. `program-keys/` never read.

## Baseline and result

- Before: `npm test` 45 tests, 35 pass, 10 fail (the review's F1 to F10).
- After: see "Checks" at the bottom.

## Decisions

- **Buy fee is 0 by default** (Kay, 16 Nov, after briefly saying 1%). `BUY_FEE_BPS` (default 0) is only the site's wording;
  the pool account is the truth for the trade. Everything reads it from data: the pool (`/api/pool.buyFeeBps`), the page's
  raw pool read, `/api/state.buyFeeBps`. app.js keeps "Joining is free: no tax on buys." at 0 and shows a percentage only
  when it is above 0. The tick logs a warning if `BUY_FEE_BPS` differs from the pool's own value.
- **Rent for a new holder's USDC account is charged to that holder's own payout** (in `allocate`, from a fresh "who has no
  account" read made seconds before paying), not carved off the swap. So `rent_lamports` on new drops is 0 and the swap
  keeps back only the 0.05 SOL reserve plus transaction fees. The reserve is the float that opens the accounts; the USDC
  taken from the new holder stays in the wallet and goes out next round, and next round's fees refill the SOL.
  A holder whose share after rent is under the minimum is not paid and no account is opened for them.
- **Every payee gets an idempotent "create account" instruction**, not just those flagged at the snapshot.
- **F7 (streak gaming) is deliberately left failing.** The review marks it after launch and a design call for Kay.
  The fix it proposes: a `base` column (lowest balance since `since`), weight = base x multiplier + (balance - base) x 1.
  That changes what "devotion" pays for a bag that grew, so it needs Kay's yes.
- **Tests I had to change in files I didn't write** (no assertion weakened):
  - the D1 name in the `d1 migrations apply` line is now the binding name `DB` (the database is renamed `cult`; the
    binding name never changes), in all four test files that run migrations and in `package.json` `db:local`;
  - `review-money.test.js` and `drop.test.js` now also serve a pool account (new `test/pool-fake.js`) and set
    `POOL_PROGRAM`/`HOOK_PROGRAM` themselves, because the tick now reads the pool to check the payout wallet and
    `wrangler.jsonc` now carries the mainnet program ids;
  - `drop.test.js`: every USDC account exists in its fake (it used to report half missing, and the old maths took their
    rent off the top, so it expected a 30 USDC split that rent charging now shortens; rent is covered by F4 and
    `launch-fixes.test.js`), and its fake answers `getTransaction` (asked before an expired batch is re-sent);
  - `trade.test.js`: the pool account is in the new 125-byte layout with real lamports, and `/api/pool` returns the two
    new fields.
- **F1's premise:** it assumes a 4-minute lock that a slow tick outlives. The lock is now 15 minutes and refreshed, so in
  that test tick B is simply refused the lock and A finishes alone. The test passes for that reason, so
  `launch-fixes.test.js` also covers the cases the old premise was pointing at: a lock really lost (the real clock moves
  16 minutes on), and a run that still holds the lock but finds a batch already claimed.

## Findings

| Finding | Fix | Where |
|---|---|---|
| B3 / F1 overlapping ticks double-pay | Lock 15 min; `fence()` refreshes it (real clock) before every step and every send and the run stops with nothing more written when it was taken; a batch is claimed by `UPDATE ... WHERE status = 'pending'` before it is sent and only the run that changed the row sends; re-arm, confirm and split all name the status and signature they expect; `setDrop` takes a `where` so status changes name the old status; the swap is claimed with `swap_sig IS NULL` | `indexer.js` `tick`, `settleSent`, `paying`, `swap` |
| H3 / F2 landed tx re-sent | `sigStatuses` now answers `processed` separately and it only waits; block height is read before the statuses; an unseen tx waits until the height is 150 past its last valid height, then `getTransaction` (version 1) must also fail to find it; a tx that errored on chain is final; a batch with no `lvbh` waits (no clock); a `getTransaction` error stops the tick. Same for the swap | `chain.js` `sigStatuses`, `txOutcome`; `indexer.js` `settleSent` |
| H1 / F4 rent farming | See decisions: rent comes off the new holder's own share, rounded up, read fresh at allocate | `indexer.js` `allocate` |
| H2 / F3 closed account blocks 7 | Idempotent create for every payee; a batch that fails twice is split into one transaction per holder (new batch numbers, payout rows moved, in one D1 transaction); a single that keeps failing ends `failed` and its USDC rolls over | `chain.js` `buildPayoutTx`; `indexer.js` `splitBatch` |
| H8 / F5 dry-run counted as paid | `live.js` leaves out drops with `swap_sig = 'dry-run'` and batches `dry-run-%` from every paid figure, the members board and a wallet's received total; the practice rounds are listed apart as `dryRuns` in `/api/state` so the operator can still read them | `live.js` |
| H4 / F6 empty snapshot wipes streaks | Empty list always throws; a list under half the last snapshot's holders (when that had 20 or more) throws unless `ALLOW_HOLDER_DROP=1`; the D1 index fallback is used only when the poller has caught up (same test as `HOLDERS=index`) | `indexer.js` `snapshot` |
| H7 / F8 balance reads lag | `getBalance` and `getTokenAccountBalance` pass `commitment: confirmed` | `chain.js` |
| H5 / F9 version-1 stalls the poller | `maxSupportedTransactionVersion: 1` in `pollMint`, `txOutcome` and `test/devnet.live.mjs` | `indexer.js`, `chain.js` |
| H6 / F10 `/api/send` relays anything | Strict allow-list (below); `RL_TRADE` and `RL_READ` rate-limit bindings; `CRON_RPC_URL` for the cron | `trade.js` `checkRelay`; `index.js` `rateLimited`; `chain.js` `cronEnv`; `wrangler.jsonc` |
| H9 / finding 12 payout wallet unchecked | The tick reads the pool and refuses unless `PAYOUT_WALLET` equals the pool's payout field; an unreadable pool or unset `POOL_PROGRAM` also refuses; a pass is remembered in kv (the pool can't change it) | `indexer.js` `payoutProblem` |
| H9 related guard | `weigh` skips off-curve addresses (the pool's vault owner, any program account) | `indexer.js` `weigh` |

### `/api/send` allow-list

One pool buy or sell, and nothing else except: compute-budget limit/price/loaded-data (each at most once), the payer's own
$CULT account create (`Create` or `CreateIdempotent`, exact six accounts), and Lighthouse wallet-guard instructions.
At most 8 instructions, no lookup tables, signed by the payer. The pool instruction must have 24 bytes of data starting
with the `buy` or `sell` discriminator, the payer as account 0 and signer, and all eleven accounts equal to what
`/api/trade` would have built (mint, pool PDA, vault, payer's ATA, the configured payout wallet, Token-2022, ATA program,
system program, hook program, extra-account-metas). `/api/trade` and `checkRelay` share one account list (`tradeKeys`).
Lighthouse is allowed because Phantom adds its assertion instructions to what it signs; they only read accounts. If wallets
turn out not to add them, drop `LIGHTHOUSE` from `checkRelay`.

## Virtual-seed pool and join fee

- `readPool`: parses `virtual_sol` (u64 @115) and `buy_fee_bps` (u16 @123); `rent = lamports - (sol_reserve - virtual_sol)`;
  refuses (throws) when `virtual_sol > sol_reserve` or the account holds fewer lamports than its real reserve. A 115-byte
  pool (the devnet one) reads as virtual 0, buy fee 0.
- Buy quote: `fee = ceil(sol_in x buy_fee_bps / 10,000)` comes off first, the rest goes through the curve on `sol_reserve`
  (virtual included). `/api/pool` returns `virtualSol` and `buyFeeBps`. Client-supplied reserves (CLIENT_RPC) may carry
  `buyFeeBps`; missing means the configured fee, junk means the Worker reads the pool itself.
- `parseTrade`: price = (real SOL after the trade + virtual SOL) / tokens, where real SOL after = lamports - rent. `sol` for a
  buy is what the buyer paid before the fee (net into the pool + the payout wallet's gain); `fee` is recorded for both sides
  in `trades.fee_lamports` (migration `0005_trade_fees.sql`, default 0 for old rows). `poolParams` reads rent and virtual SOL
  once into kv `pool_params`; if the pool can't be read the poll stops rather than record prices without the virtual part.
- Site numbers: join fees are never counted as paid by sellers (the Wall, `sellers.paid_usdc` and "left the cult" only ever
  read sells). They are in the pot: `/api/state` `pending` includes them (since the last real round) and
  `pendingFromJoins` says how much; `totals.joinFeesUsd` is separate; `totals.volumeUsd` counts what traders moved before fees.
- `/api/state` exposes `buyFeeBps` (from `BUY_FEE_BPS`).
- `public/app.js`: raw pool read (offsets 115/123, length-guarded), the buy quote and estimate, the client-read body, and
  the two sentences that said joining is free or that payouts come only from sellers (now conditional on `buyFeeBps > 0`).

## Mainnet config (top level only; `env.devnet` untouched)

`name` and D1 `database_name` are `cult` (id stays the placeholder). Vars: `DEMO "0"`, `JUP_API https://api.jup.ag`,
`MIN_HOLD_USD 50`, `DROP_MINUTES 10`, `DRY_RUN "1"`, `X_HANDLE thecultponzi`, the two program ids, `PAYOUT_WALLET`,
`EXCLUDE` = deployer, `BUY_FEE_BPS "0"`, `MINT` empty. Two rate-limit bindings (`RL_TRADE` 20/min, `RL_READ` 120/min per
caller and endpoint). `DEMO "0"` is safe with no MINT: `/api/state` answers `live: false` and `render()` in app.js
returns before it touches any live-only field (checked by reading, and `/api/state` is tested for that case).

## Left for after launch, or for others

- F7 / A2 streak gaming (design call, above).
- A1 hook bypasses, B1/B2 authorities, L1/L2/L3: programs and scripts, not the Worker. L2 (fund the payout wallet with
  0.06 SOL before the pool is initialised) still belongs in the going-live steps.
- A3: the Jupiter swap transaction is still signed without inspection; DAS paging double count; fee budget.
- An alert when the poll cursor stops moving (H5's last suggestion) is not built.
- A holder who closes their USDC account in the seconds between allocate and the send is still opened at the house's cost
  (about $0.41, once per round per wallet) until the batch lands; the window is one tick.
- README, `docs/LAUNCH-PLAN.md` and `scripts/` still say `paper-hands` for the D1 database and the migration command, and
  `scripts/` may call `getTransaction` with version 0 (not checked: not my paths).

## Checks

- `npm test` (unpiped, exit code read): **93 tests, 92 pass, 1 fail.** The one failure is F7, left on purpose (see decisions).
  F1 to F6 and F8 to F10 pass. By file: `review-money` 10 (9 pass), `launch-fixes` 33, `trade` 22, `drop` 3, `backend` 13,
  `logic` 6, `profile` 6 (counted from the test files; the total is what the gate printed).
- This repo has no `check` or `build` script (`package.json` only has `dev`, `deploy`, `test`, `db:local`, program and devnet
  scripts), so the gate is `npm test` plus `node --check` on every file in `src/`, `test/` and `public/app.js` (all clean).
- Mutation pass in throwaway copies of the tree (never the shared tree): 59 mutations of the guards above, one at a time,
  each against the tests that should notice. First pass: 50 killed, 8 survived, 1 pattern never matched. The survivors were
  test gaps, not code bugs: the "processed" tests let a throwing `getTransaction` fake hide the mutation, the lookup-table
  test was also stopped by the account check, rent deduction and its rounding weren't pinned in a real round, a missing
  `lvbh` and the swap claim weren't tested, and one guard (`accountKeyIndexes[0] !== 0`) was redundant and was deleted.
  After fixing: all 8 re-run mutations killed (plus the fixed pattern).
- In a browser (headless Chrome against `wrangler dev`, demo data): buy dialog at `BUY_FEE_BPS=100` shows "Joining costs 1%:
  0.0200 SOL of what you pay goes to the cult." and the rules read "Joining (buying) costs 1% ..."; at 0 it shows the original
  "Joining is free: no tax on buys." and original rules. The shipped config (`DEMO "0"`, no MINT) renders "Opening soon.",
  no wallet or buy buttons, no console errors.

Not verified: anything on chain (no transaction sent, programs not read or run); real Helius, Jupiter or Cloudflare rate-limit
behaviour (all faked or local); whether Phantom really adds Lighthouse instructions on this flow; the new program's actual
account bytes (the decoder is checked against a layout written from the brief, see the next section); a `wrangler deploy
--dry-run` was not run (it needs account access).

## What the on-chain program must match

1. Pool account layout exactly as briefed (borsh, unaligned): disc 8 | mint @8 | vault @40 | payout @72 | fee_bps u16 @104 |
   sol_reserve u64 @106 | bump u8 @114 | virtual_sol u64 @115 | buy_fee_bps u16 @123; length 125 or more. A shorter account
   (115) reads as virtual 0 and buy fee 0.
2. `pool lamports - rent == sol_reserve - virtual_sol`, always, from the first instruction. The Worker refuses a pool where
   `virtual_sol > sol_reserve` or the lamports are below the real reserve, and so stops quoting and pricing it.
3. A sell that needs more real SOL than `sol_reserve - virtual_sol` must fail cleanly. The Worker quotes sells on the curve
   (virtual included) and does not pre-check this.
4. Buy: `fee = sol_in x buy_fee_bps / 10,000` is paid in lamports to the pool's `payout` account (already account 5 of the
   instruction) in the same transaction; `sol_in - fee` goes into the pool and into `sol_reserve`; tokens out =
   `(sol_in - fee) x token_reserve / (sol_reserve + sol_in - fee)`; `min_out` is checked against that. The Worker quotes the fee
   rounded up; a floor in the program makes the real output at most 1 lamport better, which the 0.1% minimum slippage floor
   covers. The Worker records a buy's size as the pool's gain plus the payout wallet's gain in that transaction, so the fee
   must reach the payout wallet by a lamport balance change in the same transaction.
5. Instruction data stays `discriminator(8) | amount u64 | min_out u64` (24 bytes) for `buy` and `sell`, and the 11 accounts stay
   in this order: user, mint, pool, vault, user ATA (Token-2022), payout, Token-2022, ATA program, System, hook program,
   extra-account-metas. `/api/send` refuses anything else.
6. The pool's `payout` field is `HrEKXpJvACWNxQJgQGhqNmJgQpwgC6kjtPD4dyDK2AH5`; the tick will not run otherwise.
7. Pool creation is not a trade or a sell to the indexer (no SOL leaves the pool, tokens only arrive).
