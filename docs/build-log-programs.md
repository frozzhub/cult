# Build log: on-chain programs and launch script (16 Nov 2026)

Scope: `programs/`, `programs-tests/`, `scripts/launch.mjs`, `Anchor.toml` (plus the ids and launch arguments in `test/programs.e2e.mjs`). Branch `kay/launch-prep`. No mainnet transaction was sent; every transaction below ran in LiteSVM or on a local validator with throwaway keys. Nothing in `program-keys/` was read.

Decisions that arrived while building: buy fee ships at 0% (the capability stays, `--buy-fee` defaults to 0; Kay briefly said 1%, then changed it back). frz launches from his own wallet, so the script's creator is whatever key it is given, never assumed to be the deployer.

## What changed

### paper-pool (`programs/paper-pool/src/lib.rs`)
- `initialize(fee_bps, buy_fee_bps, token_amount, virtual_sol)`. No SOL moves in: the creator pays only the pool account's rent. `sol_reserve` starts at `virtual_sol` and still means "curve SOL including the virtual part". Refuses `fee_bps > 2000`, `buy_fee_bps > 500`, `virtual_sol == 0` (and `token_amount == 0`).
- Account layout (borsh, unaligned, 125 bytes): disc 0..8, mint @8, vault @40, payout @72, fee_bps u16 @104, sol_reserve u64 @106, bump u8 @114, **virtual_sol u64 @115, buy_fee_bps u16 @123** (appended; the old offsets did not move). A test pins every offset.
- `buy`: `fee = floor(sol_in * buy_fee_bps / 10000)` goes to the payout wallet by system transfer from the user; `sol_in - fee` goes into the pool and is what the curve prices (`sol_reserve += net`). `Traded.fee` carries the fee; for a buy `Traded.sol` is what the user paid (fee included), for a sell it is what the user received (fee excluded).
- `sell`: same maths. New guard before any lamport moves: real SOL (`pool lamports - rent_exempt_minimum(data_len)`) must be `>= gross`, else `PoolShort` (6006).
- New errors appended after `Overflow` so existing codes are unchanged: `BuyFeeTooHigh` 6005, `PoolShort` 6006.
- Invariant held after every trade: `pool lamports - rent == sol_reserve - virtual_sol`.

Why the guard cannot trip in honest use: sells and buys only move `sol_reserve` by exactly what moves in or out of the pool's lamports, so the invariant above holds. Both directions round in the pool's favour, so `k = sol_reserve * token_reserve` never shrinks. If `X` tokens are outstanding then `token_reserve + X = SUPPLY`, and selling any `q <= X` returns `gross <= q*s/(t+q) <= X*s/(t+X) = s - t*s/SUPPLY <= s - virtual_sol`, because `s*t >= k0 = virtual_sol*SUPPLY`. That last step is "k never shrinks". Donated tokens or SOL only make it larger. The property test runs it for thousands of trades and a full sell-back.

### paper-hook (`programs/paper-hook/src/lib.rs`) - review finding A1 / "13"
- Authority check first: the account that moves the tokens must be on the ed25519 curve or the pool PDA (the pool signs every buy). A program address acting as delegate or owner is refused.
- Destination: the pool PDA is allowed as before. Anything else must be owned by an on-curve wallet AND be a token account with the `ImmutableOwner` extension (every associated token account has it). A plain token account whose owner could later be handed to an escrow is refused.
- Same error (`OtherPool`, 6001) for all three refusals.

### Program ids (new mainnet ids everywhere)
pool `5xsG4XWGVdazEZSDkjFWu25gCyeCnTuxuPxbmJ1xmA4D`, hook `521AkYhN31VTGPLn75NgeWievYHZoxPwREihCCsppxnF`: both `declare_id!`, `POOL_PROGRAM` in the hook, `scripts/launch.mjs`, `Anchor.toml` (mainnet and localnet), `programs-tests`, `test/programs.e2e.mjs`. `wrangler.jsonc`'s devnet env was left alone. I could not check that `program-keys/mainnet/cult_*-program.json` really are these addresses (I may not read them). A wrong key shows up at deploy as an address mismatch, before any money moves: run `solana-keygen pubkey` on each before the first deploy.

