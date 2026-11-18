# CULT: map, backend plan and launch readiness (16 Nov 2026)

> **Superseded on 16 Nov 2026 (late):** Kay chose the Meteora bonding-curve route with a 10% sell tax. The design is in `docs/ROUTE-CURVE.md`. Sections below about our own pool, program deploys and seed SOL no longer apply; the keys, the Worker fixes and the service keys still do.

Written for Kay and frz. Branch `kay/launch-prep`, nothing pushed or deployed.

## 1. What the repo is

CULT is not the Wanted or Drops chassis. Those launch on pump.fun and pay holders out of creator fees. CULT runs its own market:

| Part | What it does | State |
|---|---|---|
| `programs/paper-pool` | Our own SOL/CULT constant-product pool. 0% buy fee, 15% sell fee in SOL sent straight to the payout wallet. Liquidity locked forever, no admin. | Built, 4 LiteSVM tests, live on devnet since 13 Nov |
| `programs/paper-hook` | Token-2022 transfer hook. CULT can only move to normal wallets or our pool, so no one can open a second pool that skips the 15%. | Built, live on devnet |
| `scripts/launch.mjs` | Creates the mint (hook + metadata), mints 1B, seeds the pool with all of it plus your SOL, revokes mint authority. | Run on devnet only |
| `src/indexer.js`, `src/chain.js` | Cron every minute. 10-minute rounds: snapshot holders, swap the payout wallet's SOL to USDC on Jupiter, split it by balance x devotion (7d 1.25x, 30d 1.5x), pay in batches of 8. Every step saved in D1 before it is sent. | Real payouts running on devnet with a stand-in USDC |
| `src/trade.js` | The site builds buy and sell transactions; Jupiter can't route a custom pool. | Smoke-tested on devnet |
| `src/profiles.js` | Sign in with Solana, link X. | Tested; X needs an app |
| `public/` | frz's site. | Done |

What carries over from Wanted and Drops is the pattern: the hot payout wallet on the Worker, rounds on a timer, save-before-send batches, Helius snapshots. The money code itself is CULT's own and already written.

Checks run today: `npm test` 35 of 35 pass. Solana 3.1.10 with cargo-build-sbf and Anchor is in WSL Ubuntu, so the programs can be built on this PC.

## 2. Decisions for Kay and frz

Decided 16 Nov: keep our own pool (frz expects the aggregators to pick it up regardless), Kay's Cloudflare account, Kay buys the domain, $50 minimum stays, X is x.com/thecultponzi (now in the site header and `X_HANDLE`). Still open: team tokens, the domain name, finalize programs at launch or keep an upgrade key for a few days.

Decided later on 16 Nov (Route 1): stay on our own pool with a **virtual seed** (the pool starts as if it held 30 SOL; we put none in), 15% sell fee, 0% buy fee (Kay, 16 Nov, after briefly choosing 1%). The program keeps a buy-fee setting, launched at 0.

frz launches the coin from his own wallet (creator: mint, pool seed, metadata authority, team buy). Our deployer only deploys the programs and holds the upgrade key. Needed from frz: his wallet address (goes in `EXCLUDE`) and whether he runs `launch.mjs` with his key file or wants a Phantom-signing launch page. Meteora and Raydium were checked in source and can't charge a different rate on sells (see the chat of 16 Nov). Research on when custom-pool coins got indexed: `docs/research/custom-pool-indexing.md`.

1. **The market is our own pool, so the usual places won't see the coin.** No pump.fun page, and nothing on DexScreener, Jupiter, Phantom's swap, Axiom or GMGN until someone integrates with them. People can buy only on our site. RugCheck-style scanners will flag the transfer hook. That is how the 15% tax is enforced, and it's the biggest change from our usual launches. frz needs to confirm he wants this on day one.
2. **Seed SOL.** All 1B tokens go into the pool with the SOL you choose, so the starting market cap equals the seed SOL (10 SOL seed, 10 SOL FDV). That SOL is locked forever: no withdraw, by design.
3. **Team tokens.** The launch script gives the team nothing. If you want a team bag, the deployer buys straight after the pool is seeded (same minute), and it goes in `EXCLUDE` so it takes no airdrop.
4. **Whose Cloudflare account and which domain.** Devnet runs on the `jamescollinscfc123` account. Wrangler on this PC is logged into Kay's. Need the domain for `token.json` (the token image link is written into the mint at launch).
5. **The $50 holder minimum.** At a small starting market cap few wallets clear $50 at first. Lower it for the first day (for example $10) or keep it.

## 3. Keys and wallets

Fresh mainnet keys, made today, in `program-keys/mainnet/` (gitignored):

| Name | Address | Job |
|---|---|---|
| deployer | `KDpz3icbjmmib1DDeitywpk6ZdsQckHiqt6hKmKnnaq` | Pays the program deploys, runs the launch, seeds the pool, holds the upgrade, hook and metadata authorities until revoked |
| payout | `HrEKXpJvACWNxQJgQGhqNmJgQpwgC6kjtPD4dyDK2AH5` | Takes the 15% in SOL, swaps, pays holders. Its key becomes the `PAYOUT_SECRET_KEY` Worker secret |
| pool program | `5xsG4XWGVdazEZSDkjFWu25gCyeCnTuxuPxbmJ1xmA4D` | Program address, first deploy only |
| hook program | `521AkYhN31VTGPLn75NgeWievYHZoxPwREihCCsppxnF` | Program address, first deploy only |

