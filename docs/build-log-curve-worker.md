# Worker build log: curve design (16 Nov 2026, branch kay/launch-prep)

Scope: `src/`, `test/`, `migrations/` (new file only), `wrangler.jsonc`, `package.json`. Not touched: `scripts/`, `spikes/`,
`programs/`, `programs-tests/`, `public/`. Nothing deployed, no Cloudflare resource made, no transaction sent on any
cluster (mainnet simulation only), `program-keys/` never read, no secret read or printed. Spec: `docs/ROUTE-CURVE.md`.
The page's contract: `docs/API.md`.

## 1. Result

Gate, run unpiped with each exit code read, 16 Nov 2026:

| Step | Exit | Result |
|---|---|---|
| `npm run check` | 0 | 36 files parse |
| `npm test` | 1 | 230 tests, 229 pass, 1 fail: **F7** (dust wallet 30 days old gets the 1.5x boost), left failing on purpose, it is Kay's call |
| `npm run build` | 0 | `wrangler deploy --dry-run` bundles (the Meteora SDK is in the bundle, gzip about 399 KiB); `--env staging` dry-runs too |

Tests per file: `token22` 13, `trades` 13, `fees` 36, `jupiter` 7, `dbc` 20, `curve-api` 23, `coldstart` 11, `prices` 6, `poller` 2 (all new,
mine); `round` 30 (the round, ported by a helper agent from the old pool-era file and rewritten around the sweep and CULT-swap
steps, then extended); `drop` 3, `launch-fixes` 34, `review-money` 9 (8 pass, F7 fails), `logic` 6, `backend` 11, `profile` 6 (the earlier
suites, ported off the custom pool, every payout-engine assertion kept). Mutation pass: section 10.

## 2. What changed, file by file

| File | What |
|---|---|
| `src/token22.js` | read a Token-2022 account or mint from raw bytes; `classify` (refund / sweep / none); build refund, sweep and mint-sweep transactions |
| `src/fees.js` | the refund and sweep engine: queue, claim, fresh read, saved batch, settle from the signature; backstop scan |
| `src/trades.js` | buys and sells from real transaction shapes (RPC `jsonParsed` and Helius enhanced), touched token accounts |
| `src/jupiter.js` | quote, swap instructions, inspection before any key signs, compile with lookup tables, simulate-and-compare for the treasury |
| `src/dbc.js` | curve stage, hourly partner-fee claim, migration to DAMM v2 (Meteora DBC SDK 2.0.0) |
| `src/trade.js` | rewritten: `/api/quote`, `/api/trade`, `/api/tx/:sig`, `/api/refund/hint` |
| `src/indexer.js` | webhook, poller, prices (Jupiter), the round: snapshot, sweep, swap (CULT leg, then SOL leg), allocate, paying |
| `src/chain.js` | `getAccounts`, `simulate`, `settleSent` moved here, `LockLost`; `buildSwap` removed |
| `src/config.js`, `src/index.js`, `src/live.js` | new vars, new routes and rate limits, state without pool-era fields, stats from the new tables |
| `migrations/0006_curve_fees.sql` | tax in tokens on `sells` and `trades`, `drops` CULT swap leg, `fee_accounts`, `fee_batches` |
| `wrangler.jsonc`, `package.json` | new vars, `env.staging`, SDK dependency, `check` and `build` scripts |
| `test/jupiter.live.mjs`, `test/refund-sim.live.mjs` | the two mainnet SIMULATION probes (not in `npm test`; they send nothing) |

Removed: `readPool`, pool parsing, `virtual_sol`, the payout-versus-pool check, `/api/send` and its allow-list, `CLIENT_RPC`,
`POOL_PROGRAM`, `HOOK_PROGRAM`, `buildSwap`, `env.devnet` (it pointed at the dead custom pool), `test/trade.test.js` and
`test/pool-fake.js`. `test/devnet.live.mjs` and `test/programs.e2e.mjs` still target the dead pool programs; they are not run by
`npm test` and are left for the lead to delete with `programs/`.

Kept untouched in behaviour (each was paid for by an incident): the tick lock and its fence, the claim-before-send batches,
signature saved before send, settle only from the signature's status (with history, past the blockhash plus a margin),
re-send rules, rent charged to the holder, batch splitting, snapshot guards, dry-run separation, confirmed commitment,
`maxSupportedTransactionVersion: 1` on every `getTransaction`, the separate `CRON_RPC_URL`, the rate limits.

## 3. The refund and sweep engine (item 3)

