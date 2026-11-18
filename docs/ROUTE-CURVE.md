# CULT on Meteora's bonding curve (decided by Kay, 16 Nov 2026)

Replaces Route 1 (our own pool + transfer hook). `programs/`, `programs-tests/` and `scripts/launch.mjs` are no longer used by the launch; they stay in the repo until frz says to delete them.

## Design
- **Token:** Token-2022 with a 10% transfer fee (Meteora's curve caps it at 10%), created by Meteora's Dynamic Bonding Curve (DBC) in the launch transaction. Fee rate can never change. No transfer hook.
- **Market:** Meteora DBC pool, quoted in SOL, virtual reserves (no SOL from us). Starts at a 27.96 SOL market cap (pump.fun's curve). Graduates into a Meteora DAMM v2 pool with liquidity locked.
- **Fee key:** the payout wallet `HrEKXpJvACWNxQJgQGhqNmJgQpwgC6kjtPD4dyDK2AH5` is the DBC partner `feeClaimer` and the withdraw-withheld authority (`TransferFeeWithheldAuthority.Partner`). Its key is the Worker secret `PAYOUT_SECRET_KEY`.
- **Creator:** frz's wallet is payer and `poolCreator`, and may make the first buy in the launch transaction.
- **The rule (same as the old hook's):** tokens arriving in a normal wallet are free; tokens arriving in a program-owned account (any pool's vault) pay 10%.
  - Every transfer withholds 10% in the receiving token account.
  - Receiving account owned by an on-curve wallet with no delegate and no close authority: the Worker releases the withheld tokens back into that same account (fee-free, holder signs nothing). So buys and wallet-to-wallet sends net 0%.
  - Receiving account owned by an off-curve address (pool vaults), or with a delegate: the Worker sweeps the withheld tokens to the treasury. So every sell into any pool pays 10%.
- **Payout:** each 10-minute round the Worker sweeps the withheld CULT, sells it for USDC through Jupiter, and airdrops the USDC to holders worth $50+, weighted by balance x devotion. Unchanged engine (`src/indexer.js`), with the review fixes.

## Proven on mainnet (docs/research/day-one-visibility.md, spikes/fee-test/dbc.mjs)
Create, buy, refund, sell all work; DexScreener, Jupiter and Photon show it as a bonding-curve coin with liquidity counted.

## Open, with defaults
- Curve (Kay, 16 Nov): matches pump.fun. Start market cap 27.96 SOL, graduation 410.8 SOL: 793.1M tokens sold on the curve, 206.9M to the graduated pool, 85.0 SOL raised. These are the script defaults.
- Curve pool fee: 0.25% (the minimum). Graduated pool fee 0.25%.
- Token metadata: immutable by default, so the domain and `token.json` must be final before launch.

## Hosting (Kay, 16 Nov 2026)
- Domain: `cults.bid`, on frz's Cloudflare account (`c86a724ee0e65237b18c5061a5ab47a4`), which wrangler on Kay's PC can use. A Worker's custom domain must be in the same account as the Worker, so the mainnet and staging Workers deploy there (set `CLOUDFLARE_ACCOUNT_ID` or `account_id`), not on Kay's own account.
- Token metadata: `https://cults.bid/token.json`, image `https://cults.bid/logo.png`. Both must be live before the launch (the metadata is immutable).
- The Jupiter key is in `~/.cult/prod.vars` (`JUP_API_KEY`).

## Launch decisions (Kay, 16 Nov 2026, late)
- frz launches in Proxima from our DBC config address; the token image and details are uploaded in Proxima (no dependency on cults.bid/token.json).
- frz's wallets (creator and bundle) are NOT excluded from airdrops. `EXCLUDE` holds only wallets that must never be paid (none by default; the payout wallet and program-owned accounts are skipped by the code).
- No practice rounds at launch: refunds AND payouts are live from the first round (`DRY_RUN="0"`, `REFUNDS_DRY_RUN="0"`). The staging run before launch is where it is proven.
- Solicitor has cleared the launch.
- cults.bid stays dark until an hour before launch or Kay's word.
