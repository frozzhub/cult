# CULT ($CULT)

CULT is a Solana memecoin with a 10% sell tax that is paid back to holders in USDC every 10 minutes. This repository is its backend and website.

- Site: https://cults.bid
- X: @thecultponzi
- Mint address: published on cults.bid at launch.

## The mechanism

- The token is a Token-2022 mint with a 10% transfer fee. It launched on a Meteora Dynamic Bonding Curve paired with USDC. At about $28,400 market cap, after about $5,879 raised, it graduates to a Meteora DAMM v2 CULT/USDC pool with locked liquidity.
- Token-2022 charges the fee on every transfer, including buys. The Worker in this repository returns the fee to anyone who receives tokens in an ordinary wallet, so buying nets 0%. Tokens that arrive in a pool vault (a sell) keep the fee, and it is swept to a treasury.
- Every 10 minutes a round sells the treasury's CULT for USDC on Jupiter and splits the USDC among holders by weight. Weight is balance times a devotion multiplier: 1.25x after 7 days without selling, 1.5x after 30. Wallets holding under 50 USD are skipped.
- The curve's trading fees arrive as USDC, straight into the holder pot. The round no longer swaps SOL: it only sells the swept 10% tax (CULT) for USDC.
- The site's Buy and Sell use SOL. Jupiter routes SOL to USDC to CULT.
- The payout wallet's SOL is a float for gas, refunds and new holders' USDC account rent. The operator tops it up by hand.
- Payouts go out in batches of 8 per transaction. Every send is saved before it is made and checked from its signature afterwards, so a crash cannot pay a holder twice.

The payout wallet is `HrEKXpJvACWNxQJgQGhqNmJgQpwgC6kjtPD4dyDK2AH5`. It is the mint's withdraw-withheld authority and the curve's fee claimer. The Meteora DBC config address is `<USDC DBC config, published at launch>`.

## Trust, in short

The payout wallet's key is a hot key held as a Cloudflare Worker secret. It signs every refund, sweep, swap and payout. Whoever controls that secret or the deployment can move what the wallet holds. The 10% fee, the absence of mint and freeze authority and the locked liquidity are enforced on chain. Who is paid, and how much, is decided off chain by this code. There has been no audit. [AGENTS.md](AGENTS.md) section 6 sets out what is enforced where, and section 7 lists the on-chain reads that let you check the live coin yourself.

## Read more

- [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md): the full explanation, including why a sell-only tax needs a brief hold on buys, and how failures are handled.
- [AGENTS.md](AGENTS.md): a reference for AI agents and reviewers. File map, money flows, database tables, invariants with the tests that prove them, trust assumptions, how to verify on chain.
- [docs/API.md](docs/API.md): the HTTP API the site uses.

## What is in the repository

| Path | Contents |
|---|---|
| `src/` | The Cloudflare Worker: API, Helius webhook, the every-minute cron, the refund and sweep engine, the round engine. |
| `migrations/` | D1 (SQLite) schema. |
| `public/` | The static site. |
| `scripts/` | Operator tools: curve config and launch, launch verification, graduation, manual fee operations, monitoring. |
| `test/` | Worker tests. |
| `wrangler.jsonc` | Deployment config and every non-secret setting. |
| `programs/` | An earlier custom pool and transfer hook in Rust. Not part of the live design. |

## Run the tests

```
npm install
npm test
```

The tests run offline. They use a local D1 database through `wrangler` and a fake chain and Jupiter, with some real mainnet account data in `test/fixtures/`. `npm run check` only confirms that every source and test file parses. Operator-script tests run with `node --test scripts/test/*.test.mjs`.

To look at the site with sample data, set `DEMO` to `"1"` and run `npm run dev`.

## Settings and secrets

Non-secret settings are the `vars` in `wrangler.jsonc`, with a comment on each. Secrets are set with `wrangler secret put`: `PAYOUT_SECRET_KEY`, `SOLANA_RPC_URL`, `CRON_RPC_URL`, `HELIUS_WEBHOOK_SECRET`, `JUP_API_KEY`, `X_CLIENT_ID`, `X_CLIENT_SECRET`. `DRY_RUN` is on unless it is set to `"0"`: in that mode every step reads and plans, and nothing is signed or sent.

## Not financial advice

CULT is a memecoin. Payouts depend on trading activity and can be zero. Nothing here is a promise of return.
