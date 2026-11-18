# Build log: curve scripts (CULT on Meteora DBC), 16 Nov 2026

Scope: `scripts/launch-curve.mjs`, `scripts/migrate-curve.mjs`, `scripts/fee-ops.mjs`, `scripts/rehearse-curve.mjs`,
`scripts/lib/curve.mjs`, `scripts/test/*.test.mjs`. Spec: `docs/ROUTE-CURVE.md`. Proven earlier: `spikes/fee-test/dbc.mjs`.

Source references are file:line in the clones under the session scratchpad `met/` (DBC `dynamic-bonding-curve` @ 839d752,
DAMM v2 `damm-v2` @ 18936b18) and `t22/` (token-2022 @ e8ca680c). `DBC/` below means
`dynamic-bonding-curve/programs/dynamic-bonding-curve/src/`.

## Status
- [x] source answers (below)
- [x] `launch-curve.mjs`: dry run simulated against mainnet; real run in the rehearsal
- [x] `migrate-curve.mjs`, `fee-ops.mjs`, `rehearse-curve.mjs` written; read paths run against mainnet
- [x] tests: `node --test "scripts/test/*.test.mjs"` (31 pass), `node --check` on each script
- [x] mainnet rehearsal: all 11 steps done, every assertion read from the chain passed, 0.048980 SOL spent (see "Rehearsal" at the end)

## The three source-backed answers

### 1. Which `MigratedTransferFeeAuthorityOption`: `Immutable`. It does NOT remove our withdraw authority.
- The token's fee has two separate authorities: the **config authority** (can change the rate) and the **withdraw-withheld
  authority** (can take withheld tokens). They are different fields of `TransferFeeConfig` and are changed independently:
  `t22/program/src/processor.rs:889-903` (`AuthorityType::WithheldWithdraw` is validated against `withdraw_withheld_authority`
  and sets only that field).
- At pool creation DBC sets them separately: `DBC/utils/token.rs:513-516` the config authority is `None` when the option is
  `Immutable` (else the pool-authority PDA); `DBC/utils/token.rs:528` the withdraw-withheld authority is
  `config.get_transfer_fee_withheld_authority(creator)`, i.e. the partner (fee wallet) when `TransferFeeWithheldAuthority.Partner`
  (`DBC/state/config.rs:439-450`). The option only decides the first.
- At graduation `apply_transfer_fee_authority_option` returns early for `Immutable` (`DBC/instructions/migration/dynamic_amm_v2/
  migrate_damm_v2_initialize_pool.rs:362-376`) and otherwise touches only `AuthorityType::TransferFeeConfig` (`:405`). Nothing
  in DBC ever sets `WithheldWithdraw` after creation (grep of `DBC/`: the only mention is `utils/token.rs:453,465,528`).
- The other options would be worse: `RevokeZeroFee` schedules the fee to 0 (`:380-392`, `should_zero_fee`), `Creator`/`Partner` leave a key that can
  change the rate (`state/config.rs:465-497`). `Immutable` is the only one that keeps 10% for good.
- Config used: `transferFeeBasisPoints 1000` (cap `DBC/constants.rs:82`), `withheldAuthority Partner`,
  `migratedTransferFeeAuthorityOption Immutable`. Read-back after launch and after migration asserts: fee 1000 bps, config
  authority none, withdraw-withheld authority = fee wallet, mint and freeze authority none.
- What a transfer-fee config forces (`DBC/state/config.rs:825-855`, checked again at migration `migrate_damm_v2_initialize_pool.rs:927`):
  constant token supply (pre == post), no locked vesting, `MigrationFeeOption.Customizable`, migrated pool in `Compounding`
  collect-fee mode. `compoundingFeeBps 0` means the whole trading fee of the graduated pool is collected in the quote token (SOL):
  `DBC/instructions/partner/create_config/process_create_config.rs:170-172` ("compounding_fee_bps = 0 collects the whole trading
  fee in quote token") and DAMM v2 `params/fee_parameters.rs:260` ("acts the same as CollectFeeMode::OnlyB (quote only fee)";
  split in `state/fee.rs:206-214`: only `compounding_fee_bps > 0` keeps part of the fee inside the pool). So fees are claimable SOL.
- The proof is on chain, not only in source: the rehearsal sweeps the DAMM v2 vault's withheld tokens after graduation.