**Finding accounts: webhook and poller queue, plus a full scan backstop.** Chosen because a transfer is always seen by one of
three readers and none of them has to be right alone: the Helius enhanced webhook (seconds), the RPC poller of the mint's
recent signatures (every minute), and `getProgramAccounts` on the Token-2022 program filtered by the mint at offset 0, every
`FEE_SCAN_MINUTES` (30), which finds whatever was missed (a dropped webhook, a restart, someone else's harvest). The scan was
tested on the public RPC; if an RPC refuses it, the accounts our own poller indexed (`token_accounts`) are read instead and the
scan says which source it used. The scan also queues the mint itself when `WithdrawWithheldTokensFromMint` has something to take.
Helius `getTokenAccounts` was not relied on: whether it exposes the withheld amount is unverified.

**Classification, always from a fresh read of the account (never from the queue row):**

| Account | Action | Why |
|---|---|---|
| gone, other mint, nothing withheld | none | done, not an error |
| the treasury token account, or owned by the payout wallet | none | our own money |
| owner in `REFUND_DENY` | sweep | operator's list |
| frozen | sweep | a refund into a frozen account would fail |
| owner off the ed25519 curve (pool vaults, any program) | sweep | the 10% on sells |
| delegate set, or close authority set | sweep | the holder (or a program) could move or close it after the refund |
| withheld < `REFUND_MIN_TOKENS` (default 100,000 raw = 0.1 token) | sweep | dust cannot be farmed for our fees |
| otherwise (on-curve owner, no delegate, no close authority) | **refund** | `WithdrawWithheldTokensFromAccounts`, source = destination = the same account; Token-2022 credits it fee-free |

**State machine (`fee_accounts`, `fee_batches`).** `queued -> claimed -> sent -> done | queued | skip`.
1. `claim`: a conditional `UPDATE ... WHERE state = 'queued'` per account; only rows whose update changed one row are ours.
2. Read the mint and the accounts fresh. The mint's withdraw authority must equal `PAYOUT_WALLET`, or everything is released and the run reports `blocked`.
3. Plan; accounts with nothing to do go to `done` (or back to `queued` when they were touched while we read: the `again` flag).
4. Build the transaction, compute its signature, then ONE D1 batch: insert the `fee_batches` row (only `WHERE` the count of still-claimed rows of this run equals the batch size) and move those rows to `sent`. If the claim was lost the row is not inserted, and the run sends nothing.
5. Send. A failed send is only logged; the outcome is settled from the signature next run.
6. `settleBatches`: signature status searched with history, `lastValidBlockHeight` plus a margin, then `getTransaction`. `confirmed` -> rows `done` (or `queued` if `again`), with a cooldown; `failed` or `lost` -> `tries + 1`, backoff `30 s x 2^tries` capped at 15 min, five tries then `skip`; a skipped row revives after an hour of silence when touched again. Never by resending, never from a balance.
7. A claim whose run died before step 4 is released after 120 s (`STALE_CLAIM_MS`); every run releases its own unsaved claims in `finally`.

Exactly once: a batch row exists only when every account of it was claimed by that run; an account in `sent` is in exactly one
`fee_batches` row; a second run cannot claim a `claimed` or `sent` row; and a refund that does land makes the next fresh read
show `withheld = 0`, so a second send (which cannot happen) would also be a no-op. Day brake `FEE_TX_PER_DAY` (5000) and
12 transactions per run keep a bug from spending the wallet.

**Paths.** Webhook and `/api/refund/hint`: queue, then refund wallet-owned accounts right away (after the response, via
`ctx.waitUntil`); this path never takes vaults or the mint. Cron every minute: refunds, sweeps (5-minute cooldown per account,
because every trade touches the vault), mint sweeps. The round's `sweep` step runs sweeps and the mint sweep with `force`
(ignoring the cooldown) and waits for any sweep batch still in flight before it moves on.

**Dry run.** `DRY_RUN` stops refunds, sweeps and mint sweeps (they read, classify and report; nothing is claimed or sent).
`REFUNDS_DRY_RUN` `"0"` lets refunds go live while the rest stays dry; `"1"` forces refunds dry.

**Abuse analysis.**
- Delegate set after a refund: a refund is a single instruction in a single transaction; whatever a delegate does afterwards
  concerns tokens the holder already owns. Delegated accounts are swept, not refunded, so approving a delegate first gains nothing.
- Dust: below `REFUND_MIN_TOKENS` the withheld part is swept, so splitting a buy into thousands of tiny transfers costs us
  nothing in refund fees. A refund transaction costs about 5,000 lamports plus the priority fee per 18 accounts.
- Close authority or freeze: swept, never refunded.
- Harvest-to-mint-before-refund (anyone may `HarvestWithheldTokensToMint` on accounts, moving withheld tokens to the mint
  before we refund): **accepted and logged.** The buyer then gets no self-refund for that transfer; the tokens sit in the mint
  and the mint sweep sends them to the treasury. It costs the harvester gas and gains them nothing, but it does cost the buyer
  10% of that buy. It needs a third party to spend SOL for no profit; we cannot stop it (the instruction is permissionless) and
  the scan finds the mint balance within `FEE_SCAN_MINUTES`.
- Treasury and `REFUND_DENY` owners are never refunded.

## 4. Trading for the site (item 4)

Contract in `docs/API.md`. Everything Jupiter hands back is read instruction by instruction (`jupiter.inspect`) and compiled by
us; we never sign or forward Jupiter's own serialised transaction. Allowed: compute budget (priority fee capped at 3,000,000
lamports), account creation for the user's own accounts of the two mints, a System transfer from the user into the user's own
wrapped-SOL account no larger than the sale plus rent, wrapped-SOL sync and close-to-user, and exactly one Jupiter program
instruction. Only the user may sign. A key we keep out of swaps (the fee key, when it co-signs a refund) may not appear in
any of Jupiter's instructions.

**Buys with the refund in the same transaction ("atomic").** The Worker builds the plain swap, appends the refund instruction
for the buyer's own token account (authority = the fee key) and signs it with the fee key; the buyer's signature slot stays
empty. The fee key signs the whole message, so any change to the message after our signature breaks it.

