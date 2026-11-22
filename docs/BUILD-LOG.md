# CULT build log

> Renamed from $PAPER on 2026-11-15. The repo folder and the devnet Worker URL keep the old `paper-hands` name.

## Now on Meteora (2026-11-21)

The custom pool + transfer hook (below, kept for reference) couldn't do what we wanted *and* show up on terminals, so $CULT launches on **Meteora's Dynamic Bonding Curve** instead (Axiom, GMGN, Jupiter, Dexscreener all see it).

- **10% fee on every buy and sell, in SOL.** Meteora keeps 20% of each fee; the treasury (`PAYOUT_WALLET`, the curve's partner) earns the other 80%.
- **Buys are refunded in full.** The Worker watches the pool every 3 seconds (`src/meteora.js`, inside each minute's cron) and sends every buyer their whole 10% back, with a memo. Measured on devnet: refund lands ~5s after the buy, before and after graduation. Each refund is saved before it's sent and only re-sent once the old one can't land, so nobody is paid twice (tested).
- **Sells fund the airdrop.** Each 10-minute round claims the treasury's fees, swaps what's spare to USDC and pays members (same engine as before).
- **The pot = 8% of sell volume − 2% of buy volume** (the full refund costs the treasury Meteora's 2% cut). Heavy buying with few sells can make a round's pot zero; refunds always come first.
- **Graduation:** at ~86 SOL raised Meteora's keeper moves the coin to a DAMM v2 pool with the same 10% SOL fee. 100% of that liquidity is permanently locked to the treasury (it earns the pool's fees, it can never be pulled). The Worker finds the new pool by itself and keeps refunding and claiming there (tested on devnet).
- **Site:** Buy/Sell panel kept (quotes + transactions from the Worker: Jupiter on mainnet, the curve/DAMM pool directly as a fallback and on devnet), sell warning "Leave anyway, pay 10%", "buy fees refunded" stat.

### Going live on mainnet
1. Fresh treasury keypair (`solana-keygen new -o program-keys/mainnet-treasury.json`), funded with ~1–2 SOL: launch costs + the refund float (`REFUND_FLOAT_LAMPORTS`, 0.5 SOL) so the first buys are refunded before any fees are claimed.
2. `node scripts/launch-meteora.mjs --cluster mainnet --treasury program-keys/mainnet-treasury.json --uri https://cults.bid/token.json --rpc <helius url>` (defaults: starts at 30 SOL mcap, graduates at 400 SOL ≈ 86 SOL raised). It prints MINT, POOL_ACCOUNT, VAULTS.
3. Put those plus PAYOUT_WALLET in `wrangler.jsonc`, create the D1 database + `migrations apply --remote`, set secrets `HELIUS_KEY` and `PAYOUT_SECRET_KEY`, `DEMO="0"`.
4. Deploy with `DRY_RUN="1"`, check the watcher sees trades, then `DRY_RUN="0"`. Do one small real buy and sell and watch the refund land.

```
npm test                                   # 48 Worker tests (incl. real devnet Meteora transactions)
node scripts/meteora-trade.mjs --keypair program-keys/devnet-trader.json --buy 0.01   # devnet curve
node scripts/damm-trade.mjs --info                                                    # devnet graduated pool
```

## Before Meteora (the custom pool)

0% buy tax, 15% sell tax, all of it airdropped to holders as USDC every 10 minutes (`DROP_MINUTES`, cron every minute). Hold 7 days without selling for a 1.25× share, 30 days for 1.5×.

## What's here

| Part | Where | Status |
|---|---|---|
| Site: Home, Wall of Paper Hands, Airdrops, Buy/Sell panel | `public/` | Done, checked on desktop + phone |
| API, webhook, cron | `src/index.js` | Done, tested |
| Airdrop engine | `src/indexer.js`, `src/chain.js` | Done, tested end to end against local D1 with a fake chain |
| Live data for the site | `src/live.js` | Done, tested |
| Buy/Sell transactions | `src/trade.js` | Done, tested (instruction layout + quotes) |
| Pool program (0% buy / 15% sell in SOL) | `programs/paper-pool` | Compiles; 4 LiteSVM tests pass (`programs-tests/`) |
| Transfer hook (blocks other pools) | `programs/paper-hook` | Compiles; tested with the pool |
| Launch script (mint, hook, pool, revoke) | `scripts/launch.mjs` | Dry run works; never sent |

```
npm test                 # 14 Worker tests
npm run build:programs   # cargo build-sbf -> target/deploy/*.so
npm run test:programs    # 4 program tests in LiteSVM
npm run dev       # site on demo data (DEMO="1")
```

## How an airdrop works

The cron runs every 5 minutes and moves the current airdrop one step at a time. Every step is saved in D1 before anything goes on-chain, so a crash just resumes.

1. **Open:** on the hour, every sell since the last airdrop is claimed by the new one.
2. **Snapshot:** all holders (Helius DAS). Excluded: the pool, the payout wallet, `EXCLUDE`, and anyone under $50. Weight = balance × streak boost. A streak starts when a wallet first shows up holding and resets on any sell.
3. **Swap:** the payout wallet's spare SOL goes to USDC on Jupiter. It keeps a 0.05 SOL reserve, plus rent for new holders' USDC accounts and tx fees.
4. **Allocate:** the wallet's whole USDC balance is split by weight. Payouts under $0.01 roll over. Wallets are grouped 8 per transaction.
5. **Pay:** each batch is signed, its signature saved, then sent. Later ticks confirm them. A batch is only re-sent once its old transaction can no longer land (failed, or blockhash expired), so **no one gets paid twice** (tested). Batches that fail 5 times leave their USDC for the next airdrop.

`DRY_RUN="1"` (the default) runs all of it without signing or sending, so you can watch it on real data first.

## The payout wallet holds a hot key

Hourly airdrops with nobody pressing a button mean the Worker has to sign, so `PAYOUT_SECRET_KEY` is a Worker secret. This differs from Clipped, where the treasury signs in the browser. To limit the risk:
- Use a fresh wallet for this only. It only ever holds about an hour of fees.
- The pool sends fees straight to it, and nothing else depends on it.
- The key is checked against `PAYOUT_WALLET` on every use.

## Going live (in order)

1. Make real program keypairs (`solana-keygen new -o program-keys/paper_pool.json`, same for hook) and put their ids in both `declare_id!`s, `POOL_PROGRAM` in paper-hook, `scripts/launch.mjs`, `Anchor.toml`, the tests and `wrangler.jsonc`. Rebuild and rerun the tests.
2. Deploy both programs to devnet, run `node scripts/launch.mjs ... --go` on devnet, and do test buys and sells from the site.
3. Make a fresh payout wallet. Set the secrets: `SOLANA_RPC_URL` (Helius), `HELIUS_WEBHOOK_SECRET`, `PAYOUT_SECRET_KEY`.
4. Create the D1 database and paste its id into `wrangler.jsonc`, then run `wrangler d1 migrations apply paper-hands --remote`.
5. Add a Helius webhook: enhanced, type ANY, account = the pool PDA, URL `https://<site>/api/hook`, auth header = `HELIUS_WEBHOOK_SECRET`.
6. Mainnet launch, then set `MINT`, `POOL_PROGRAM`, `HOOK_PROGRAM`, `PAYOUT_WALLET`, `DEMO="0"`. Deploy with `DRY_RUN="1"`, watch a couple of hours, then set `DRY_RUN="0"`.

## Things to know

- **The hook refuses transfers to program-owned wallets.** That's how it blocks other pools: their vaults are owned by program addresses. A side effect is that $PAPER can't go to a Squads multisig or similar. Regular wallets and CEX deposit addresses work.
- **Jupiter won't route a brand-new custom pool**, which is why the site has its own Buy/Sell panel. Getting listed on Jupiter means integrating with them.
- **Liquidity is locked forever** and the fee can't be changed after launch: no admin, no withdraw.
- Holder snapshots need Helius (DAS `getTokenAccounts`).
- Copy never promises returns. A USDC revenue share can look like a security in some places.

## Toolchain on this PC

Per-user, no admin: Rust 1.100 (`~/.cargo/bin`, GNU default + MSVC for tests), Agave 4.3.2 (`~/solana/v4.3.2/solana-release/bin`), VS 2022 C++ Build Tools. Neither is on PATH, so add both bin folders to PATH in your shell before the npm scripts. `solana-test-validator` needs Windows Developer Mode (symlinks), which is why the program tests use LiteSVM. `test/programs.e2e.mjs` covers the launch script + trade API on a real validator once Developer Mode is on.

## Devnet (launched 2026-11-13)

| | Address |
|---|---|
| Mint ($PAPER, Token-2022 + hook, minting revoked) | [FpAWetRJ4MJm4mUdTUVeagoHjcQv3oXevu9XUcVFuN6a](https://solscan.io/token/FpAWetRJ4MJm4mUdTUVeagoHjcQv3oXevu9XUcVFuN6a?cluster=devnet) |
| Pool program | [J6zYGwRTLX17ms2dDZ6yGXP21xfigBwLKvYXho2Aw9Bu](https://solscan.io/account/J6zYGwRTLX17ms2dDZ6yGXP21xfigBwLKvYXho2Aw9Bu?cluster=devnet) |
| Hook program | [794MkqjE5VxXMVX9pJFK9D6YeK9pKp59K5BkBULfnSG2](https://solscan.io/account/794MkqjE5VxXMVX9pJFK9D6YeK9pKp59K5BkBULfnSG2?cluster=devnet) |
| Pool (PDA) | 7K1zjnyqRtivvoCB65mc2Kedtf1DHtvxfiYVNU3vnHux, seeded with 1B $PAPER + 1.5 SOL |
| Payout wallet | GCpRo9fhAho6XhCrihAjgMz9WNiTB5Z6mYtFtmnYEBbc |

Keys (deployer = upgrade authority, payout, test trader) are in `program-keys/` (gitignored, devnet only). Launch and smoke-test output are in `program-keys/devnet-launch.txt` and `devnet-smoke.txt`. Re-run the smoke test with `node scripts/devnet-smoke.mjs FpAWetRJ4MJm4mUdTUVeagoHjcQv3oXevu9XUcVFuN6a`. Smoke test results: buy 0.2 SOL with no fee, then sell half with exactly 15.00% of the SOL to the payout wallet ([buy](https://solscan.io/tx/4tyL1JXSbX5UqwprBepjCxsbbHhPUSuocVVd8YQTUjkMH2jEVUTBSJ8HGsfRkJCiR6rDmVkDgSspNRDRzSFrHivm?cluster=devnet), [sell](https://solscan.io/tx/gb2hKAtMbvEEkS7cp2aHm6uEjjNtGjX2uHYe3xtYqp3KESvJU8mrgBFhByWKmdLg7opgREGyEaL9avd61HLkGVe?cluster=devnet)).

Devnet SOL: the CLI faucet rate-limits this PC. `devnet-pow` is installed (built with Rust 1.76) but needs a small CLI airdrop to start.
## Devnet site (deployed 2026-11-13)

The devnet Worker `paper-hands-devnet` (on workers.dev) runs the devnet launch. Add `?demo` to see it full of sample data (devnet only, labelled "sample data").

- Deploy: `wrangler deploy --env devnet` (D1 `paper-hands-devnet`, cron every 5 min, DRY_RUN).
- **Trading works**: on devnet the page reads the pool and sends trades through the public RPC itself (`CLIENT_RPC`), and the Worker only builds the transaction. Smoke-tested through the live site: buy with no fee, sell with exactly 15.00% to payout.
- **The devnet cron is starved**: `api.devnet.solana.com` blocks Cloudflare IPs, and the free fallbacks (Alchemy demo, OnFinality) throttle Workers. Fix with a free Helius key: `wrangler secret put HELIUS_KEY --env devnet`. It's tried first, on the env's network. The same backend runs fine from this PC (`npm run test:devnet`).

## Backend, added 2026-11-13

- **Pool pricing**: $PAPER is priced from the pool's own reserves (Jupiter can't see a custom pool). If a read fails, it keeps the last good price.
- **Mint poller** (`pollMint`): walks the mint's transaction history every tick. It records sells (a backup for the Helius webhook, deduped by signature) and keeps a holder index (`token_accounts`) from post-balances, so holder snapshots work on any RPC (`HOLDERS=index`). Snapshot waits until the index has caught up.
- **RPC**: `SOLANA_RPC_URL` takes a comma list with failover on 429/403. `HELIUS_KEY` is put first. `getTokenAccounts` handles both Helius (`mint`) and Solana Foundation (`mintAddress`) params, then falls back to `getProgramAccounts`.
- **Pool reads**: one `getMultipleAccounts` call (pool + vault + mint), cached 10 s, stale-on-error up to 5 min. Trades always re-read fresh.
- **Tests**:
  - `npm test`: 27 Worker tests
  - `npm run test:programs`: 4 program tests (LiteSVM)
  - `npm run test:devnet`: 2 tests against the real devnet launch (parser + full dry-run airdrop cycle)
  - `BASE=<site> node scripts/devnet-smoke.mjs <MINT>`: a real buy + sell through the deployed site

## Design (2026-11-13)

Based on research into classic "ponzi" UIs (Fomo3D's single countdown with the pot under it, Olympus/Titano's "your next reward", HEX's commitment-as-multiplier, pump.fun's live feed, PonziCoin's honesty), keeping only the patterns that work and none of their chrome.

- **Hero**: one big mono countdown to the hour, then this hour's pot in mint, rolling up as sells land, then one honest line ("A ponzi game. No promised returns.").
- **Connected wallet**: the line becomes "your cut this hour", with balance, multiplier, USDC received and a thin streak bar.
- **Live ticker**: a slow ticker of sells under the header. New Wall rows fade in.
- **End of the hour**: the clock shows "Paying $X to holders" for 4 seconds.
- **Look**: palette `#0d0e10` / `#15171a` / `#eceae4`, one accent (originally mint; USDC blue `#2775CA` since 2026-11-15, see Brand). Inter Tight for text, JetBrains Mono for every number. No APYs, no tile grids, no red for sellers (the copy does the shaming).
## Real payouts on devnet (2026-11-14)

Devnet now runs the real payout path (`DRY_RUN="0"`): it signs and sends batched token transfers, opens holders' token accounts, confirms, and re-sends only expired batches. Jupiter and USDC are mainnet-only, so devnet uses:
- `USDC_MINT`: a stand-in USDC (classic SPL token, 6 decimals), [56Evddar…1k5e](https://solscan.io/token/56EvddarourfZET4VC6EMYKwyG7uLWbBdxtcetmp1k5e?cluster=devnet). Top up the payout wallet with `node scripts/devnet-test-usdc.mjs 50`.
- `SWAP="off"`: no Jupiter swap. The pot is whatever stand-in USDC the payout wallet holds.
- `PAYOUT_SECRET_KEY` secret: the devnet-only payout key from `program-keys/devnet-payout.json`.

Mainnet leaves `USDC_MINT` empty (real USDC) and `SWAP` on, and stays `DRY_RUN="1"` until you go live.
## Drop timing (2026-11-14)

Airdrops run every **10 minutes** (`DROP_MINUTES="10"`), and the cron runs every minute so each round opens on time. The site copy says "round" and reads the period from config, so changing `DROP_MINUTES` needs no other edits. Sample data scales with it. A faster round means smaller payouts per round (anything under `MIN_PAYOUT_USDC` rolls over to the next round) and about 6x more payout transactions per hour. On mainnet that's about 15,000 lamports per batch of 8 holders.

## Price chart and totals (2026-11-14)

- **Trades**: the mint poller records every buy and sell through the pool (`trades`, migration 0003) with the price after the trade. That's SOL per $PAPER from the pool's post-trade lamports minus rent (measured from the pool, not hard-coded) and its post-trade vault balance, valued at the SOL price when recorded. Seeding the pool at launch is not a trade or a sell.
- **API**: `GET /api/chart?range=24h|7d|all` returns up to 120 points (last price per bucket, carried forward through quiet stretches, ending at the live pool price). `/api/state` totals add `volumeUsd` and `trades`.
- **Page**: the price in compact form ($0.0₃420) and its change over the range, a single-series mint line with a soft fill, crosshair and tooltip (keyboard: arrows, Home/End, Escape), and a screen-reader table. The totals row is total volume, USDC airdropped to holders, holders in the last round, and rounds paid.
- **Backfill**: deleting the `poll_cursor` and `poll_state` kv rows makes the poller re-read the mint's full history. It's safe, since every insert skips duplicates.

## Brand (2026-11-15)

- **Name:** Cult, ticker $CULT. Line: *Everyone's panicking. The cult is getting paid.*
- **Mark (updated 2026-11-15):** a hooded member, the inner circle worn as a halo and the mint dot glowing under the hood (`brand/hooded/`). It's used as `public/mark.svg` (header), `public/icon.svg` (favicon) and `public/logo.png` (token image and apple-touch icon). The first ring-and-dot mark is superseded. Sources are in `brand/` (`*.html`, rendered to `*.png` with headless Edge).
- **Colour (updated 2026-11-15 to USDC blue):** Night `#0D0E10`, Surface `#15171A`, Bone `#ECEAE4` (logo bone `#E9E4D8`), USDC blue `#2775CA` for fills, lines, the logo dot and the Join button (white text, 4.7:1). Small blue text uses the tint `#4B8FD8` (5.7:1), because `#2775CA` is only 4.1:1 on Night. CSS tokens: `--accent` and `--accent-ink`.
- **Type:** Inter Tight for words, JetBrains Mono for every number.
- **Voice:** holders are members, buying is joining, the 15% sell tax is the exit tithe, the holding streak is devotion, sellers have left the cult, and the airdrop is the cult getting paid. The trade panel keeps plain Buy and Sell labels.
- **Assets:** `brand/board.png` (brand board), `brand/og.png` (the link preview, copied to `public/`), `brand/x-launch.png` (1600x900), `brand/logo.png` (512px, used in `public/token.json`).
- **Devnet token renamed on-chain:** `node scripts/rename-token.mjs --mint ... --name Cult --symbol CULT --uri .../token.json`.

## Profiles and X (2026-11-15)

- **Sign in** by signing a free Sign In With Solana message (`/api/auth/challenge` then `/api/auth/signin`). That sets a 30-day HttpOnly cookie, and only the token's SHA-256 is stored.
- **Link X**: only wallets holding $CULT can link (checked against the holder index, then the chain). It uses OAuth 2.0 with PKCE on X's own page. The callback must be finished by the same signed-in wallet, and one X account can belong to one wallet. The profile stores the X id, @handle, name and the 400x400 picture.
- **Stays in sync**: the scope includes `offline.access`, and the cron re-reads each linked X account about once a day, storing X's rotated refresh token. A revoked link keeps the last name and picture and stops syncing.
- **Shown**: on the header button, the Members and Left the cult boards, the ticker, and `#profile` / `#u/<wallet>` pages.
- **Setup**: create an X app at developer.x.com (OAuth 2.0, Web App / confidential client) with the callback `<site>/api/x/callback`, then run `wrangler secret put X_CLIENT_ID` and `X_CLIENT_SECRET`. Until those are set, the profile page says linking opens soon.
- **Tests**: `test/profile.test.js` covers sign-in, holder gating, PKCE, the callback, the binding guard, one X per wallet, sync and revoke, and unlink and sign-out.