### 2. Who migrates: nobody does it for us for certain, anyone may. The script is the manual path and the checker.
- The instruction is permissionless: `MigrateDammV2Ctx` has `payer: Signer` and no other signer (`migrate_damm_v2_initialize_pool.rs:128`).
  Conditions: curve complete (`:552`) and migration progress `LockedVesting` (`:547`); with no vesting configured the final swap sets
  `LockedVesting` itself (`DBC/instructions/swap/process_swap.rs:360-364`). No on-chain keeper exists in the program.
- Meteora runs an off-chain keeper (docs.meteora.ag/core-products/dbc/migration-and-liquidity, read 16 Nov): it migrates a complete
  pool when the quote-side threshold is one of a short list (SOL: 10 SOL; USDC 750; ...) or the quote token is Jupiter Verified with
  Jupiter Organic Score above 50 and notional value above 750 USD. SOL is Jupiter Verified and a 85.99 SOL threshold is far above
  750 USD, so the real CULT curve probably qualifies. The docs do not say whether the keeper handles a transfer-fee token on the
  Customizable fee option; no source for that. The tiny rehearsal curve (0.016 SOL) qualifies under neither rule, so the rehearsal
  proves the manual path.
- Order (SDK `MigrationService.migrateToDammV2`, `dist/index.js` ~20028): no locker step (no vesting) -> one `migration_damm_v2`
  instruction with two fresh position-NFT keypairs as extra signers and the DAMM v2 config `DAMM_V2_MIGRATION_FEE_ADDRESS[6]`
  (`A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck`, exists on mainnet and devnet) as the one remaining account -> optional
  `withdrawLeftover` afterwards. `scripts/migrate-curve.mjs` runs exactly that; if the pool is already migrated (keeper won the
  race) it sends nothing and reports. The payer pays the DAMM v2 accounts' rent: pool 0.0063, position 0.0027, two vaults 0.0030,
  NFT mint 0.0030, NFT account 0.0015 = about 0.017 SOL (measured from an existing pool's account sizes).

### 3. Locked-liquidity fee claims: the fee wallet owns the position NFT; it signs and claims.
- With `partnerPermanentLockedLiquidityPercentage 100` the first position's owner is `config.fee_claimer`
  (`migrate_damm_v2_initialize_pool.rs:1012-1022`, partner liquidity > creator liquidity) and all of it is permanently locked
  (`:1102-1108`); the creator's share is 0 so no second position is made (`:1063`, `split_liquidity_for_second_position > 0`).
- Locked liquidity still earns fees: `Position::get_total_liquidity` counts `permanent_locked_liquidity`
  (damm-v2 `state/position.rs:157-162`, used by `update_fee` at `:250`), and `claim_position_fee` needs only the NFT owner's signature
  (`instructions/ix_claim_position_fee.rs:75-95`). `fee-ops.mjs claim` uses `CpAmm.claimPositionFee` for it.
- Dead liquidity: compounding pools keep `DAMM_V2_COMPOUNDING_DEAD_LIQUIDITY = 100 << 64` in the pool itself
  (`DBC/migration_handler/compounding_liquidity.rs:14,84-88`), negligible (about 100 raw units of sqrt(base x quote)).

## Findings Kay should know (from source; the rehearsal measures them)
1. **About 10% of the SOL raised at graduation does not reach the DAMM v2 pool; it is booked to Meteora.** The 10% transfer fee also
   applies to the base-token deposit into the pool, so DBC deposits fee-net base and scales the SOL side down by the same 10% to keep
   the price (`DBC/migration_handler/compounding_liquidity.rs:167-200`, `get_migration_deposit_amounts`). The undeposited SOL is added to
   `protocol_migration_quote_fee_amount` (`migrate_damm_v2_initialize_pool.rs:1152-1165`), which only Meteora's protocol-fee authority
   can claim (`DBC/instructions/operator/ix_claim_protocol_fee2.rs:45`). For the real curve (30 -> 400 SOL): raise 85.994 SOL, pool
   gets about 77.2 SOL, about 8.76 SOL (8.58 + the 0.2% protocol migration fee 0.17) goes to Meteora. The 10% of the graduated
   tokens (about 21.5M of 215M) is withheld in the DAMM vault and is ours to sweep. Price is unchanged.
2. **Leftover tokens: none for this curve.** Supply splits 785.0M sold on the curve + 215.0M to the pool = 1,000M exactly
   (verified against the stored config of the mainnet spike: `swapBaseAmount 785014833782499`, `migrationBaseThreshold 214985166217501`).
   `withdraw_leftover` needs the leftover receiver (fee wallet) to sign when a fee applies (`withdraw_leftover.rs:112-114`);
   `migrate-curve.mjs --fee-keypair` does it if anything is left.
3. Anyone can migrate and pays about 0.017 SOL of rent; the fee wallet only needs SOL for its own sweeps and claims.
4. Metadata is immutable by default (`--token-authority immutable`): name, symbol and uri can never change after launch.
5. The graduated pool's liquidity is 100% permanently locked, but a sliver of unlocked dead liquidity stays in the pool itself.

## Design of the scripts (what was reused, what is new)
- Ported from `scripts/launch.mjs` (this repo): key loading (JSON array / Phantom base58 / env), base58, the settle loop, transaction
  sizing and step grouping, mint-key-saved-first, pending-signature file, resume, the Refuse/Exit pattern. Now in `lib/curve.mjs`
  and covered by tests with a fake chain (a signature is on disk before the broadcast; an unknown outcome is settled from the
  signature; nothing is sent twice; a preflight refusal clears the pending file).
- Ported from `spikes/fee-test/dbc.mjs`: the curve and fee settings, the swap and refund calls (proven on mainnet 16 Nov).
- `launch-curve.mjs`: one transaction when it fits. The config + curve pool did fit in the spike; with a team buy the pool + buy
  go in a second transaction (config + pool + buy exceeds 1232 bytes), so it is 2 transactions: config, then pool + first buy
  (price known, nobody can trade in between). Refusals before any send: bad name/symbol/uri lengths, `--uri` missing or unusable
  (reachable, JSON, name + symbol + image, image fetchable), creator SOL too low, fee wallet below 0.01 SOL, wrong `--fee-keypair`,
  programs missing, unknown cluster, a finished launch in the state dir, a first transaction that fails when simulated against
  the real programs, a stored config that differs from the flags on resume. `--allow-missing-uri` is accepted only for the name
  "Tithe Rehearsal". Ends with a read-back of the mint, the config and the pool.
- `rehearse-curve.mjs` imports the three scripts' functions: nothing is re-implemented. A budget guard compares the two wallets'
  balances to their start before every step and stops over the cap.
- No `check` or `build` script exists in this repo (`package.json` has `dev`, `deploy`, `test`, ...), so the gate for these files is
  `node --check` on each file and `node --test "scripts/test/*.test.mjs"`. package.json scripts are the other agent's; I touched
  only `dependencies` (added `@meteora-ag/cp-amm-sdk@^1.5.1`, `bn.js@^5.2.5`; lockfile diff checked: 6 packages added, none removed
  or changed). `@meteora-ag/dynamic-bonding-curve-sdk@^2.0.0` was already added by the other agent.
- RPC: I must not read `~/.cult/*.vars` (or `~/.coined-preview/*.vars`, which `dbc.mjs` reads). The scripts take `--rpc` or
  `SOLANA_RPC_URL`. The rehearsal used the public mainnet-beta endpoint, which rate-limits (429); a keyed RPC is better for launch night.
- Devnet was not usable for a free dry run: the public devnet faucet is closed (410 Gone) and there is no local validator on this
  machine. Both DBC and DAMM v2 and the Customizable migration config exist on devnet, so a funded devnet run is possible later.

## The launch command frz runs
Run it as a dry run first (no `--go`): it prints the plan and cost, simulates the first transaction against the real programs and
runs every refusal. The same line with `--go` sends. `<CREATOR_FILE>` is the key that becomes creator and payer; the fee wallet
defaults to `HrEKXpJvACWNxQJgQGhqNmJgQpwgC6kjtPD4dyDK2AH5`. `--uri` must already serve the metadata JSON (name, symbol, image) because
the metadata is immutable. Add `--team-buy <SOL>` only if a team buy is wanted; add `--fee-keypair <file>` to also refund that buy's
withheld 10% in the same run.

    node scripts/launch-curve.mjs --rpc <KEYED_RPC_URL> --keypair <CREATOR_FILE> --uri https://<domain>/token.json --name Cult --symbol CULT [--go]

Then, in this order, each also a dry run until `--go` is added:

    node scripts/migrate-curve.mjs --rpc <URL> --mint <MINT> --keypair <ANY_FUNDED_FILE> --fee-keypair <FEE_FILE> [--go]   # after the curve completes
    node scripts/fee-ops.mjs status --rpc <URL> --mint <MINT>
    node scripts/fee-ops.mjs sweep  --rpc <URL> --mint <MINT> --fee-keypair <FEE_FILE> [--go]
    node scripts/fee-ops.mjs claim  --rpc <URL> --mint <MINT> --fee-keypair <FEE_FILE> [--go]

The launch prints the wrangler vars (MINT, EXCLUDE = creator). Use a keyed RPC: the public endpoint answered 429 during the rehearsal.

## Log
(newest last)
- Read the spec, research, `dbc.mjs`, `launch.mjs`; read DBC and DAMM v2 source for the three answers (above).
- Start balances (mainnet): deployer `KDpz3ic...` 0.202346 SOL, trader `ECFmvyQ...` 0.036765 SOL.
- Mainnet dry runs (simulation only, nothing sent): launch plan for the rehearsal coin simulated, config transaction costs 0.006 SOL;
  `migrate-curve` on the spike's pool says "not complete"; `fee-ops status` reads the spike's pool.
- Rehearsal curve sizing: the DBC curve builder makes `threshold ~= mcap_start/2 + small`, because it must fit 100% of supply into
  curve + pool. So "start mcap 0.5 SOL" cannot graduate on 0.05 SOL: 0.5 SOL start needs 0.26 SOL. Used start mcap 0.03 SOL,
  graduation mcap 0.033 SOL: threshold 0.0161 SOL. The budget, not a program minimum, is the limit: fixed costs are about 0.015 (curve
  config, pool, mint) + 0.017 (DAMM v2 accounts) + token account rent 0.004 = 0.036 SOL before the graduation SOL itself (which is
  spent for good: it goes into the locked pool). The only program minimums met were `migration_quote_threshold > 0`, curve price
  above `MIN_SQRT_PRICE`, and migration liquidity above the dead-liquidity floor (`compounding_liquidity.rs:35`), all far below this.

## Rehearsal (mainnet, 16 Nov 2026, "Tithe Rehearsal", mint `EGrdXcRVQcyN31LmWrRzXTDbJTNi8wp3qbdTNpFviyMS`)
Wallets: `deployer.json` (creator, fee wallet, `KDpz3icbjmmib1DDeitywpk6ZdsQckHiqt6hKmKnnaq`) and `test-trader.json` (trader,
`ECFmvyQo7w1YtuAZbtkPxrbg1NX9ghF1rEECCRqNQg22`). Nothing else was signed. Curve pool `sWjsX59B13zT4bVgoXgxcR6ejKSDSuTc2j8vsNKoPMU`,
DAMM v2 pool `FoNgzZ3AFVFxKjTeZFUxcfk8K41pu7N39wCXETpw6reL`, locked position `26w8c9LGG47ZsgtDSogWx8ptag5uomWrvmALauzJ8nxN`.
Curve: start 0.03 SOL, graduation 0.033 SOL, threshold 0.016107 SOL, pool fee 25 bps, compounding fee 0 (fees in SOL).
**Spent 0.048980 SOL of the 0.075 SOL cap** (both wallets 0.239111 -> 0.190131 SOL). That includes rents that stay in the chain's accounts
(about 0.0166 migration accounts, 0.0150 curve config/pool/mint, token accounts) and the 0.0145 SOL that is now the locked pool.
Two processes ran: `run1.log` (steps 1-11, stopped by a crash in step 11) and `run2.log` (resumed; steps 1-10 skipped as done, step 11 finished).

| Step | Result | Signatures |
|---|---|---|
| 1 launch: config + pool + 0.003 SOL team buy in ONE transaction, then refund of the team buy's withheld 10% | PASS: fee 10%, config authority none, withdraw authority = fee wallet, mint and freeze authority gone, stored config = plan | `5YAtXVZZim8cPKzPgK8bisZ2aEwrRzghmgU3MzMCMMhT5jSBSimFuUvfqF4oXUMFhsicpAuUx2iVduQBWDMDMUsA`, refund `2pbPHkgGKa5oMhTCs44tq67tNpcEfdYy5dP64YmPLxDEEwVyc6YGohfTprjEPGaCyXSEbirMbcDNAunTWyvyCUQn` |
| 2 buy on the curve (0.004 SOL) | PASS: 10% of what arrived is withheld in the buyer's account (12,907,370.735792 of 129,073,707.357913) | `3cnEaMq3YgytAbJFTkFFSJbLPYVHeNotxVUsPqeamids8rwQy93SnapcjDHSuJ3PEW5fAyQ2yCzR9A5yzWb7riFE` |
| 3 refund the buyer (self-harvest) | PASS: buyer ends with every token, nothing withheld, no fee paid | `5yZiyE51cwxKawbm8XzAgHs7a3VCuaPjeVe7ztnWaNm8miYRPtr6JiX7HjW81LhofjT1TSnAUs8QWVGLrpUmQrjg` |
| 4 sell half on the curve | PASS: 10% of the sold tokens is withheld in the curve's base vault (6,453,685.367896) | `2ECRQHA99nMn2Bw5oFgf1Xok4jVxCg82vfG7EaRbXc2GKs8Qbzft9uq2diBrqQwPTSbyK9getTAdhGJvNWBU6jaf` |
| 5 sweep the curve vault to the treasury | PASS: vault withheld 0, treasury gained exactly 6,453,685.367896 | `3HyrzaNxN7TPTCKKnANDZaxW6wLcTYofGaWEHmZdwYLTcfGPSGnmnppCxv9y7jfPk7wb6sYhFsPeT6d52fyRQ1zB` |
| 6 buy through to graduation | PASS: curve complete (0.016107 of 0.016107 SOL), not migrated | `3ZnoUpjzq3BerSNqrGZs1ErKQMSUsCZVuuuiPsxZP6yPWFNNQoABuZpNKtPLdfyXyRdrf5FmGXHNxYXQo1zhTPjy` |
| 7 refund the graduating buyer | PASS: refunded in full (34,206,740.926059 withheld -> 0) | `579ndQZwu4XS8tbvM81SVWWkkuaTTwWZfuEeYw3YArE18eLGKkyxdeQTHpgRL9mKjW4FTYakAbTZ7PTWgPbPf3Yg` |
| 8 migrate (the script, fee wallet as payer) | PASS: migrated; position locked, owned by the fee wallet, unlocked 0; withdraw authority still the fee wallet; pool SOL 14,467,235 = plan; 48,711,227.763637 tokens withheld in the DAMM vault = plan; 1,639,684 lamports booked to Meteora = plan; cost to the payer 0.016641 SOL | migrate `2Dm8NE3baBKWowLu2MvVkAtTdKRh7UdFNDKrFCLDcqNUptjewLoJa6ocF9pSK46gRjoZXqohQRcrfKB6UEqsT6e4`, leftover `2G5X4mNNDfMiKuay6ppE3Z5DAqpxyySNUoqt85FqaD61qvSA8cJzShiyQ6ZrqBPBLzMD2BZpZ3Hv1jtBJgmy3pNX` |
| 9 buy, refund, sell on the DAMM v2 pool | PASS: buy withholds exactly 10% in the buyer's account (5,312,827.173808), refund makes the buyer whole, sell withholds exactly 10% in the DAMM vault (15,324,417.822588) | buy `arMcVPcD8oLKpwwA1XFVN6f5CMHvJWKhjZAsGKeQCu3SV1ez4fmc5vNi7S57mLuUqMureNBiRs6SxEnoEPYkV7Q`, refund `5KhKqbWfktfphvCmUxon5kQ3rsjNQ8tyGaL7mCUeUviqpyx7DBynL2Wr4Lu93qShjrTtPT3bXziwKDotvS7BYCLz`, sell `3E79a7nLvoUhwkp9yLNU7t9u8p86jjgS8vYHgMwJu8uTE8ykb1EBWTEfvdWLvULWa13kb3xpM6jbj3UCaVaU31uT` |
| 10 sweep after graduation (the DAMM vault) | PASS: vault 64,035,645.586225 -> 0 and treasury gained exactly that; the pool still trades after the sweep; refund of the new buyer | sweep `2wzuyBta3JwKMw3q1GTpdubuMf4TgmWNymY8Kcvtw16nE8mjSaNn9emJVQiihKdMYxTT9nERygF9JASLcJ4QQCu8`, buy `5XPkDpLy3qUhwVG1oh1Dx52RSZLAcWoadbo6qNs7y8uKWjNH8LrDi5LhbtxRjRoPVS7bqcovZsWL2QicHkHDeJQh`, refund `4oeWXnRNweJyfQvAjgsNyZfmkWz92AXh2uHKEgdNCaLH6edNxQiWLepTqXrcApasHSzUQngivjtVA7Jvaa4bYRqx` |
| 11 claims | PASS, read from each transaction: curve partner fees 39,535 lamports; the surplus withdrawal paid 0 (see failures); locked position fees 14,679 lamports of SOL and 0 tokens | curve fees `WZ7hpMULMmQD2bhDMyLhxTTznPAoMoSYhLHrPgPP88A7Pcq7zsGLyniPKdLRZi9nCU3d9xZUf6UKEe9ysNnpkPx`, surplus `5sh9rPUNmLcSuy5UPwpqCeXJEe3gJWh2PrzDZz9eioFvKxXKqeJfxzGpZKniPcfbQ4VTEAmScdYHhwyaqiRcyPpT`, position `2c76aXCAhCbupfRSSZFvk2mUNmUvvUMj8CNct6U9iduRCfajssGLB52p7bvtPEHBjj9stPoTGqzow1j3h28T8KUA` |

Facts the run measured (a coin on the real design will behave the same way, at its own scale)
- The plan function predicted the pool SOL, the withheld tokens and Meteora's booking to the lamport and the raw unit. Finding 1 above is
  confirmed on mainnet: 1,639,684 of the 16,106,920 lamports raised (about 10.2%) did not reach the pool.
- The locked position's fees are in SOL only: 14,679 lamports of SOL, 0 tokens (compounding fee 0 means the pool's fee goes to the quote side).
  The token side of a pool trade is the 10% transfer fee, which sits in the DAMM vault and is swept, not claimed.