**Phantom (answer to item 4): NOT proven, default is `"after"`.** Phantom's documentation says it may add Lighthouse guard
instructions to a transaction before it is sent; that changes the message after the fee key signed it, and the network
rejects the send with a signature error. The documentation does not say whether a transaction that already carries a partial
signature is left alone, and I could not test a real wallet (no wallet here, and nothing may be sent). So `ATOMIC_REFUND` is
`"0"`: a buy is a plain swap and the engine refunds the buyer within seconds ("after"). The API accepts `atomic: true` per
trade so one small mainnet buy from each wallet (Phantom, Solflare, Backpack) can prove it; if a send fails with a signature
error the page retries with `atomic: false`. What IS proven: the atomic transaction is valid and ends with the buyer holding the
whole amount (mainnet simulation, section 7).

Fallback behaviour: atomic that cannot be built (no key, Jupiter's instructions mention the fee key, it does not fit in 1,232
bytes) falls back to the plain swap with `refund: "after"`. A buyer whose token account has a delegate or close authority
(or is on `REFUND_DENY`) gets the plain swap and `refund: "none"`: that account pays the tax like any program-owned account.

Knowing the refund landed: `POST /api/refund/hint` answers `{ queued, refunded }`, and `refunded` is read from the chain on every call
(true when none of the wallet-owned accounts the transaction touched holds withheld tokens; a failed read or an unknown signature
is false). The page polls it every two seconds for up to 30 seconds. `/api/wallet` only refreshes once a round.

Tax arithmetic: Jupiter's `priceImpactPct` counts the 10% as impact; `impactBps` takes it out
(`1 - (1 - j) / (1 - tax)`), so a 100,000-token sell that shows 10.44% from Jupiter reports 49 bps of real impact. A buy's
expected refund is `out x 10 / 90` (the net of a 10% fee is 90% of the gross).

## 5. Sell and buy detection (item 5)

`trades.readTrade` works from per-owner net balance changes of the mint in one transaction: wallets are on-curve owners, the
program side is everything else. A sell is a wallet losing and the program side gaining (gross = the wallet's loss, withheld =
gross minus what the program side received, else the 10% rounded up). A buy is the program side losing and a wallet gaining
(withheld = gross minus what the wallet received, 0 when the same transaction already refunded it). The payout wallet is never
a trader (its own swap would land on the Wall). Reads both RPC `jsonParsed` and Helius enhanced shapes; deduplicated by
signature (`recordTrade` returns false for one we already have, so a Helius retry never counts twice). With no price known,
nothing is recorded and the cursor stays (the webhook answers 503 so Helius sends it again); refunds do not wait for the price.

Real fixtures (`test/fixtures/raw-txs.json`, `accounts.json`) are the two test tokens' mainnet transactions and accounts. The
DBC buy reads gross 332,397,766,917 with 33,239,776,692 withheld; the DBC sell reads 16,619,888,346 withheld, which is the
vault's on-chain withheld amount to the unit.

## 6. The round (item 6) and prices (item 2)

`snapshot -> sweep -> swap -> allocate -> paying`, one step per pass, the tick lock fenced before each.
- `sweep` takes the withheld tokens into the treasury (section 3) and waits for batches in flight.
- `swap` has two legs. The CULT leg sells the treasury's CULT for USDC through Jupiter, signed by the payout key only after
  `inspect` and a simulation whose outcome is compared with the quote (the output account must gain at least the quoted
  minimum, the input account must lose at most what is sold). It sizes each sale from the quote so price impact without the
  tax stays under `MAX_SWAP_IMPACT_BPS` (300), with a 0.9 margin, sells only what fits (the rest waits for the next round),
  and does nothing under `MIN_SWAP_USD` (1). Its signature, last valid height, amount and result are saved in the `drops` row
  before the send (`cult_sig`, `cult_lvbh`, `cult_amount`, `cult_out`). The SOL leg (spare SOL above the reserve to USDC) is the
  earlier logic on the same helper.
- `allocate` and `paying` are the earlier engine.
- Prices: Jupiter price API (`JUP_API` plus `x-api-key`), 60 s cache, last good value kept per field on failure, never 0 into
  a snapshot (unknown price means the round waits). If Jupiter lacks the coin the curve's own price (read from the pool, kept
  in kv) is used with the Jupiter SOL price.

## 7. Evidence from the real chain, and what is only faked

**Mainnet simulations (nothing sent), on the two throwaway test tokens, `test/refund-sim.live.mjs` and `test/jupiter.live.mjs`:**

| Transaction | Result |
|---|---|
| refund x1 on a real buyer's account | ok, 2,446 units, 294 bytes; 373,397,962,844 + 24,910,216,208 withheld -> 398,308,179,052, withheld 0, exactly refunded |
| refund x18, x23 (same account repeated, so small) | ok, 38,928 and 49,658 units |
| sweep x1 on the real DBC vault | ok, 21,302 units, 400 bytes; vault withheld 16,619,888,346 -> 0, treasury +16,619,888,346 exactly (the treasury account is created in the same transaction) |
| mint sweep, nothing in the mint | ok, 20,880 units |
| atomic buy: real Jupiter instructions, refund appended, fee key as co-signer | ok, 929 bytes, 2 required signatures, 65,605 units; buyer's account 166,198,883,459 -> 199,436,616,675 with withheld 0 (the plain swap leaves 3,323,773,322 withheld, which the refund engine returns) |