### scripts/launch.mjs (review findings 1 and 12, plus frz's own wallet)
- Flags: `--virtual <SOL>` (default 30, replaces `--sol`), `--buy-fee <bps>` (default 0, max 500), `--team-buy <SOL>`, `--keys-dir` (default `program-keys/mainnet`), `--mint-keypair`, `--new-mint`; testing knobs `--split` and `--max-txs`.
- Creator key: `--keypair <file>` holding a solana-keygen JSON array or a Phantom base58 secret, or the `CREATOR_KEY` env var (base58). Both set, or neither, is refused. The secret is never printed. The plan prints the creator and says to put it in `EXCLUDE`.
- Checks before anything is saved or sent: both programs deployed; payout wallet holds at least 0.06 SOL; creator holds enough for the steps still to do (accounts' rent, 0.003 SOL of fees, plus `--team-buy`). Each refusal says what is short and by how much.
- The mint key is generated and saved to `<keys-dir>/mint-<pubkey>.json` (exclusive create, read back) before the first send.
- Steps (mint + metadata + hook, hook account list, supply, pool, team buy, revoke mint authority, revoke transfer-hook authority) are packed into as few transactions as fit 1232 bytes. With no team buy everything is one 986-byte transaction; with a team buy it is still one.
- Each transaction is signed and its signature written to `launch-<mint>.pending.json` before it is sent. An unknown outcome is settled only from that signature's status (searched with history; "expired" only after the blockhash is past by 5 blocks and a second look finds nothing). Nothing is resent from a guess.
- Re-run after a crash: finds the unfinished `mint-*.json`, reads the chain, does only what is left. A finished launch in the keys dir is never resumed or repeated (`already launched here`); `--new-mint` is the explicit way to launch another. More than one unfinished key is refused and listed.
- The team buy is priced from the virtual seed when it shares the pool's transaction; on a re-run it is priced from the live pool with 1% room.
- Ends by reading the chain: pool exists, mint authority null, hook authority null, supply exact.

### Tests (`programs-tests/`)
- `tests/common/mod.rs`: shared LiteSVM launch that follows the script's grouping (mint + hook list, then supply + pool + optional team buy + both revokes in one transaction).
- `tests/pool.rs` (9), `tests/hook.rs` (1, new), `tests/property.rs` (2, new), `tests/review_hook.rs` (5): 17 tests.
- `rehearse.mjs`: the full rehearsal against a local validator (see results below).

## The 3 review tests that failed
- `review_creator_cannot_switch_off_the_hook_after_launch`: premise right; its `launch()` helper copied the old script (hook authority left with the creator). The helper now launches the way the new script does (revoke in the launch transaction), so the creator's `UpdateTransferHook` is refused. I added a second assertion that repointing the hook is refused too.
- `review_cult_refused_into_accounts_whose_owner_can_change`: no change to the premise. Passes on the new hook, and now also asserts the refusal is the hook's own error and that an associated account still works.
- `review_small_sell_works_before_payout_wallet_is_funded`: premise wrong for the programs. A fee that lands in an unfunded wallet below rent exemption fails in the system program and the pool cannot prevent that; the fix is operational, and the script now refuses to start unless the payout wallet holds 0.06 SOL. So the test launches with a payout wallet at 0.06 SOL (renamed `review_small_sell_works_once_the_payout_wallet_is_funded_as_the_script_requires`), and a new test `review_small_sell_fails_while_the_payout_wallet_holds_nothing` records why the gate exists.

## Results

Build (WSL, Solana 3.1.10): both programs build clean (warnings are the existing Anchor cfg and `realloc` ones).

LiteSVM, `cargo test --no-fail-fast` in `programs-tests` (run in WSL): **18 passed, 0 failed**.
- `hook.rs` 1, `pool.rs` 10, `property.rs` 2, `review_hook.rs` 5.
- `property.rs`: 2,500 random buys and sells per run, six traders, amounts from 1 lamport to ~34 SOL (dust included). Buy fee 0: 1,602 buys, 887 sells, 11 refused for rounding to nothing. Buy fee 100 bps: 1,617 buys, 876 sells, 7 refused. After every trade the chain matched the model: `pool lamports == rent + sol_reserve - virtual_sol`, the payout wallet got exactly the fees, k never shrank, tokens were conserved. Then every holder sold everything back in a shuffled order: no sell hit `PoolShort`, the only failures were dust sells whose SOL rounded to zero (`Slippage`), and 359 / 374 lamports of real SOL were left in the pool.
- The pool starts with zero real SOL (`launch_puts_every_token_in_the_pool_with_zero_real_sol_...`), and both authorities are null after the launch transaction, on the mint itself (same test, `mint_state()`).
- Compute units (LiteSVM): first buy into a new token account 67,032; later buy 39,817; sell 36,775 (the Worker asks for 200,000); the supply + pool + team buy + revokes transaction 124,989 (152,384 to 161,384 on the validator, with metadata).

Rehearsal on a local validator (`solana-test-validator` in WSL, programs loaded at the new mainnet ids, throwaway keys, `node programs-tests/rehearse.mjs`): **passed**, three launches.
- Refusals before anything is sent or saved: payout wallet at 0 and at 0.059 SOL, creator wallet empty, `--keypair` and `CREATOR_KEY` both set, neither set, `--buy-fee 501`.
- Dry run: prints the creator (with the EXCLUDE reminder), the mint, the pool, the fees and the transactions it would send; writes nothing; never prints the secret.
- Launch 1 (buy fee 0, virtual 30, no team buy, creator key as a base58 file): one transaction per step, stopped after each (`--split --max-txs 1`), re-run each time. A dead signature (never landed) was left behind before step 3 and settled from its status. Step 4 gave the same key as `CREATOR_KEY`. A re-run never made a second mint (still one `mint-*.json`). Another creator's key on the unfinished mint was refused with nothing sent. After the last step a re-run said `already launched here, nothing was sent`; the same mint key with other settings was refused.
- Launch 2 (buy fee 100, virtual 20, team buy 1.5 SOL): the whole launch was ONE transaction of 1,020 bytes, 152,384 compute units: `mint + hook list + supply + pool + team buy + revoke mint authority + revoke hook authority`, signature `51ot7SiLjng8hWqErSA1k5s6cKNhK7qfFRJc3RnTgijbTKepEPUL1SK2jLbM94kW3BKMCCqJ2XVVWGN4QfAvgsqS`. Without a team buy it is one 986-byte transaction (seen in the e2e run).
- Launch 3 (buy fee 100, virtual 25, team buy 0.5 SOL): crash and resume at every one of the 7 steps, so the team buy ran exactly once (creator holds exactly what it bought).
- From the chain after each launch: mint authority null, transfer-hook authority null (hook program unchanged), supply exact, pool layout 125 bytes with the right fee, buy fee and virtual SOL, pool lamports = rent + the team buy's net, nothing else. The creator's `UpdateTransferHook`, `MintTo` and `SetAuthority(TransferHookProgramId)` were refused.
- Trades, launch 1 (buy fee 0): buy 2,000,000,007 lamports gave 62,500,000,205,078 tokens, payout unchanged (`2bf4aPrxDYoA6Y1QhXoG6KCeHu1e89qSvzxVxCmE2AsdMCAT1zqpVudSRv9y5kgWENrNJS1fkhA5LztQGa8FgqAd`); sell of half: gross 1,032,258,068 lamports, 877,419,358 to the seller, 154,838,710 (15.000%) to the payout wallet (`21nSPLhhDE9nXVis8cUAamakWxoh6ipUtZQMma91FW4VhBALd9g7d3sjoqDVXtNKfynU9PsSoxLEko1mXjN5cRrv`); then the rest sold back; wallet-to-wallet transfer worked, a transfer into another program's account was refused. Launch 2 (buy fee 100): the same buy paid exactly 20,000,000 lamports (1%) to the payout wallet (`5uXNnSEmGY91XwYdSm86hwmB5xrZAjBpnsik1mE5r6CEN2BYUEk5AxuRHJEL4ivf9U1L6dkUhGXCsaDsCQUfmgPm`), sell paid 15.000% (`6QuiPUgdm6JcCwRH1e2XyceEG1kq4L3VVFmNXvAzUnbw6fvWzh3ByzdqM98NK9PoB3WhBo94rubGxbQGvj5uZrM`).

Mutation pass (one guard changed at a time, tests must go red; run on throwaway copies of the sources, restored after each):
- programs: 18 of 18 killed (sell guard removed and off by one, buy fee unpaid, priced on gross, booked into the curve, rounded up, sell fee rounded up, both fee caps, cap constant, `virtual_sol` 0 allowed, curve off the seed, field order swapped, hook authority check, ImmutableOwner check, destination on-curve check, pool PDA as authority, pool shortcut).
- launch.mjs: 14 of 16 killed. Survivors: `J15` (hook authority belongs to someone else): the mint-authority check refuses first on every flow the script can produce, so the guard is a second line only; `J16` (programs-deployed check): the rehearsal's validator always has the programs, so it was checked by hand instead: a read-only dry run against devnet printed `REFUSING: The pool program ... isn't deployed on this cluster.` (and the same for the hook). No transaction was sent.

Program sizes and deploy cost (local validator, `solana program deploy` with throwaway keys; mainnet fees may differ a little):

| Program | `.so` bytes | ProgramData rent (45 + bytes) | Program account rent | Deployer balance fell by |
|---|---|---|---|---|
| paper-hook | 226,528 | 1.57783896 SOL | 0.00114144 SOL | 1.58012040 SOL |
| paper-pool | 318,400 | 2.21726808 SOL | 0.00114144 SOL | 2.22000452 SOL |
| both | | | | **3.80012492 SOL** |

The CLI's default `--max-len` here equals the program size, so the cost above leaves no room to upgrade to a bigger program without `solana program extend`. With `--max-len` at twice the size the rent would be 3.15447384 SOL (hook) and 4.43333208 SOL (pool), 7.59 SOL together. The deployer keeps the upgrade authority until Kay decides (B2).

The creator (frz) needs about 0.014 SOL for a launch with no team buy (rent for the mint, hook list, two token accounts and the pool, plus 0.003 SOL of fees; the script computes it from the cluster and says how much is short), plus the team buy. The payout wallet needs 0.06 SOL.

## What was not verified
- That `program-keys/mainnet/cult_pool-program.json` and `cult_hook-program.json` are the keys for `5xsG...` and `521A...` (I may not read them). Run `solana-keygen pubkey` on each before the first deploy.
- Nothing ran on mainnet or devnet except the read-only dry run above. The launch script has never sent a transaction to a real cluster; the local validator has the same runtime and a 400 ms slot, mainnet is slower, so the settle loop (up to 5 minutes, blockhash expiry) has only been exercised with an old dead signature, not with a real slow confirmation.
- `test/programs.e2e.mjs`: ids and launch arguments updated and the launch part passes through the Worker, but its buy, sell and hook tests did not pass in my run against the local validator: `/api/send` sends with the RPC default preflight (finalized), and on a local validator the fresh blockhash is not there yet. That is in `src/` (another agent's); the standalone `programs-tests/rehearse.mjs` covers the same trades straight against the programs.
- No priority fee or compute-unit instruction is added to launch transactions. If the launch transaction does not land on a busy mainnet, add `--priority-fee`; there is room (1,020 of 1,232 bytes).
- README.md still describes the old launch (`--sol`, old ids, "Going live" steps). I did not touch it.

## Things the Worker side must match
- Buy fee rounding: the program takes `floor(sol_in * buy_fee_bps / 10000)` (as the brief said, and as the sell fee already does). `src/trade.js` `buyFee` rounds up. That is safe (its `min_out` can only be lower than what the program gives) but the two disagree by up to 1 lamport on the fee shown. One of them should change; in the program it is one line (`P9` in the mutation list shows the test that pins it).
- `Traded` event: for a buy `sol` is what the user paid, fee included; for a sell it is what the user received, fee excluded; `fee` is the fee for both.
- Pool account is 125 bytes now; an old 115-byte pool (the devnet one) has no `virtual_sol` or `buy_fee_bps`.
