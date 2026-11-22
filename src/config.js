// All settings in one place. Vars live in wrangler.jsonc, secrets in `wrangler secret put`.
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function config(env) {
  const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
  const num = (v, d, lo = 0, hi = Infinity) => { const n = Number(v === undefined || v === "" ? d : v); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
  const dryRun = env.DRY_RUN !== "0"; // on unless explicitly turned off
  const quoteMint = env.QUOTE_MINT || SOL_MINT;
  return {
    cluster: env.CLUSTER === "devnet" ? "devnet" : "mainnet",
    ticker: env.TICKER || "CULT",
    mint: env.MINT || "",
    // The tax the mint withholds on every transfer (the curve caps it at 10%). Shown by the site; the mint is the truth.
    sellTaxBps: num(env.SELL_TAX_BPS, 1000, 0, 1000),
    // The curve's quote token: SOL (unset) or USDC. The curve read refuses a config quoted in anything else, and so does the
    // tick (quoteSym "" = neither). USDC means the claimed curve fees arrive as USDC, the pot's own token.
    quoteMint,
    quoteSym: quoteMint === SOL_MINT ? "SOL" : quoteMint === (env.USDC_MINT || USDC_MINT) ? "USDC" : "",
    quoteDecimals: quoteMint === SOL_MINT ? 9 : 6,
    dbcConfig: env.DBC_CONFIG || "",       // optional: the Meteora DBC config account. Unset, the pool is found on chain from MINT
    creator: env.CREATOR || "",            // optional: the wallet that created the pool. Set, the tick refuses a pool made by anyone else (the config is public)
    dropMinutes: Number(env.DROP_MINUTES || 60),
    minHoldUsd: Number(env.MIN_HOLD_USD || 50),
    streaks: list(env.STREAKS || "7:1.25,30:1.5").map((s) => { const [d, x] = s.split(":"); return { days: Number(d), mult: Number(x) }; }).sort((a, b) => a.days - b.days),
    xHandle: env.X_HANDLE || "",
    demo: env.DEMO === "1",
    // Payout wallet = the DBC fee claimer = the mint's withdraw-withheld authority: its key signs refunds, sweeps and payouts.
    payout: env.PAYOUT_WALLET || "",
    exclude: list(env.EXCLUDE),            // team wallets etc. that never get airdrops
    dryRun,
    // Refunds can go live before payouts: REFUNDS_DRY_RUN "0" overrides DRY_RUN for refunds only. Unset follows DRY_RUN.
    refundsDryRun: env.REFUNDS_DRY_RUN === "0" ? false : env.REFUNDS_DRY_RUN === "1" ? true : dryRun,
    refundDeny: list(env.REFUND_DENY),     // owners that never get a refund (their withheld tokens are swept instead)
    refundMinUsd: num(env.REFUND_MIN_USD, 0.01),   // less withheld than this (in USD at the current price) is swept, not refunded
    refundMinTokens: BigInt(Math.floor(num(env.REFUND_MIN_TOKENS, 100_000))), // raw; the same floor while there is no price
    feeBatch: num(env.FEE_BATCH, 18, 1, 23), // accounts per refund or sweep transaction
    feeCooldownMs: num(env.FEE_COOLDOWN_MS, 10_000), // an account is acted on at most this often
    refundTxPerDay: num(env.REFUND_TX_PER_DAY, 50_000), // runaway brake on refund transactions per UTC day (sweeps are never braked)
    feeScanMinutes: num(env.FEE_SCAN_MINUTES, 30, 1),
    feePriority: num(env.FEE_PRIORITY_MICROLAMPORTS, 100_000), // compute-unit price on refunds, and the least a sweep pays
    feePriorityMax: num(env.FEE_PRIORITY_MAX_MICROLAMPORTS, 10_000_000), // the most a vault sweep pays per compute unit when the vault is hot
    atomicRefund: env.ATOMIC_REFUND === "1", // site buys carry the refund in the same transaction (see docs/API.md)
    maxSwapImpactBps: num(env.MAX_SWAP_IMPACT_BPS, 300, 1, 5000), // price impact (without the tax) one swap may cause
    minSwapUsd: num(env.MIN_SWAP_USD, 1),
    claimMinutes: num(env.CLAIM_MINUTES, 60, 1),    // partner trading fees (SOL) are claimed this often
    autoMigrate: env.AUTO_MIGRATE !== "0",
    solReserve: Number(env.SOL_RESERVE_LAMPORTS || 50_000_000),
    // SOL refill (USDC quote only): below REFILL_BELOW_SOL the round sells USDC for SOL, up to REFILL_TO_SOL and REFILL_MAX_USD.
    refillBelow: Math.round(num(env.REFILL_BELOW_SOL, 0.3) * 1e9), // lamports
    refillTo: Math.round(num(env.REFILL_TO_SOL, 0.6) * 1e9),       // lamports
    refillMaxUsd: num(env.REFILL_MAX_USD, 50),
    migrateMinLamports: Number(env.MIGRATE_MIN_LAMPORTS || 150_000_000), // payout SOL needed before the migration is sent
    minPayoutMicro: Math.round(Number(env.MIN_PAYOUT_USDC || 0.01) * 1e6),
    batchSize: Number(env.BATCH_SIZE || 8),
    slippageBps: Number(env.SLIPPAGE_BPS || 100),
    jup: (env.JUP_API || "https://api.jup.ag").replace(/\/$/, ""),
  };
}

export const dropMs = (cfg) => cfg.dropMinutes * 60_000;

// USD value of one whole quote token: SOL's price, or exactly 1 for USDC (a trade's USD value is its USDC amount).
export const quoteUsd = (cfg, prices) => (cfg.quoteSym === "USDC" ? 1 : prices.sol);

// Streak boost for a wallet that has held without selling for `days`.
export function streakMult(cfg, days) {
  let m = 1;
  for (const s of cfg.streaks) if (days >= s.days) m = s.mult;
  return m;
}
export const nextStreak = (cfg, days) => cfg.streaks.find((s) => days < s.days) || null;
