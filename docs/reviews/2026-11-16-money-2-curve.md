# Money review 2: the curve design (CULT, branch kay/launch-prep)

Date: 2026-11-16. Reviewer: money-reviewer agent (second pass). Scope: the Meteora DBC + Token-2022 10% transfer-fee design that replaced the custom pool and transfer hook: `src/` (fees, token22, jupiter, trade, trades, dbc, indexer, chain, live, config, index) and `scripts/` (create-config, launch-curve, lib/curve, fee-ops, migrate-curve). No source or script was changed. No transaction was sent on any cluster. `program-keys/` and secrets were not read.

## Verdict

**Do not let this pay real money in round 1 as it stands.** The signing paths are tight: I found no way for an outside input to make the hot key move its assets to someone else. But two cheap-to-fix faults in the refund and sweep engine stop the sell tax and the buy refunds on exactly the day the design is under most load:

- **N1:** any five failed or dropped sweeps of the pool vault (congestion on the hottest account of launch day, or the payout wallet short of SOL) give the vault up. It is never retried while trades keep touching it. The sell tax then stops for good, silently.
- **N2:** refunds and sweeps share one 5,000-transaction daily brake. The webhook sends one refund transaction per buy, so a busy launch day reaches the brake by itself. After that, buyers keep 90% and no sell tax is swept until midnight UTC. The dust floor (0.1 token) is worth nothing at these prices, so a troll can trip the brake for about $2 a day.

With N1 and N2 fixed, the N4 read-back done at T-0, the N5 one-liner, and `SOL_RESERVE_LAMPORTS` plus the wallet's SOL raised (N7), I would let it pay from round 1.

## Baseline

Run on 16 Nov 2026 before any test was added, from `C:\Users\kaylu\Projects\cult`:
- `npm test`: 230 tests, 229 pass, 1 fail (F7, the known aged-dust-wallet boost, left failing on purpose).
- `node --test "scripts/test/*.test.mjs"`: 31 tests, 31 pass.

After adding this review's tests: `npm test` runs 237 tests, 229 pass, 8 fail (F7 plus the 7 below, each failing for the reason it names).

One of my two full runs also failed 30 tests in `test/round.test.js`: its `before` hook's `wrangler d1 migrations apply` failed while every test file starts wrangler at once. My file adds one more wrangler process. `round.test.js` alone passes 30 of 30, and the rerun of the full suite was clean apart from the 8 above. If it recurs, run with `--test-concurrency=4`.

## Findings

Ranked: blocker / fix before launch / after launch. Within a band: loses money, wrong recipient, stuck funds, wrong number shown.

### Blockers

**N1. A given-up account never comes back while anything touches it. The vault can stop being swept for good.**
- **Where:** `src/fees.js:52-54` (enqueue), `:211-213` (settle gives up after `MAX_TRIES` 5), `:241-243` (the 30-minute scan re-queues every account with withheld tokens).
- **Mechanism:** a `skip` row revives only when it is touched after an hour of silence (`updated < now - 1h`). But every touch sets `updated = now`. The vault is touched by every trade (webhook and poller), and every account holding withheld tokens is touched by the scan every 30 minutes. So the hour of silence never comes.
- **Scenario:**
  1. Launch day. Every swap write-locks the curve's base vault, and our sweep pays a fixed 100,000 microlamports per CU, which loses to traders. Or the payout wallet runs short of SOL (see N7).
  2. Five sweep transactions expire unseen. That takes about 10 to 20 minutes, and the round's forced sweep shortens it because it ignores the backoff. The vault goes to `skip`.
  3. The cause goes away, but trades keep touching the vault every few seconds.
- **End state:** the sell tax stays withheld in the vault forever. The round still runs: the CULT leg finds an empty treasury, and the pot is only the SOL leg. No alert fires. The `pending` figure on the site keeps showing a pot that never arrives.
  - The same happens to a buyer's refund: they keep 90% for good, and so do their later buys, because their row stays `skip`.
  - **Amplifier (suspected, a race):** Token-2022 fails a whole refund transaction if any one of its destinations is closed (`check_program_account(destination)` in `transfer_fee/processor.rs`, read in the t22 clone). A sweep batch is not affected, because a bad source is only logged.
  - An account owner who empties, harvests and closes their account between our read and our send poisons the batch of 18 it rode in. Five such wins send 17 innocent holders to permanent `skip`.