Real Jupiter answers (lite API, no key) pass `inspect`; real SDK reads of the mainnet DBC pool and config give the stage,
progress, price and partner fee. Measured transaction sizes: a refund batch of 23 distinct accounts is 1,218 bytes (limit 1,232),
24 would be 1,260, so `FEE_BATCH` is capped at 23 (default 18). Compute-unit limits are set at about 2.4 times what simulation
used (refund 5,000 + 5,000 per account, sweep and mint 30,000 + 3,000 per account).

**Faked, and what that means:**
- The Helius enhanced payload is hand-written from Helius's documented shape; no real Helius payload was available. Real ones
  are parsed by `enhancedChanges`; a field that differs would show up as trades not recorded (the RPC poller still records them).
- Migration and the fee claim are tested against a fake SDK client plus REAL SDK state reads; no migration was simulated
  against a real graduating pool (none exists on mainnet for our config), and no claim was simulated against a real partner
  fee balance beyond reading it.
- The withdraw from a DAMM v2 vault after graduation was not simulated (no graduated pool with a transfer-fee mint to point at).
- The treasury CULT sale was not simulated on mainnet (the treasury holds none).
- Refunds and sweeps were simulated on mainnet but never sent.
- Phantom, Solflare and Backpack were not run.

## 8. Items 7 and 8

**Item 7, claiming the fees.** The curve's partner trading fee (SOL) is claimed by the Worker hourly (`CLAIM_MINUTES`) with the
SDK's `partner.claimPartnerTradingFeeToReceiver`, receiver = the payout wallet, only above 0.005 SOL, only after the
transaction was simulated and shown to raise the payout wallet's SOL, saved by signature before the send, settled from the
signature. Dry run claims nothing. After graduation the partner's share of the locked DAMM v2 position's fees is claimed through
the DAMM v2 SDK (cp-amm), which this Worker does not contain: **left as a script hook** (it needs the position address, which the
migration saves in kv `migrate` as `first` and `second`; `scripts/fee-ops.mjs` is the place). Not done in the Worker.

**Item 8, graduation.**
- Meteora's keeper only migrates listed thresholds (10 SOL for a SOL quote); ours is about 86 SOL, so we migrate ourselves.
  The instruction is permissionless. `dbc.migrate` calls the SDK's `migrateToDammV2` with the Customizable DAMM v2 config
  (`DAMM_V2_MIGRATION_FEE_ADDRESS[6]`), checks that it only uses expected programs and needs no signers we do not hold,
  simulates it (a failing migration is never sent), then saves the signature, last valid height and the two new position-NFT
  keypairs' public keys in kv BEFORE the send; a second run only settles it; failed or lost builds a new one. `AUTO_MIGRATE`
  `"0"` stops it and leaves it for the operator script (`scripts/migrate-curve.mjs`); the payout wallet needs about 0.15 SOL.
  Whoever migrates first wins; if the keeper (or anyone) does it, the stage reads `graduated` and the Worker stops trying.
- `MigratedTransferFeeAuthorityOption.Immutable` does **not** remove the withdraw-withheld authority. Only the config
  authority (who can change the rate) is dropped and the rate frozen; the withdraw authority stays with the partner (the fee
  key). Evidence is file:line in `docs/build-log-curve-scripts.md` section 1 (Token-2022 `processor.rs:889-903`, DBC
  `migrate_damm_v2_initialize_pool.rs:362-376` and `:405`) and my own reading of the same source agrees. This is source
  reading, not an observed migration: no mint of ours has graduated. What the chain does show: the real DBC test mint
  (`test/fixtures/accounts.json`) has withdraw authority = the partner/fee key and a 1000 bps fee before graduation.
  The tick refuses to start unless the mint's withdraw authority is `PAYOUT_WALLET` (`payoutProblem`, remembered per
  mint and wallet), and every fee-engine run re-reads the mint and releases everything with `blocked` if the authority is
  not the payout wallet, so if graduation ever did change it, refunds and sweeps would stop rather than fail in the open.
- After graduation Jupiter routes to the DAMM v2 pool; the Worker has no pool code. DAMM v2's vaults are program-owned, so
  sells into them are swept like the curve's.

## 9. Bugs the tests found while writing them (all fixed)

- `AUTO_MIGRATE=0` was not honoured in `migrate` (the dbc test found it).
- `/api/trade` answered `refund` twice (mode and amount); the object spread let the quote's amount replace the mode, so a
  buy always reported `{ amount }` instead of `"after"` or `"atomic"`. The amount now travels as `refundAmount`.
- Jupiter's real "no route" answer reads "Could not find any route", which the plain-words mapping missed; it showed a
  generic 503 instead of "no route, try a smaller amount".
- web3.js throws a `RangeError` past 1,232 bytes instead of returning a size, so the "doesn't fit" message never appeared and
  the user saw "couldn't build that trade". `compile` now catches it.
- The mint-account test fake wrote its TLV at the wrong offset; the real layout (fee bps at data offset 106) is pinned by the
  real fixture.
- 24 refunds in one transaction is 1,260 bytes: the batch cap is 23.
- Found while checking the cold start: the SOL leg of every round sells all SOL above `SOL_RESERVE_LAMPORTS` (0.05 SOL), which would
  have sold the 0.15 SOL the migration needs and left it waiting for the next fee claim. The file now reserves 0.2 SOL.
- Found while answering whether MINT alone is enough: the curve stage, the migration, the fee claim and (through the curve
  price) the first round needed `DBC_CONFIG`. The pool is now found from the chain by its base mint.
- The demo data still computed the Wall at 15% (the old pool); it follows `sellTaxBps` now.

## 10. Mutation pass