`program-keys/mainnet/PRIVATE-KEYS-import-then-delete.txt` holds the base58 keys for Phantom. Keep the JSON files until the launch is done and the payout secret is on the Worker; the deployer key is needed to deploy and launch.

Service keys:
- **Helius**: the key in `~/.coined-preview/prod.vars` works on mainnet (Helius keys are account-wide). It becomes `HELIUS_KEY`. Check the plan's credit allowance: the poller reads every mint transaction.
- **Jupiter**: needs a key from portal.jup.ag. The free endpoint answers 429 to Cloudflare (seen on RNG's launch night), and CULT uses Jupiter every minute for the SOL price and every round for the swap. Without it rounds stall. Kay has the key (16 Nov); it goes in `~/.cult/prod.vars` as `JUP_API_KEY`, pushed with `wrangler secret bulk` at deploy. Also set the var `JUP_API=https://api.jup.ag`, since the keyed endpoint isn't lite-api.
- **Generated at deploy**: `HELIUS_WEBHOOK_SECRET`.
- **Optional**: `X_CLIENT_ID` / `X_CLIENT_SECRET` for linking X. The site works without them.

## 4. Money needed

| What | SOL |
|---|---|
| Two program deploys (rent, refundable only by closing the program) | about 3.5 to 4.5, confirmed after the mainnet build |
| Mint, hook list, pool and vault accounts, fees | about 0.05 |
| Pool seed (locked forever) | your call (section 2) |
| Payout wallet float: 0.05 SOL reserve plus USDC account rent for new holders | 0.2 |
| Team buy, if any | your call |

## 5. Backend build steps

1. Fold in the review fixes marked "before launch" (section 7).
2. Swap in the new program ids everywhere the README lists (both `declare_id!`, `POOL_PROGRAM` in the hook, `launch.mjs`, `Anchor.toml`, the tests). Build in WSL, run the LiteSVM tests and `npm test`.
3. Rehearse once on devnet with the new build: deploy both programs, launch, buy, sell, watch one round pay.
4. Add the authority revokes to `launch.mjs` (from the review), so the launch ends with nothing anyone can change.
5. Mainnet Worker config: `MINT`, `POOL_PROGRAM`, `HOOK_PROGRAM`, `PAYOUT_WALLET`, `EXCLUDE` (deployer and team), `DEMO="0"`, `DRY_RUN="1"`. Create the D1 database and apply the migrations. Set the secrets.
6. Helius webhook on the pool PDA to `/api/hook` (the poller backs it up).
7. Point `public/token.json`'s `image` at the mainnet domain. It still names the devnet Worker URL, and wallets fetch the image from there.

## 6. Launch order (T = pool seeded)

1. T-2h: fund the deployer; deploy both programs; confirm sizes and cost.
2. T-1h: Worker live on the domain in pre-launch state (no `MINT`), D1 ready, secrets set.
3. T-0: `node scripts/launch.mjs --keypair program-keys/mainnet/deployer.json --payout HrEK... --sol <seed> --supply 1000000000 --name Cult --symbol CULT --uri https://<domain>/token.json --rpc <helius> --go`, then the team buy if any.
4. T+1m: set `MINT`, deploy the Worker, and check that the site shows the pool price and a test buy works from Phantom.
5. T+10m: first round runs in `DRY_RUN`. Read its numbers on `/api/state`.
6. T+30m: set `DRY_RUN="0"` once two dry rounds look right. Fund the payout wallet's 0.2 SOL first.
7. Then revoke upgrade authorities (or keep them for a fix window you announce).

## 7. Review findings

Full report: `docs/reviews/2026-11-16-money.md`. Failing tests: `test/review-money.test.js` (F1 to F10) and `programs-tests/tests/review_hook.rs`. The pool maths checked out sound.

Blockers:
1. The creator keeps the transfer-hook authority, so it could switch the 15% off or block sells. Fix: revoke it in `launch.mjs`.
2. The site says liquidity is locked while the program upgrade keys could drain the pool. Finalize the programs, or disclose a cold upgrade key and finalize later.
3. Overlapping cron runs pay the same batch twice (12 of 20 holders in the test). Fix: conditional claims and a refreshed 15-minute lock.

Before real payouts (`DRY_RUN="0"`): USDC-account rent can be farmed from the pot; one closed account blocks a batch of 8; transactions that already landed can be re-sent; one empty snapshot wipes every streak; the poller stalls on version-1 transactions; `/api/send` relays any transaction; balance reads lag a round; dry-run rounds show as paid on the site; the payout wallet is never checked against the pool's.

After launch: tighten the hook (plain token accounts can change owner); streak gaming with aged dust wallets is a design call.

## 8. Improvements worth making

Filled in after the review.