- **Tests:** `test/review2-fees.test.js`:
  - `N1a`: the vault is still `skip`, holding 550,000 tokens, three hours after the outage ended.
  - `N1b`: the buyer is still unrefunded four hours later, across eight scans.
- **Smallest fix:**
  - Revive a `skip` row by time since it was given up, not since it was last touched: add `skipped_at`, and in enqueue revive when `skipped_at < now - 1h`.
  - Never skip the vaults or the mint (sweeps are idempotent and cooled down anyway).
  - When a refund batch fails, split it into one transaction per account, as `paying` already does with `SPLIT_AT`.
  - Raise the sweep priority, or make it dynamic, for the vault.

**N2. Refunds and sweeps share one day brake. A busy day (or $2 of dust) stops both until midnight UTC.**
- **Where:** `src/fees.js:152-157` (one `fee_day` counter for every kind), `src/indexer.js:250-256` (one webhook run per delivery, one refund transaction per buy), `src/config.js:148` (`REFUND_MIN_TOKENS` 100,000 raw = 0.1 token).
- **Scenario, organic:** each buy's webhook refunds that buyer's account alone in its own transaction. A coin that trades well sees more than 5,000 buy transactions on day one. At the 5,000th fee transaction:
  - every later buyer keeps 90% until 00:00 UTC;
  - the round's forced sweep sends nothing (`left` is empty), so the sell tax sits in the vault and rounds pay only the SOL leg.
- **Scenario, attack:** 0.1 token withheld is worth about $0.0000006 at the 27.96 SOL start, so the dust floor does nothing.
  - An attacker sends roughly 20 one-token transfers per transaction to accounts it owns. The tokens come back to it as refunds.
  - About 2,000 such transactions (about 0.01 SOL a day) exhaust the brake right after midnight, every day. Our side pays about 0.07 SOL a day.
  - The concurrent webhook runs also lose updates to the counter (read-modify-write on kv), so the brake undercounts.
- **End state:** nothing is lost, but the two public promises fail on the busiest day: buys are free, and airdrops come every 10 minutes. The tax piles up in the vault (and with N1 it can be lost for good).
- **Tests:** `test/review2-fees.test.js`:
  - `N2`: 108 dust refunds use the brake, and the sweep then moves none of the vault's 50,000 tokens. Scaled: a brake of 6 stands for 5,000.
  - `N2b`: 20 ordinary buys stand for 5,000. The 21st buyer and the vault are both left untouched.
- **Smallest fix:**
  - Count sweeps and mint sweeps outside the day brake. Their 5-minute cooldown already bounds them to about 300 a day.
  - Give refunds their own cap, sized for a launch day (for example 50,000, with a SOL-spend cap as the real brake).
  - Set the dust floor by value, not raw units: withheld worth at least our per-account refund cost, about 3,000 lamports, priced from the curve.
  - Optionally batch webhook refunds: refund at once only when the withheld amount is worth it, and leave the rest to the cron's batches of 18.

### Fix before launch

**N4. Nothing checks the mint Proxima actually made, and a stranger's token on our config passes every Worker check.**
- **Where:** `src/indexer.js:282-294` (`payoutProblem` checks only the withdraw authority; the fee rate is only logged); `src/dbc.js:53-62` (`locate` takes whatever pool the mint has; `feeClaimer` and creator are read but never compared).
- **Why it matters:**
  - The full read-back (`mintMismatches`, `configMismatches`, pool creator and config, at `scripts/launch-curve.mjs:301-312`) runs only when `launch-curve.mjs` itself launches. The Proxima route never runs it. `create-config.mjs:52-55` checks only the config.
  - DBC configs are public: the DBC `ConfigParameters` has no pool-creator field (checked in the SDK IDL), and `poolCreationFee` is 0. Anyone can launch on our config for free.
  - A stranger's token on our config therefore gets our payout wallet as withdraw-withheld authority and fee claimer, and the Worker accepts it as ours.