Method: a copy of the tree (never the shared one) with `node_modules` junctioned; each guard is replaced by a mutant (an exact
string, checked to occur exactly once), the test files aimed at that guard run, and a mutant that leaves them green
"survives". 192 mutants: `fees.js` 41 (claim, batch save, lost claim, settle, backoff, brakes, dry-run kinds, scan),
`token22.js` 15 (every `classify` branch, the treasury account create), `trades.js` 8, `jupiter.js` 30 (every `inspect` rule, the
outcome check, size), `trade.js` 20 (HTTP guards), `dbc.js` 28 (SDK transaction check, fences, saved-before-sent, discovery,
claim and migration guards), `indexer.js` 48 (prices, hook, poller, payout check, sweep step, CULT leg, refund hint) and
`index.js` 2 (demo tax).

**Result: 188 killed, 4 survivors, all equivalent.** It took three rounds, and the first of each was not clean:
- First pass on `fees`, `token22`, `trades`, `jupiter`, `trade`, `dbc` (135 mutants): 84 killed, 51 survived. The survivors were real
  gaps, not noise: a test that checked only the reason string while another guard refused the same input (`classify(null)`, "another
  signer"); a fake chain that returned live bytes so a stalled run saw fresh data and the lost-claim guard was never reached; no
  interleaving where a run's list of due rows goes stale, where it loses only some of its claims, where a fresh claim is
  not yet stale, or where two runs settle one landed batch; the `again` flag, the 5-minute vault cooldown, `force` and the
  "not live in this pass" release were all unpinned; outcome checks of the treasury swap were only reached through a test file
  the mutant run had left out; the wrap cap, the 2^62 limit, the deny list for a buyer with no account, the SDK program and signer
  checks, fences and the migration claim race had no test. About 35 tests were added (mostly in `fees`, `jupiter`, `dbc`,
  `curve-api`, `trades`, `token22`). Second pass on the 51: 49 killed.
- First pass on `indexer.js` (41 mutants): every one looked killed, because the run included `review-money.test.js`, whose known F7
  failure turned every mutant red. Mutants whose only failing test was F7 were discounted and rerun without that file: 22 survived
  (price cache, last-good values, curve fallback, zero never stored, hook secret, refund-now dry and kinds, sweep `force` and mint,
  the CULT leg's price, zero and minimum guards, the signature-claim race, the poller's failed signatures). `prices.test.js`,
  `poller.test.js`, `coldstart.test.js` and six tests in `round.test.js` were written for them; all killed except two (below).
- New guards of the last changes (pool discovery, `refunded`, demo tax, the migration reserve's twin, treasury account create,
  unknown-price caching): 15 mutants, all killed after one more test (`SELL_TAX_BPS` 0 in the demo).

**The 4 survivors, and why they are equivalent:**
- `fees-save-before-send-order`: my mutant threw inside the same `try` that swallows send errors, so it changed nothing. The real
  "send before saving" mutant (`fees-send-first`) is killed.
- `dbc-settle-done`: drops `state !== "sent"` from `settleKey`; both callers already return before reaching it unless the state is
  `sent`.
- `idx-sweep-dry`: runs the sweep step's work in a dry run; `runFees` is itself dry-aware (reads, plans, sends nothing), so the
  outcome is the same.
- `idx-record-dedupe`: drops the "already have this trade" return in `recordTrade`; the `sells` insert right after is
  `INSERT OR IGNORE` on the same signature and returns false, and a buy returns false on its side.

Limits: the kill rounds ran against the tests as they stood at that round; the three guards of `cachedPrices` killed before its
last edit (unknown-token stamp) are still present in the edited line. Mutants were string replacements, not a mutation tool, so
a guard I did not think to mutate was not tried.

## 11. Launch state: a brand-new deployment pays for real from round 1

Decision (Kay, via the coordinator): no practice rounds. Refunds and payouts are live from the first round; the `DRY_RUN` and
`REFUNDS_DRY_RUN` switches stay for staging and emergencies. `test/coldstart.test.js` (10 tests), `test/prices.test.js` (5) and
`test/poller.test.js` (2) pin the cold start, on the same local-D1 + fake-chain harness as the round tests.

**State the production deploy must be in (nothing else needs priming):**

| What | Value |
|---|---|
| D1 | created, `wrangler d1 migrations apply` run (all six migrations); no seed rows, no snapshot, no price, nothing |
| `MINT` | the coin's mint. Setting it and deploying is all the launch needs: the pool and its config are found from the chain (`getPoolByBaseMint`, remembered in kv `curve_pool`), and the vaults, buyers' accounts and holders are found by scanning the mint's token accounts. `DBC_CONFIG` is optional now |
| `PAYOUT_WALLET` | the DBC fee claimer = the mint's withdraw-withheld authority (the tick and every fee run refuse otherwise) |
| `DRY_RUN` | **`"0"`**. The file ships `"1"` as the safe default; the launch deploy must set `"0"` |
| `REFUNDS_DRY_RUN` | unset or `"0"` (unset follows `DRY_RUN`). Never `"1"` |
| `EXCLUDE` | empty, which is what the file has. Nothing in the code excludes the pool creator or a bundle wallet (`weigh` skips only the payout wallet, `EXCLUDE` and off-curve owners); a test pins it |
| `SOL_RESERVE_LAMPORTS` | `"200000000"` in the file (0.05 SOL for fees and holders' account rent plus the 0.15 SOL the migration needs). The SOL leg of each round sells only SOL above it, so a round can never starve the migration. The code default stays 0.05 SOL; tests pin their own value |
| Secrets | `SOLANA_RPC_URL`, `PAYOUT_SECRET_KEY`, `HELIUS_WEBHOOK_SECRET`, `JUP_API_KEY` (and optional `CRON_RPC_URL`, `X_CLIENT_ID`, `X_CLIENT_SECRET`) |
| Payout wallet | at least 0.2 SOL. It needs no CULT and no USDC account |
| Helius | an enhanced webhook on the mint, pointed at `/api/hook` with `authorization: <HELIUS_WEBHOOK_SECRET>`. Not a Worker var; created after MINT is known |

**First-run edge cases, and what the code does (each has a test):**

| Edge case | Behaviour |
|---|---|
| Webhook arrives before the first cron tick | Works on an empty D1: the touched accounts are queued, wallet-owned ones are refunded at once (no price, no snapshot needed), trades are recorded when a price exists. A hook with no price answers 503 (Helius resends) and refunds anyway; the resend records the trade once and sends no second refund. A deployment with no secret, or an empty one, refuses every hook |
| Buys and sells from before the deploy (launch to deploy gap) | The first tick runs the backstop scan (every token account of the mint with withheld tokens) and the poller reads the mint's history oldest first: buyers are refunded, the vault is swept, trades recorded, in the first tick |
| Webhook before the first tick, a delegated buyer's account | Not touched by the webhook (it only refunds); the cron sweeps it |
| No previous snapshot | The holder-drop guard (more than half the holders lost) needs 20 or more earlier holders, so round 1 has no baseline to trip it; a lone holder is a valid round; an empty list is refused and retried |
| No price yet | Jupiter often has no price for a brand-new coin. The price falls back to the curve's own price (SOL per coin times SOL's USD price) from the cron's read, valid for 10 minutes. With neither, the snapshot step stops with `No $CULT price yet. Retrying next tick.`, no swap is priced or sent and nobody is counted. The tax is still swept into the treasury meanwhile (it needs no price and keeps the money ours). The round goes on at the first tick that sees a price |
| Treasury token account not created | The first sweep creates it (idempotent create in the same transaction). Reading its balance before that is 0, not an error |
| Payout wallet's USDC account not created | The CULT sale (Jupiter's setup instructions, which `inspect` allows for the wallet's own account) opens it. A round with nothing sold reads the pot as 0 |
| First sweep with nothing to sweep | The round finishes `done` with 0 holders and 0 USDC, no transaction, no account created, no error; the next round the same |
| New holders have no USDC account | Each pays the rent of opening theirs out of their own share (what stays in the wallet), exactly as before |
| Round timing | Tick 1: payout check, prices, poll, scan, refunds, sweep, snapshot, CULT sale, allocation, payout batches sent. Tick 2 (a minute later) confirms them: `done`. A round whose sweep or sale is still landing holds at that step and goes on at the next tick |

One thing to know: the first snapshot gives every holder `since = now`, so holders from before the deploy start their streak
at the first round, not at their first buy.

## 12. Deploying a staging Worker (`wrangler deploy --env staging`)

Nothing here was done by me. Hosting (from the coordinator): the Workers deploy to Cloudflare account
`c86a724ee0e65237b18c5061a5ab47a4` (frz's; it also holds the domain cults.bid). `wrangler.jsonc` pins that `account_id`. cults.bid
stays dark until Kay says: `env.staging` has `workers_dev: true` and no route, and the top-level config has no `routes` (a
comment says where they go later). The demo data now follows `SELL_TAX_BPS` (it still said 15%). The public page, `/classic/`
and `/v2/` need nothing from the Worker: it serves assets for every non-API path and only rewrites the `og:image` and `og:url`
tags of HTML pages (`/og.png` is still in `public/`).

- **Staging is pre-filled for the already-launched test token** `B5Q7wMsmNUAvxkP3u1bJeQhQwSqtgpFBYYHKjAuWFB2`: `MINT` and
  `PAYOUT_WALLET` (the test fee wallet `KDpz3icbjmmib1DDeitywpk6ZdsQckHiqt6hKmKnnaq`) are in `env.staging.vars`; `DBC_CONFIG` is
  left empty on purpose (its config is `5hLxFWnjb6fx4HHQ6HL6tewcbsUVcmN8AdqhEH6gdQKW`, found from the mint: that run is the first real
  test of the discovery). Every var, `MINT`, `PAYOUT_WALLET` and `MIN_HOLD_USD` included, can be replaced at deploy time with
  `--var NAME:value`; `MIN_HOLD_USD` is `"50"` in the file, lower it for a coin of tiny value.
- **Staging starts dry** (`DRY_RUN` and `REFUNDS_DRY_RUN` `"1"`). `--var DRY_RUN:0 --var REFUNDS_DRY_RUN:0` makes it real. That is
  a mainnet money switch for the operator, not something done here.
- **Resources:** D1 database `cult-staging` (`wrangler d1 create cult-staging`; paste its id into `wrangler.jsonc`
  `env.staging.d1_databases[0].database_id`, then `wrangler d1 migrations apply cult-staging --remote`); rate-limit namespaces
  2011 and 2012 are in the file; a Helius enhanced webhook on the test mint pointing at
  `https://cult-staging.<subdomain>.workers.dev/api/hook` with the header `authorization: <HELIUS_WEBHOOK_SECRET>`.
- **Secrets, by name** (`wrangler secret put <NAME> --env staging`, set by Kay): `SOLANA_RPC_URL` (a Helius mainnet URL with key),
  `HELIUS_WEBHOOK_SECRET` (any long random string, the same one given to Helius), `PAYOUT_SECRET_KEY` (the secret key of
  `KDpz...naq`, the test fee wallet), `JUP_API_KEY`. Optional: `CRON_RPC_URL` (falls back to `SOLANA_RPC_URL`), `X_CLIENT_ID` and
  `X_CLIENT_SECRET` (profile linking only). Nothing else reads a secret.
- **Wallet:** `KDpz...naq` holds SOL for fees (0.2 SOL covers the reserve and a migration); the first sweep creates its token
  account for the test token and the first sale opens its USDC account.

## 13. Not done, not verified, open

- Phantom/Solflare/Backpack behaviour with a co-signed transaction (section 4).
- Post-graduation DAMM v2 position fee claim (script hook only).
- A migration against a real graduating pool; a mainnet simulation of the treasury CULT sale.
- Real Helius payloads; Helius `getTokenAccounts` and withheld.
- The pool discovery (`getPoolByBaseMint`) is tested against the real SDK and the real mainnet pool and config accounts with a fake
  node that honours the filters; it has not been run against a live RPC. The staging run on the test token is its first live use.
- Load: the scan reads every token account of the mint with one `getProgramAccounts`; at tens of thousands of holders that is
  a large answer, and the Worker has not been run against it. The fallback is the index, and `FEE_SCAN_MINUTES` can be raised.
- `test/devnet.live.mjs` and `test/programs.e2e.mjs` still test the dead custom pool.
- F7 left failing.

## 14. 16 Nov 2026, second money review fixes (N1, N2, N4, N5, N7, N10)

Review: `docs/reviews/2026-11-16-money-2-curve.md`. Nothing deployed, nothing sent on any cluster, no secret read. Left alone on
purpose: N3, N6, N8, N9 (and F7).

**N1, a given-up account never came back (`src/fees.js`, `migrations/0007_fee_retry.sql`).**
- `skipped_at` (new column): a refund account that was given up is revived by the first touch an hour after it was *given up*, not an
  hour after its last touch (a busy account is touched every few seconds, so that hour never came). A row from before the column
  reads NULL, which counts as long ago.
- A vault or the mint is never given up: a failed `sweep` or `mint` batch is retried with the same backoff for ever (the doubling stops
  at 15 minutes; the shift is capped so it can't overflow). Sweeps are idempotent, cooled down, and Token-2022 skips a bad source
  instead of failing the transaction, so a failing sweep is the network or our SOL, never one account.
- A refund batch of more than one account that fails whole puts every account back with `solo = 1` and counts against none (Token-2022
  checks every destination, so one closed account fails the batch). Those accounts go one transaction each; only an account that fails
  alone counts towards `MAX_TRIES`. `solo` is cleared when the account is refunded or found empty.
- Vault sweeps bid a dynamic compute-unit price: `chain.priorityFee` (new, `getRecentPrioritizationFees` on the accounts, the 75th
  percentile, never below `FEE_PRIORITY_MICROLAMPORTS` 100,000 and never above `FEE_PRIORITY_MAX_MICROLAMPORTS`, new, default
  10,000,000 = 0.00033 SOL for a one-vault sweep). A node that can't answer gives the floor. Refunds and the mint sweep pay the floor. No
  fee helper existed in `src/`, `scripts/` or the kit's modules to reuse. The price is chosen before the transaction is built and signed,
  so claim-before-send and save-signature-before-send are unchanged.
- The run now orders mint, vault sweeps, then refunds, so a refund backlog can't hold the sell tax back inside the 12-transaction run limit.

**N2, one brake for everything (`src/fees.js`, `src/config.js`).**
- `FEE_TX_PER_DAY` is gone. Sweeps and mint sweeps have no daily brake. Refunds have `REFUND_TX_PER_DAY` (default 50,000; kv `refund_day`).
  The count is one atomic upsert per refund transaction, not read-modify-write, so overlapping webhook runs can't undercount it.
- The dust floor is a value: `REFUND_MIN_USD` (default 0.01) at the tick's cached price (kv `price`, used only while younger than an
  hour), rounded up to raw units; below it the withheld part is swept as before. No fresh price: `REFUND_MIN_TOKENS`. `REFUND_MIN_USD`
  `0` turns the value floor off.

**N4, a stranger's copy of the coin on our public config.**
- `src/token22.js` `parseMint` now returns `mintAuthority`. `payoutProblem` (`src/indexer.js`) refuses a mint whose fee is not
  `SELL_TAX_BPS` (it only logged before), and one with a mint or a freeze authority. What a remembered pass depends on now includes
  `SELL_TAX_BPS`, `DBC_CONFIG` and the new `CREATOR`, so a changed setting is checked again (an old record without them is checked again too).
- `src/dbc.js`: `poolRefusal` (pure) and `poolProblem` (one `getPoolByBaseMint` read, only when `DBC_CONFIG` or `CREATOR` is set; unknown
  refuses). `locate` refuses a found pool that differs, never remembers it, and keeps the pool's creator in the saved record (a saved pool
  is trusted only for the settings it was checked under). With both vars unset nothing changes.
- `scripts/verify-launch.mjs` (read only): `--rpc --mint [--config] [--creator] [--fee-wallet]` plus `--start-mcap --grad-mcap --pool-fee-bps`
  (the curve the config was made with; the defaults are the production ones, the staging config was made with 30 / 400). It reuses
  `mintMismatches` and `configMismatches` from `launch-curve.mjs` and `readMint`, `buildCurve`, `curvePlan` from `lib/curve.mjs`, and adds the
  pool's base mint, config and creator. It never prints the RPC address. Without `--creator` the creator line is printed and not checked.
- Not added: the Worker does not check the mint's fee-config authority or fee maximum (`verify-launch` does).

**N5 (`src/jupiter.js`).** `prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: MAX_PRIORITY_LAMPORTS, priorityLevel: "veryHigh" } }`
instead of `"auto"`, so Jupiter can't answer above the cap `inspect` enforces.

**N7, nothing refilled SOL after graduation.**
- `SOL_RESERVE_LAMPORTS` is `"1000000000"` (1 SOL) at the top level and in `env.staging`.
- `src/damm.js` (new, shared): `positionsOf` and `claimPositionTx`, moved out of `scripts/fee-ops.mjs claim`, which now imports them.
- `src/dbc.js`: `claimDammFees`, a third `dbcTick` step beside the migration and the curve claim (an error in one never stops another). After
  graduation, once an hour, it reads the DAMM v2 pool and the payout wallet's positions, takes the one with the most SOL waiting (at least
  0.005 SOL), and sends the SDK's claim after the same checks as every SDK transaction (programs, signers, simulated to raise the wallet's SOL,
  fence, signature saved in kv `claim_damm` before the send, settled from the signature). `DRY_RUN` claims nothing. The two claims share one
  state machine (`claimOne`); `claimFees` behaves as before. An unreadable pool or position list is "nothing to claim" (logged), and a
  look that finds nothing is not repeated for an hour, so an idle minute costs no RPC.