- Every transfer fee ended in one of three places: a buyer's own account (refunded by the buyer, no fee), the curve's base vault or the
  DAMM vault (swept by the fee wallet). After the sweeps nothing was left withheld anywhere (`fee-ops status`).
- Leftover: `withdraw_leftover` returned 3 raw units (0.000003 tokens): rounding dust, as predicted. It cost 0.0000253 SOL in fees.
  The 976,176.909090 tokens left in the curve vault are Meteora's migration-fee share of the base side, not ours.
- Markets. DexScreener listed the curve pair once the first buy had landed (not at the launch itself) and kept listing ONLY the curve
  pair for about 8 minutes after migration; at 05:38 UTC it also listed the DAMM v2 pair (dex "meteora", pair `FoNgzZ3A...`). Jupiter's
  token page knew the coin from the launch (`launchpad met-dbc`); its quote said "Dynamic Bonding Curve" before completion, "No routes
  found" between completion and migration, and "Meteora DAMM v2" after migration. Jupiter's audit then showed `isSus: true` (dev balance
  10.5%, a migration by the dev wallet, organic score 0, 4 holders). A real launch should expect a short window with no Jupiter route
  after the last curve buy: run the migration at once (any wallet may).

What failed or was fixed during the run
1. Step 11 crashed after two claims: `CpAmm.claimPositionFee` with `receiver` set and a SOL side reads `tempWSolAccount` and throws
   `Cannot read properties of undefined (reading 'toBuffer')`. Fixed: no `receiver` (the owner is the fee wallet already). Nothing was
   in flight at the crash; step 11 re-ran from the saved state and the position claim landed.
2. The surplus withdrawal paid 0 and cost a 65,300 lamport fee: I had used reserve minus threshold, which includes Meteora's share
   (`getSurplusBreakdown` in the SDK: partner = the partner-and-creator share less the creator part, protocol the rest). Fixed: the
   step is built from the SDK's `getPoolSurplus` partner amount and only when it is above 0 and not yet withdrawn. Not re-run on mainnet.
3. The claim assertion only counted transactions and the received figure was a balance difference that included fees. Fixed:
   `grossGain` reads what each claim put into the wallet from its own transaction (39,535, 0 and 14,679 lamports, checked against the three
   real transactions). The mutation "claim ignores a failed send" survives: the whole `claim` function needs a chain, so only the
   rehearsal itself covers it.
4. Public RPC 429s at the start (fixed before the run, see the log above).

The re-run `run2.log` used the fixed `fee-ops.mjs`; the other four scripts ran unchanged from the first run. The check text of step 11 in
`rehearse-curve.mjs` was reworded after the run (SOL put in the wallet, from the transactions), so the run2 line shows the older wording.