- **Scenario:** a copycat "CULT" is launched on our config minutes before or after frz's. The address pasted into `MINT` comes from X or a search instead of Proxima's result screen.
- **End state:** the Worker refunds, sweeps and airdrops for the wrong coin, paying its holders from our wallet's SOL and USDC. Nothing refuses.
- **Test:** none. This is certain by construction: any mint on our config has `withdrawAuthority = PAYOUT_WALLET`, the only property the tick checks.
- **Smallest fix:**
  - Add a `CREATOR` var (frz's wallet). In `payoutProblem`, read the pool by base mint and refuse unless `pool.creator === CREATOR` and `pool.config === DBC_CONFIG`.
  - Refuse unless the mint's fee is 1000 bps with the maximum at u64 max, there is no fee-config authority, and there is no mint or freeze authority.
  - At T-0, run a `verify` command that calls the existing `mintMismatches` and `configMismatches` on the Proxima mint, before `MINT` is set.

**N5. The swaps ask Jupiter for an uncapped `auto` priority fee, above the 3,000,000-lamport cap the inspection enforces.**
- **Where:** `src/jupiter.js:129` (`prioritizationFeeLamports: "auto"`) against `:19` and `:100` (`MAX_PRIORITY_LAMPORTS` 3,000,000). Jupiter's `auto` is capped at 5,000,000 lamports (older v6 docs), and its v1 docs recommend `priorityLevelWithMaxLamports` for hot local fee markets.
- **Scenario:** launch-day congestion on the curve's accounts. Jupiter answers with a fee between 3,000,000 and 5,000,000 lamports.
- **End state:** the round's CULT sale is refused on every tick while it lasts (payouts stall). Every site trade answers "Couldn't build that trade just now", at the moment people most want to buy.
- **Test:** `test/review2-jupiter.test.js` `N5`: a 4,000,000-lamport answer to the `auto` request is refused (`priority fee`).
- **Smallest fix:** send `prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 3_000_000, priorityLevel: "high" } }`.

**N7. After graduation nothing puts SOL back in the payout wallet, and any SOL an operator adds is sold at the next round.**
- **Where:**
  - `src/dbc.js:164-194` claims only the curve's partner fees. The DAMM v2 position fees (SOL) are script-only (`scripts/fee-ops.mjs claim`).
  - `src/indexer.js:507-513`: the SOL leg sells everything above `SOL_RESERVE_LAMPORTS`.
  - `src/indexer.js:42-48`: a new holder's USDC-account rent is taken from their USDC share, which stays in the pot. The SOL that opened the account is never replaced.
- **Scenario:** after graduation the wallet pays, from a 0.2 SOL reserve:
  - payout transactions (about 18,000 lamports each);
  - refunds (about 6,000 per buy) and sweeps;
  - Jupiter priority (up to 0.003 SOL per swap, 144 rounds a day);
  - 0.00204 SOL per new holder's USDC account.
  At a few hundred payees that is roughly 0.2 to 0.3 SOL a day, so about a day of runway.
- **End state:** every transaction then fails. Payout batches go `failed` (the USDC rolls over), and refunds and sweeps go `skip`, which N1 makes permanent.
  - A top-up does not help unless the var is raised as well: the next round sells everything above 0.2 SOL into the pot. That is the operator's SOL given to holders.
  - Round 1 on a cold 0.2 SOL wallet is also thin: 50 new holders without USDC accounts cost 0.1 SOL, which leaves the migration's 0.15 SOL short until the next hourly claim.
- **Test:** none (arithmetic and code reading). Marked confirmed for "no SOL inflow after graduation" (read in code). The rate is an estimate.
- **Smallest fix:**
  - Set `SOL_RESERVE_LAMPORTS` to 1 SOL and fund the wallet with that much plus margin.
  - Before the SOL leg, swap USDC to SOL when SOL is below the reserve. The rent the holders paid in USDC is exactly what this needs.
  - Claim the DAMM position fees from the Worker, or schedule `fee-ops claim`.
  - Log an error when SOL is below the reserve.

### After launch

**N3. Tokens withheld in the treasury's own account are never released.**
- **Where:** `src/token22.js:76` returns `none` for the treasury and for any account owned by the payout wallet.
- **Scenario:** anything that transfers into the treasury pays the 10% there: `withdraw_leftover` (the leftover receiver is the fee wallet's ATA), a donation, or a partner base-fee claim.
- **End state:** stuck but ours. The amounts are tiny for this config: 3 raw units in the rehearsal, and base fees are 0.
- **Test:** `N3` in `test/review2-fees.test.js`.
- **Fix:** classify a treasury with withheld tokens as a self-refund.

**N6. The treasury swap's simulate-and-compare watches three accounts, not the wallet.**
- **Where:** `src/jupiter.js:143-155`. Lamports are checked only when SOL is the input; the wSOL account, the DAMM position NFT account (owned by the hot wallet after graduation) and any other token account are never watched.
- **Exploitable only if** Jupiter's API answer is hostile and the Jupiter program lets the route spend the signer's SOL in a CPI. The static rules block every top-level way.
- **Test:** `N6` in `test/review2-jupiter.test.js`: a CULT sale that also costs the wallet 1 SOL passes.
- **Fix:** always bound the lamport drop (fees plus rent, plus the amount when SOL is sold). Simulate with every writable account of the Jupiter instruction, and refuse if any token account owned by the payout wallet other than the input, output and wSOL accounts changes.

**N8. Round-1 holder list trusts Helius DAS completely (suspected).**
- **Where:** `src/indexer.js:436`, `:447-449`. The holder-drop guard needs 20 earlier holders, so round 1 accepts any non-empty list.
- **Scenario:** if DAS has not indexed every account in the first minutes, the few wallets it lists share round 1's pot. That pot holds all the tax since launch, capped by the 3% impact cap on the sale.
- **Not reproduced:** I could not measure DAS lag.
- **Fix:** the same tick's scan already reads every token account by `getProgramAccounts`. Build the snapshot from it, or refuse when DAS returns fewer owners than it.

**N9. Third-party harvest makes a buyer pay 10%.**
- **Where:** `src/fees.js` mint path (accepted in the build log).
- **Scenario:** `HarvestWithheldTokensToMint` is permissionless. A griefer harvesting buyers' accounts before our refund costs each buyer 10%, which goes to the pot. It costs the griefer about 5,000 lamports per ~20 accounts and gains nothing.
- **Fix (later):** the mint withdraw can name any destination. Return a harvested amount we had seen queued to the account it came from, instead of the treasury. Atomic buys are immune.

**N10. A `DRY_RUN` flip in the middle of a live round shows unpaid USDC as airdropped (wrong number shown).**
- **Where:** `src/indexer.js:579` marks pending batches `confirmed` with `dry-run-` signatures; `:592-594` sums them into `usdc_micro` without the `REAL_BATCH` filter. Because `swap_sig` is real, `src/live.js:18` counts the round in `totals.paidUsdc`. The USDC also rolls over and is counted again when it is really paid.
- **Fix:** add `b.sig NOT LIKE 'dry-run-%'` to the sum at `:592`. No test was written.

**Design notes (inherent, not fixable without changing the rule):**
- Every route where CULT changes hands without landing in a program-owned account is tax-free, by design:
  - wallet-to-wallet sends, OTC, a market maker's hot wallet, Jupiter RFQ fills;
  - a wrapper token (10% once on deposit, then the wrapper trades free);
  - assigning ownership of a non-ATA token account to someone else (no transfer at all; plain accounts have no ImmutableOwner).
- Program flows pay twice: a DCA or limit-order vault taxes both the deposit and the buy leg.
- Snapshot sniping (buy just before the snapshot, sell after paying 10%) pays only when one round's pot exceeds about 10.5% of all eligible holdings: a capitulation round, or round 1 after a late deploy. A one-round holding requirement would halve the window.
- DAS paging during wallet-to-wallet ping-pong adds variance but no expected gain.
- The predictable 10-minute sale can be front-run or sandwiched within its 1% slippage.

## Checked and sound

- **The co-signed atomic buy:**
  - Our signature covers one fixed message. The fee payer is the buyer.
  - `inspect` refuses any Jupiter instruction that names the fee key (`forbid`), any other signer, and every Token-2022 instruction. So the only instruction that can use the fee key's signer bit is our own `refundIx(mint, ATA(mint, buyer), feeKey)`, whose source and destination are the buyer's own account.
  - A user cannot reach the vault, the treasury, a delegate or an authority with it.
  - A wallet that is a PDA gets either `refund: "none"` (the account exists and is off-curve) or a transaction that no one can sign.
  - Lookup tables only compress keys already named.
  - Durable nonces are refused (the System rule).
- **Fee batches are idempotent by chain state:**
  - A refund that runs twice withdraws only what is withheld then. A sweep can only move withheld tokens to the treasury.
  - Claim-before-read, save-before-send and settle-from-signature hold under webhook and cron overlap (the existing tests, plus my reading).
  - A sweep cannot be poisoned by one bad source (Token-2022 logs and skips it).
- **The CULT and SOL legs:**
  - Each is claimed conditionally before it is sent.
  - A "lost" swap that really landed cannot double-sell, because the retry sells the balance that is left, and the simulation fails if it is gone.
  - The treasury's own sale is not a trade: `readTrade` drops the payout wallet. Its 10% returns through the vault, and it is counted nowhere else.
- **Payouts:**
  - The conditional claim per batch and the fenced 15-minute lock hold.
  - The pot is the confirmed USDC balance, and the allocation never exceeds it.
  - The round cannot overlap the next one: a new drop opens only when the last is done.
- **Migration and claims:**
  - The SDK output is checked for programs and signers, and simulated before it is sent.
  - The migration is saved by a conditional insert before it is sent, and a migration done by the keeper or anyone else is detected.
  - The claim is simulated for a SOL gain.
- **Startup checks:**
  - A `PAYOUT_SECRET_KEY` that does not match `PAYOUT_WALLET` throws before anything is signed.
  - A withdraw authority that is not the payout wallet stops the tick and every fee run.
  - A curve quoted in anything but SOL is refused by the curve reader. The round itself still runs, on Jupiter prices.
- **`create-config.mjs` against `launch-curve.mjs`:** both go through the SDK's `buildCreateConfig2Tx` with the same `buildCurve` output, fee wallet, leftover receiver, quote mint and `transferFeeParameters`. The read-back compares the same `configMismatches` fields. No field differs.
- **Inputs:**
  - A Helius body and `/api/refund/hint` only nominate accounts. Every action is classified from a fresh chain read.
  - Classification rejects other mints. The scan's `getProgramAccounts` is restricted to Token-2022 and our mint.
  - No memo, token name or other free text reaches any amount or destination.

## Not verified

- **Wallets:** whether Phantom, Solflare or Backpack keep our co-signature (atomic stays off by default, which is right).
- **Real-world rates:** real DAS lag at launch, the real congestion drop rate for a 100,000-microlamport sweep on a hot vault, and Jupiter's real `auto` fees on launch day.
- **The SOL drain:** the N7 rate is arithmetic, not measured.
- **Jupiter v1:** whether Jupiter still serves `/swap/v1/*`. Its docs call the v1 Swap API unmaintained and superseded by Swap V2. If v1 is switched off, the CULT leg and site trades stop.
- **Jupiter's program:** whether it lets a route spend the signer's native SOL (the premise of N6).
- **Proxima:** whether it passes our config through unchanged. The program enforces the config's fee settings, but nothing reads back the result (N4).
- **Load:** the poller at launch-day volume (300 transactions a tick), and the scan's `getProgramAccounts` size at tens of thousands of holders.
- **Program-side math:** the DBC and DAMM v2 math beyond the scripts' build log, and the rehearsal's on-chain numbers (not re-read).

## Tests added

All fail on the code as reviewed. Each should pass once its finding is fixed.

| File | Test | Finding |
|---|---|---|
| `test/review2-fees.test.js` | N1a: vault never swept again after five lost sweeps | N1 |
| `test/review2-fees.test.js` | N1b: buyer never refunded after five lost refunds | N1 |
| `test/review2-fees.test.js` | N2: dust refunds use up the shared brake, sweep moves nothing | N2 |
| `test/review2-fees.test.js` | N2b: ordinary buys reach the brake, later buyer and vault untouched | N2 |
| `test/review2-fees.test.js` | N3: treasury withheld never released | N3 |
| `test/review2-jupiter.test.js` | N5: `auto` priority over the cap refuses the swap | N5 |
| `test/review2-jupiter.test.js` | N6: CULT leg accepts a swap that also takes 1 SOL | N6 |