- **Not done:** no USDC-to-SOL swap. After graduation the only SOL inflow is this claim. The coin's side of the position fees (token A)
  arrives in the treasury account and pays the 10% there, which N3 (left alone) says is never released.

**N10 (`src/indexer.js`).** The paying step's total leaves out batches with a `dry-run-` signature unless the round itself is a practice
round (`swap_sig = 'dry-run'`, which keeps its own total, listed apart). The filter the review suggested without that condition would
have shown every practice round as paying 0.

**Tests.** Changed: `review2-fees` N1a setup (asserted `skip` for a vault; the brief says a vault is never given up, so it asserts it
is still being retried and keeps the rest unchanged); `fees.test.js` brake test (renamed var, now also checks sweeps are not braked) and
the `realDeps` key list; `launch-fixes` remembered-pass record; `dbc.test.js` saved-pool record (now has the creator);
`engine-fakes` answers `getRecentPrioritizationFees`; `fakes.mintAccount` takes the two authorities. New: 8 in `fees.test.js`,
8 in `dbc.test.js`, 3 in `launch-fixes.test.js`, 4 in `review2-fixes.test.js`, 6 in `scripts/test/verify-launch.test.mjs`.

**Deploy notes.** Apply migration 0007 before the new Worker runs. Set `CREATOR` (frz's wallet) with `MINT` at T-0, after `verify-launch`.
Fund the payout wallet to about 1.2 SOL: the round sells only SOL above the 1 SOL reserve.

**Gate, run unpiped, each exit code read (16 Nov 2026):** `npm run check` 0 (40 files); `npm run build` 0 (gzip 446 KiB, the DAMM v2 SDK is now
in the bundle); `npm test` exit 1: 261 tests, 258 pass, 3 fail (F7, left on purpose; N3 and N6, left alone by the brief);
`node --test "scripts/test/*.test.mjs"` 37 of 37 pass (31 before, 6 new). The review's N1a, N1b, N2, N2b and N5 pass.
`verify-launch.mjs` was run read-only against mainnet with the staging test token: passes with its own config (`--start-mcap 30 --grad-mcap 400`),
fails with the production default config (feeClaimer, leftoverReceiver and the pool's config), fails with a wrong `--creator`, passes with the right one.

**Mutation pass (a copy of the tree with `node_modules` junctioned; each mutant an exact string, checked to match).** 45 mutants, all killed:
revive by `updated`; a vault or the mint skippable; `skipped_at` never written; no solo retry; solo accounts batched; solo not cleared; the
brake counting sweeps; refunds ordered first; the dust floor off; old prices used; dust rounded down; a non-atomic refund count; a sweep at the
fixed price; refunds bidding the dynamic price; the percentile, floor, cap and failure answer of `priorityFee`; Jupiter back to `auto` and its
cap off the constant; `poolRefusal` ignoring the creator or the config; `poolProblem` passing always, reading when unset, or passing on an
unreadable or missing pool; `locate` remembering a refused pool or trusting a saved one for another creator or not saving the creator;
`payoutProblem` ignoring a mint authority, a freeze authority, a fee mismatch, the pool check, or the creator or config in what a pass
depends on; the N10 filter off and the practice-round exception off; the DAMM claim before graduation, below the floor, picking the smallest
position, repeating an idle look, missing from the tick, ignoring `DRY_RUN`, for another owner, and sending before saving. The first
version of the harness could not tell: the copy's path was long enough to push miniflare's D1 files past 260 characters, so one test file
failed to start on the unmutated copy too, and every mutant looked killed. The copy now lives at a short path and each verdict compares
with the unmutated files' own failures (the review's N3 and N6).
