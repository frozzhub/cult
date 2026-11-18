# Day-one visibility with a 15% sell tax

Status: done for a launch decision (2026-11-16). Evidence is file:line in local clones or a URL. Anything not read in a primary source is marked UNVERIFIED. No transaction was sent; nothing in the repo outside this file was changed.

Source clones (scratchpad `C:\Users\kaylu\AppData\Local\Temp\claude\1d02f61daabbf3e1\24564398-2b25-475f-9b5a-58e292f18db4\scratchpad\`):
- `met/damm-v2` (MeteoraAg/damm-v2 @ 18936b18, 12 Nov 2026), `met/damm-v2-sdk` (@ eab5e8aa, 4 Nov 2026), `met/dynamic-bonding-curve`
- `t22` (solana-program/token-2022 @ e8ca680c, 13 Nov 2026)
- `pumpdocs` (pump-fun/pump-public-docs @ 639b87fb, 13 Oct 2026)

## Goal

- A. Sellers pay ~15%, buyers ~0%. The 15% reaches us; a Worker pays holders USDC every 10 minutes.
- B. Visible and tradable on day one on DexScreener, GMGN, Axiom, Photon, BullX, Padre, Birdeye, Jupiter.
- C. No ~30 SOL of our own in the pool.
- D. Sells never fail on third-party terminals.

## The idea in one paragraph

Make CULT a Token-2022 mint with a native 15% transfer fee and trade it on a single-sided Meteora DAMM v2 pool (tokens only, priced from the launch price upward). Every transfer withholds 15% in the receiving token account. On a sell the receiver is the pool vault, so the fee stays ours. On a buy the receiver is the buyer's own token account, and Token-2022 lets the withdraw-withheld authority move an account's withheld tokens **back into that same account with no fee** (`t22/program/src/extension/transfer_fee/processor.rs:276-287`, the "self-harvest" branch). So the Worker refunds every buyer's withheld 15% to their own account seconds after the buy, at the cost of one cheap instruction. Buys from our own site carry that refund instruction in the same transaction, so they are 0% atomically. Because the fee lives in the mint, every pool anyone creates pays it too, so the transfer hook that blocks other pools is no longer needed.

## Candidates

| # | Design | A (sell / buy) | B | C | D | Verdict |
|---|--------|---|---|---|---|---------|
| 1 | **15% transfer fee + DAMM v2 single-sided pool + self-harvest refund to buyers** | 15% / ~0.25% pool fee; buy tax refunded seconds later (0% atomic on our site) | DAMM v2 is indexed by DexScreener, GMGN, Axiom, Photon, Birdeye, Jupiter; live transfer-fee token BERN has DAMM v2 pools on DexScreener and routes on Jupiter. BullX/Padre UNVERIFIED | Yes, tokens only | Sells succeed when the terminal models the transfer fee (Meteora SDK and Jupiter do); a terminal that ignores it fails below ~16% slippage. UNVERIFIED per terminal: must test | **Recommended** |
| 1b | Same, on Raydium LaunchLab | 5% cap on transfer fee | Indexed | Yes (curve) | as 1 | Fails A: max 5% |
| 1c | Same, on Meteora DBC | 10% cap; top up with 5% pool fee refunded in SOL | Indexed, launchpad feeds | Yes (curve) | as 1 | Near miss, more moving parts |
| 1d | Same, on DLMM single-sided | as 1 | Indexed | Yes | as 1 | Not checked in program source (no clone); DAMM v2 is simpler |
| 2a | pump.fun holder-rewards coin | creator fee only, both sides, fraction of a percent | Best visibility | Yes | Yes | Fails A |
| 2b | Heaven, Moonshot, Boop, LetsBonk | no sell-only fee found | Indexed | Yes | Yes | Fails A (no asymmetric fee found; Heaven UNVERIFIED) |
| 3a | DAMM v2 / DBC fee asymmetry (collect mode, scheduler, rate limiter) | symmetric | | | | Discarded: fee rate is the same both ways |
| 3b | Transfer hook paying an atomic SOL rebate | | DAMM v2 rejects active hooks without a badge; LaunchLab rejects hooks | | | Discarded |
| 3c | Plain SPL + DAMM v2 15% pool fee both ways + SOL refund to buyers | ~12% to us / ~0-3% | Yes | Yes | Best | **Runner-up**: anyone can open a cheaper pool and drain the fee |
| 0 | Current custom pool + hook | 15% / 0% | Fails | Yes | Yes | Fails B (see custom-pool-indexing.md) |

## Verdicts and evidence

### 1. Transfer fee + refund on DAMM v2 (recommended)

**Token-2022 allows a 15% fee and a fee-free refund**
- Fee cap is 100%: `MAX_FEE_BASIS_POINTS: u16 = 10_000` (`t22/interface/src/extension/transfer_fee/mod.rs:26`), checked at `t22/program/src/extension/transfer_fee/processor.rs:47,91`.
- The fee is withheld in the **destination** account: `t22/program/src/processor.rs:574-586` credits `amount - fee` and adds the fee to the destination's `withheld_amount`.
- Refund: `WithdrawWithheldTokensFromAccounts` with destination = the buyer's account and source = the same account takes the self-harvest branch, which zeroes `withheld_amount` and adds it to `amount` directly. No transfer, so no fee and no gross-up (`processor.rs` transfer_fee, lines 276-287). Signed by the withdraw-withheld authority only (lines 252-261), so the buyer does nothing.
- Harvesting to the mint is permissionless (`process_harvest_withheld_tokens_to_mint`, line 195). Anyone can move a buyer's withheld tokens to the mint before we refund. The tokens are not lost: `WithdrawWithheldTokensFromMint` can send them to the buyer, also fee-free. The Worker therefore keeps its own ledger of refunds owed rather than reading only the account's withheld field.

**DAMM v2 takes the mint permissionlessly, single-sided**
- `TransferFeeConfig`, `MetadataPointer`, `TokenMetadata` are permissionless; no rate cap is applied (`met/damm-v2/programs/cp-amm/src/utils/token.rs:225-262`). Meteora's older docs say a badge is needed for Token-2022; the source, and the changelog's long-standing permissionless list, say otherwise for transfer fees. The devnet rehearsal will settle it against the deployed program.
- Single-sided: `initialize_customizable_pool` needs only `token_a_amount > 0 || token_b_amount > 0` (`instructions/initialize_pool/ix_initialize_customizable_pool.rs:295-296`) with the start price equal to the minimum price (lines 53-70). The SDK has `preparePoolCreationSingleSide`, which requires `initSqrtPrice == minSqrtPrice` (`met/damm-v2-sdk/src/CpAmm.ts:1768-1800`).
- A single position over [P0, max] is a constant-product curve with virtual SOL equal to the launch market cap, so "starts as if it held 30 SOL" needs no SOL. The price can never fall below P0: sells can only take out SOL that buyers put in.
- The seed deposit itself pays the 15% (the program pulls the fee-inclusive amount, `ix_initialize_customizable_pool.rs:363-377`). The withheld part sits in the vault and we withdraw it with the authority afterwards.
- Swap maths nets the transfer fee on both legs and checks slippage against what the user actually receives (`instructions/swap/swap_exact_in.rs:20-48`). The vault's withheld balance is outside `amount`, so the pool never touches it and our withdrawals do not disturb the pool.
- Lock: `permanent_lock_position` (`lib.rs:295`). Locked liquidity still earns fees (`state/position.rs:161`).
- Pool fee is the same rate in both directions (`state/fee.rs:361-375`), minimum 0.01% (`constants.rs:114`), and Meteora takes 20% of it (`constants.rs:133`). Set it low, for example 0.1-0.25%; that is the whole buyer cost.

**Indexed on day one (B)**
- Jupiter lists new markets on DAMM v2 automatically, and during a grace period set by **token age** the liquidity test does not apply (https://developers.jup.ag/docs/swap/routing/market-listing). After it, a market must lose under 30% on a $500 round trip or pass the price-impact test, rechecked every 30 minutes. Grace length: UNVERIFIED.
- Meteora's docs list Axiom, Photon, Jupiter, GMGN, DexScreener, Birdeye among integrators and say SOL-quoted pools are needed for Axiom, Photon and BONKbot (https://docs.meteora.ag/user-guide/guides/how-to-use-damm-v2; Meteora's own claim, not the terminals'). BullX and Padre: UNVERIFIED.
- Live example, read today: BERN (`CKfatsPMUf8SkiURsDXs7eK6GWb4Jsd6UDbs7twMCWxo`) is a Token-2022 mint with a transfer fee (2.69% now, 4.2% before; `getAccountInfo` on mainnet). DexScreener's API lists its pairs on FluxBeam and three Meteora `DYN2` (DAMM v2) pools; pool `8HSxomqhjFNfDNKwcvsugfLCafYEgvLskwv1HUCNNdBR` is owned by `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`. Jupiter's quote API returns a route for SOL to BERN today. So transfer-fee tokens on DAMM v2 are indexed and routed. No live coin with a 15% fee was found.

**How terminals show and handle it (D)**
- GMGN says it reads the Token-2022 fee rate and update authority on-chain and shows a "Total Tax" for tax tokens (https://gmgn.ai/blog/trading-meme-coins-bsc-vs-solana/). Expect CULT to show about 15% buy and 15% sell tax there. The refund is invisible to GMGN.
- RugCheck flags "Fee config enabled: the owner can change the fees" when the fee config authority is kept (BERN's report, https://api.rugcheck.xyz/v1/tokens/CKfat.../report/summary). Revoking the config authority removes that. Whether RugCheck or GMGN flag a high fee by itself: UNVERIFIED.
- Meteora's SDK quotes net the transfer fee on input and output (`met/damm-v2-sdk/src/math/swapQuote.ts:506,523,598,615`), so a terminal built on it sends the right minimum out. Jupiter says it supports transfer fees "across the entire stack" (https://discuss.jup.ag/t/archived-jupiter-token-2022-support/21711). Axiom, Photon, BullX, Padre: no source found. A terminal that ignores the fee quotes 15% too much and the sell fails unless slippage is ~16% or more (buys fail the same way). This is the main open risk and needs a live test.
- Jupiter after the grace period: its $500 round-trip test cannot see our later refund, so it counts both fees, 1 - 0.85 x 0.85 = 27.75%, plus price impact. That is close to the 30% line. Passing the price-impact test instead needs a deep enough curve. Terminals that build pool instructions directly keep working either way.

**Abuse and economics**
- Refund rule: refund withheld tokens on accounts whose owner is a wallet (on-curve key); never on program-owned accounts (pool vaults, router intermediates). Sells into any pool, ours or someone else's, land in a program-owned vault, so they always pay. Buys from any pool are refunded. Wallet-to-wallet transfers are refunded too, which is good for holders.
- No one can profit from the refund: it returns exactly what that account lost.
- Gap: a wallet-owned token account with a program as delegate could act as a pool vault and be refunded. That needs a custom, unindexed venue; skip refunds for accounts with a delegate set.
- Router multi-hop: if Jupiter routes CULT through its own intermediate account, the buyer pays the fee twice and only the last one is refunded. UNVERIFIED; check in the mainnet rehearsal. The Worker can refund the signer from the intermediate account's withheld amount, since the authority can withdraw from any account.
- Sell pressure from turning fees into USDC is the same as today: the seller's tokens reach the pool either way, part now and part when we sell the withheld 15%. Our own sell of withheld tokens pays 15% again, which we withdraw again, so it converges.
- Cost: one `WithdrawWithheldTokensFromAccounts` per buyer, several per transaction, about 0.000005 SOL plus priority fee each.

### 1b. Raydium LaunchLab with a transfer fee

`MAX_TRANSFER_FEE_RATE` is 500 (5%), and only `MetadataPointer` and `TransferFeeConfig` are accepted (https://docs.raydium.io/reference/changelog/2026-08-27-launchlab-token2022-withheld-authority.md). Token-2022 coins migrate to CPMM. Fails A: 5% maximum.

### 1c. Meteora DBC with a transfer fee

`MAX_BASE_TRANSFER_FEE_BPS: u16 = 1000; // 10%` (`met/dynamic-bonding-curve/programs/dynamic-bonding-curve/src/constants.rs:82`, checked at `process_create_config.rs:280`). Reaching 15% needs a 5% pool fee on top, which buyers also pay; refunding it means SOL rebates out of our fee share (DBC splits pool fees with Meteora). Gives the launchpad feeds and instant Jupiter routing, at the cost of a second refund path and a 10% cap.

### 2. Venues with a native sell-only fee

- pump.fun: holder-rewards coins send the creator fee to holders automatically (`pumpdocs/docs/HOLDER_REWARDS_README.md`), but "Fees are computed exactly as before", i.e. the same small creator fee on buys and sells. Cashback coins are deprecated (same file). No transfer-fee option in `create_v2` found. Fails A.
- Heaven: secondary sources only; tiered creator and protocol fees, no sell-only fee. UNVERIFIED.
- LaunchLab platform fees, Moonshot, Boop, LetsBonk: no per-direction fee found.

### 3. Pool-side asymmetry

- DAMM v2: `CollectFeeMode` only decides whether the fee is taken on input or output and in which token; the rate is identical (`state/fee.rs:361-375`). The rate limiter is deprecated: "New configs and pools can no longer use BaseFeeMode::RateLimiter" (`base_fee/fee_rate_limiter.rs:12-13`).
- Atomic SOL rebate from a transfer hook: DAMM v2 refuses mints with a live hook program unless badged (`utils/token.rs:246-257`); LaunchLab rejects TransferHook. Discarded.
- A quote token with its own fee bites both directions, since every swap moves both tokens once. Discarded.

### 3c. Runner-up: plain token, 15% DAMM v2 pool fee both ways, SOL refund to buyers

- Base fee can be set above 15% at creation (`constants.rs:99-105`, max 99% for fee version 1). In OnlyB mode the fee is in SOL. Meteora keeps 20%, so we receive 12% of each side's volume. Refunding buyers their full 15% costs 3% of buy volume from sell fees; refunding 12% leaves buyers at ~3%.
- Best for D: every DAMM v2 integration already models pool fees, there's no tax-token flag, and wallet transfers are free.
- Weakness: anyone can open a second CULT/SOL pool at 0.25%, and Jupiter will route sellers there. The fee only binds while the price gap stays under 15%. Nothing can stop that without a mint-level fee or hook.

## Recommended design

Design 1: Token-2022 CULT, 15% transfer fee with no maximum, config authority revoked, withdraw-withheld authority kept by a dedicated refund/treasury key. One SOL-quoted Meteora DAMM v2 customizable pool holding the whole supply single-sided from launch price P0 to the maximum price, pool fee 0.1-0.25% in SOL (OnlyB), position permanently locked, activation point at T-0. The Worker:
1. watches the pool (Helius webhook) and refunds each buyer's withheld 15% to their own account within seconds (self-harvest, no fee);
2. every round, withdraws withheld tokens from the pool vault (and the mint), sells them for USDC, and runs the existing airdrop.
Our site's buy adds the refund instruction to the same transaction, co-signed by the Worker, so site buys are 0% atomically.

Why: it is the only design found that keeps a sell-only 15% that no second pool can dodge, on a venue every major terminal already reads, with no SOL in.

## Costs against A-D

- A: sellers pay 15.0% (plus the 0.1-0.25% pool fee). Buyers pay the pool fee only, once refunded. Until the refund lands (target under 30 s), terminal buyers see 85% of their tokens, and GMGN probably shows "15% / 15%" tax. We keep 15% of sell volume in CULT, minus slippage when converting.
- B: DexScreener, GMGN, Axiom, Photon, Birdeye, Jupiter and Phantom index DAMM v2 (Meteora's claim plus BERN as a live check). BullX and Padre UNVERIFIED. Jupiter after its grace period: may drop the pool if a $500 round trip loses 30% or more, which the 15% tax brings close.
- C: 0 SOL in the pool. About 0.05 SOL in rent and fees.
- D: sells cannot be blocked on-chain (no hook, no freeze, fee authority revoked). They can fail on a terminal that ignores the transfer fee if the user's slippage is under ~16%. Each terminal must be tested.

## Build steps and hours

| Step | Hours |
|---|---|
| Launch script: mint with TransferFeeConfig (1500 bps, max u64) + metadata, mint supply / 0.85, revoke mint and fee-config authorities, DAMM v2 single-sided customizable pool via `@meteora-ag/cp-amm-sdk`, permanent lock, withdraw the seed's withheld tokens | 4-6 |
| Refund worker: Helius webhook on the pool and mint, ledger of owed refunds in D1, batched self-harvest ixs, wallet-owner and no-delegate checks, top-up from the mint when harvested by someone else, tests | 6-8 |
| Fee sweep: withdraw withheld from vaults and mint each round, sell for SOL/USDC (Jupiter or a direct DAMM v2 swap), feed the existing airdrop (`src/indexer.js`, `src/chain.js`) | 3-4 |
| Site trade: `src/trade.js` builds DAMM v2 swaps via the SDK; buy tx carries the refund ix co-signed by the Worker | 4-5 |
| Indexer: detect sells from DAMM v2 swap events for streak resets; exclude pool vaults, position and treasury from snapshots | 2-3 |
| Drop `programs/paper-pool`, `programs/paper-hook` from the launch path (no program deploys: saves ~4 SOL) | 0.5 |
| Devnet rehearsal (DAMM v2 is on devnet) + mainnet throwaway test coin (see risks) | 4-6 |
| Total | 24-33 |

## Top risks and pre-launch tests

1. **Terminals that ignore the transfer fee fail sells (D).** Test: on mainnet, launch a throwaway Token-2022 mint with the same 15% config and a tiny single-sided DAMM v2 pool (~$20 of test buys). Buy and sell with default settings on Axiom, GMGN, Photon, BullX, Padre, Jupiter/Phantom. Record which succeed, the slippage they need, and how each shows the tax. If one fails at default slippage, publish the needed setting or drop the fee to the largest rate that passes.
2. **Program differs from source (DAMM v2 refuses the mint or the single-sided init).** Test: full devnet run with the SDK; repeated on the mainnet throwaway coin.
3. **Not indexed fast enough, or not shown in "new pairs" feeds (B).** Test: on the throwaway coin, time how long each platform takes to show it. BERN shows that DAMM v2 transfer-fee pools are indexed, not how fast.
4. **Buyers see "15% buy tax" and leave.** Mitigation: refunds under 30 s, said plainly on the site and in the X launch post; site buys are atomic 0%. Test: measure refund latency on the throwaway coin.
5. **Jupiter routing after the grace period, and double tax through router intermediate accounts.** Test: Jupiter quote and swap on the throwaway coin; check which token accounts received CULT and their withheld amounts.
6. **Hot withdraw-withheld key on the Worker.** Worst case: someone drains withheld fees, not user balances. Keep it a separate key from the payout wallet, sweep often.
7. **Securities and tax framing** is unchanged from the current design.

## Runner-up

Design 3c: plain SPL CULT on a single-sided DAMM v2 pool with a 15% pool fee in SOL both ways, buyers refunded in SOL from our fee share. Best possible D and B (no tax-token flags, every terminal handles it), 0 SOL in, but we keep 12% not 15% (Meteora takes 20% of pool fees), and the fee leaks the moment someone opens a cheaper CULT pool. Use it only if the throwaway test shows major terminals failing transfer-fee sells.

## Sources not read in primary form
- Heaven fee model (secondary articles only).
- GMGN/RugCheck thresholds for a high fee; BullX and Padre DAMM v2 coverage; Jupiter grace period length.

## Mainnet test, 16 Nov 2026 (throwaway token TTEST)

Script: `spikes/fee-test/test.mjs` and `jup.mjs`; transaction signatures in `spikes/fee-test/state.json`.
Mint `FyZ6Pr7C8wkc7XvUxF31uvrxYaX27VfkFTWJu581NuXw`, pool `HZWYaGB44DucodnSV2WrezKa8zmAbBPQunfC3bVd4jQn`.

| Check | Result |
|---|---|
| Meteora DAMM v2 accepts a 15% transfer-fee mint, tokens only, liquidity locked | Yes. Pool created with 0 SOL. Cost about 0.03 SOL in rent and fees |
| Buy with Meteora's SDK (fee-aware quote, tight slippage) | Works. 0.02 SOL bought 664,480 tokens: 564,808 usable, 99,672 withheld in the buyer's account |
| Refund: fee authority releases the withheld tokens into the same account | Works. Buyer ended with all 664,480; buyer signed nothing |
| Sell with the SDK | Works. Seller received 85% of the value |
| A client that ignores the transfer fee, tight slippage (simulated) | Fails with ExceededSlippage, as predicted |
| DexScreener | Listed within about 3 minutes, with price, trades and locked liquidity |
| GeckoTerminal | Priced within about 3 minutes |
| Jupiter | Routes buys and sells; quotes already include the 15%. A real buy and a real sell both landed at the default 1% slippage; fee charged once |
| RugCheck | No transfer-fee warning. LP locked 100%. Flags "low liquidity" (it counts only the SOL side, which starts near zero), missing metadata file and mutable metadata (test token had no image) |
| GMGN, Axiom, Photon, BullX, Padre | Not checked: they need a logged-in browser. Kay to try a small buy and sell on each |

## Mainnet test 2, 16 Nov 2026: bonding curve (throwaway token TCURVE)

Script: `spikes/fee-test/dbc.mjs`; signatures in `spikes/fee-test/dbc-state.json`.
Mint `2GHaaCNpbFzNSaSFRACaX7mPLLboUPykykSx9QGKpZPZ`, curve pool `8TDrWn1UhLUz1F6zvpN7aHCAFkWabr8avZp1rEx1Rsu5`.

| Check | Result |
|---|---|
| Meteora DBC accepts a 10% transfer-fee mint (the cap), virtual reserves, 0 SOL from us | Yes, in one transaction. Cost about 0.015 SOL. Requires `MigrationFeeOption.Customizable` and a Compounding-mode graduated pool |
| Buy (SDK quote includes the fee) | Works. 0.01 SOL bought 332,397 tokens: 299,158 usable, 33,240 withheld |
| Refund by the fee key (set to the pool creator) | Works. Buyer ended with all 332,397 |
| Sell | Works. Seller received 90% of the value |
| DexScreener | Listed within minutes as `meteoradbc` |
| Jupiter | Routes it and tags it as launchpad `met-dbc`; quote includes the 10% |
| RugCheck | "Low liquidity $0.00" (danger) and missing metadata file; no transfer-fee warning |
| GMGN, Axiom, Photon, Padre search and feeds | Kay to check |
