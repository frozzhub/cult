# CULT launch night

Written 16 Nov 2026. The design is in [ROUTE-CURVE.md](ROUTE-CURVE.md). There is no practice round: the first tick after launch sends real refunds and the first round pays real USDC.

## The one address frz needs

```
DBC config: 3jUuWLhrdao4upGuvC3muRN9cZtP7bSAqDaXsY6QsUfK
```

Paste it into Proxima under Solana → Meteora DBC → "DBC Config". It fixes the 10% transfer fee, the fee wallet (`HrEKXpJvACWNxQJgQGhqNmJgQpwgC6kjtPD4dyDK2AH5`), and a curve that starts at 27.96 SOL market cap and graduates at 410.8 SOL after 85.0 SOL raised, the same as pump.fun. Created and read back on chain in `5PEzArAeuC3JjbZxJcoWNXLHH6mnmVdCGVgWuspL4efHctLA9F9riLrQuJK3jim5YhLhBUm64Tx1ZEbZjZNzMMZm`.

Do not use `5hLxFWnjb6fx4HHQ6HL6tewcbsUVcmN8AdqhEH6gdQKW`. That is the test config and its fees go to a test wallet.

## Before launch (Kay and Claude)

| Check | State needed |
|---|---|
| Payout wallet `HrEKXpJvACWNxQJgQGhqNmJgQpwgC6kjtPD4dyDK2AH5` | holds about 1.2 SOL: the 1 SOL reserve (`SOL_RESERVE_LAMPORTS`, never sold) plus a margin |
| Production Worker `cult` | deployed with `MINT` empty, D1 migrated 0001–0007, no route |
| Secrets on `cult` | `SOLANA_RPC_URL`, `JUP_API_KEY`, `PAYOUT_SECRET_KEY` (payout.json), `HELIUS_WEBHOOK_SECRET` |
| Vars for the launch deploy | `DRY_RUN` "0", `REFUNDS_DRY_RUN` "0", `EXCLUDE` empty, `MIN_HOLD_USD` "50", `SOL_RESERVE_LAMPORTS` "1000000000" |
| Staging loop on the test token | buy refunded, sell taxed, round paid USDC |

One hour before launch, or on Kay's word: add the `cults.bid` route to the top-level env in `wrangler.jsonc` and deploy. The site shows its pre-launch state until `MINT` is set.

## At launch

1. frz creates the coin in Proxima with the config above, uploads the token image there, and posts the mint address.
2. Claude checks the mint on chain, read only: `node scripts/verify-launch.mjs --rpc <RPC> --mint <MINT> --creator DRQRU9Z7vRFHD9s43TQX2BePp35HoWpNVPqN31ijTow6`. It checks the Token-2022 mint (10% fee, no fee-config, mint or freeze authority, withdraw-withheld authority the payout wallet), the pool's config and creator, and prints every line. If it exits non-zero, stop: do not set `MINT`. Anyone can launch a copy of the coin on our public config, so the creator line is the one that tells the real coin from a copy.
3. Claude sets `MINT` and `CREATOR` (frz's wallet) and deploys `cult` (about 20 seconds), then points the Helius webhook at the new mint.
4. Claude confirms on `https://cults.bid/api/state`: `live: true`, the mint, `pool.stage: "curve"`.
5. Only then does anyone post the CA. The CA on cults.bid is the official one.

The Worker picks up every trade from the mint's creation onward, so buys made before step 3 are refunded once it is live.

## What should happen with no one touching it

- A buy from any terminal: the 10% withheld comes back to the buyer within seconds (webhook), or within a minute (the every-minute tick).
- A sell: the 10% stays in the pool vault and is swept to the payout wallet.
- Every 10 minutes: swept CULT is sold for USDC, split across wallets worth $50 or more, and paid.
- Every hour: the curve's trading fees (SOL) are claimed to the payout wallet (after graduation, the locked position's SOL fees).
- At 85 SOL raised: the Worker migrates the pool to DAMM v2 on the next tick. Jupiter has no route between completion and migration, so this must not wait.

## If something stalls

All commands are dry runs until `--go`. `<RPC>` is the Helius mainnet URL, `<MINT>` the coin.

```
node scripts/fee-ops.mjs status --rpc <RPC> --mint <MINT>
node scripts/fee-ops.mjs refund <wallet> --rpc <RPC> --mint <MINT> --fee-keypair program-keys/mainnet/payout.json --go
node scripts/fee-ops.mjs sweep  --rpc <RPC> --mint <MINT> --fee-keypair program-keys/mainnet/payout.json --go
node scripts/fee-ops.mjs claim  --rpc <RPC> --mint <MINT> --fee-keypair program-keys/mainnet/payout.json --go
node scripts/migrate-curve.mjs  --rpc <RPC> --mint <MINT> --keypair program-keys/mainnet/payout.json --fee-keypair program-keys/mainnet/payout.json --go
```

| Symptom | Do |
|---|---|
| Buyers not refunded | `fee-ops status`, then `refund <wallet>` for each; check the Worker's `poll_state` row in D1 |
| Round shows `error` | read `drops.error` in D1; payouts are claimed before sending and settle from the signature, so a rerun never pays twice |
| Curve at 100% and no trades | `migrate-curve --go` at once |
| Anything pays the wrong amount | deploy with `--var DRY_RUN:1`; refunds can stay on with `--var REFUNDS_DRY_RUN:0` |

## After graduation

- The transfer fee stays 10% and the payout wallet can still sweep and refund.
- All liquidity is locked for good; the payout wallet owns the position. Its SOL fees are claimed by the Worker every hour; `fee-ops claim` is the manual fallback. Nothing swaps USDC back to SOL: watch the wallet's SOL.
- About 10% of the SOL raised goes to Meteora at graduation for transfer-fee tokens (roughly 8.5 of 85 SOL).

## Known limits

- Bots that buy and sell in one transaction pay the tax on the way out; that is intended.
- A buyer whose wallet is a program account (some smart wallets) is not refunded: only normal wallets are.
- Jupiter's audit can flag a large dev holding.

## The launch deploy command (step 3)

`<MINT>` is the address frz posts, after `verify-launch` passes. These settings are passed here and not kept in `wrangler.jsonc`, because the tests read that file.

```
npx wrangler deploy --var MINT:<MINT> --var CREATOR:DRQRU9Z7vRFHD9s43TQX2BePp35HoWpNVPqN31ijTow6 --var DBC_CONFIG:3jUuWLhrdao4upGuvC3muRN9cZtP7bSAqDaXsY6QsUfK --var DRY_RUN:0 --var REFUNDS_DRY_RUN:0 --var REBROADCAST_MS:16000 --var FEE_PRIORITY_MICROLAMPORTS:1000000
```

Every later production deploy must carry the same `--var` list, or the Worker falls back to dry run with no coin set.

Added 17 Nov from staging and from fnf's launch the same day: sends are re-broadcast every 2 s until seen (`REBROADCAST_MS`), refunds pay a 1,000,000 microlamport priority fee, the sell page reads the wallet's live balance, and Jupiter may open the payout wallet's own account for a hop token.
