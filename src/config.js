// All settings in one place. Vars live in wrangler.jsonc, secrets in `wrangler secret put`.
import { PublicKey } from "@solana/web3.js";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function config(env) {
  const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
  const cfg = {
    cluster: env.CLUSTER === "devnet" ? "devnet" : "mainnet",
    clientRpc: env.CLIENT_RPC || "",       // set: the browser reads the pool and sends trades through this RPC itself
    ticker: env.TICKER || "CULT",
    mint: env.MINT || "",
    sellTaxBps: Number(env.SELL_TAX_BPS || 1500),
    dropMinutes: Number(env.DROP_MINUTES || 60),
    minHoldUsd: Number(env.MIN_HOLD_USD || 50),
    streaks: list(env.STREAKS || "7:1.25,30:1.5").map((s) => { const [d, x] = s.split(":"); return { days: Number(d), mult: Number(x) }; }).sort((a, b) => a.days - b.days),
    xHandle: env.X_HANDLE || "",
    demo: env.DEMO === "1",
    // Indexer
    poolProgram: env.POOL_PROGRAM || "",   // programs/paper-pool
    hookProgram: env.HOOK_PROGRAM || "",   // programs/paper-hook
    pool: env.POOL_ACCOUNT || "",          // the pool PDA (owner of its token vault): sold tokens land here
    payout: env.PAYOUT_WALLET || "",       // receives the 15% in SOL, swaps it and pays holders
    exclude: list(env.EXCLUDE),            // team wallets etc. that never get airdrops
    dryRun: env.DRY_RUN !== "0",           // on unless explicitly turned off
    solReserve: Number(env.SOL_RESERVE_LAMPORTS || 50_000_000),
    minPayoutMicro: Math.round(Number(env.MIN_PAYOUT_USDC || 0.01) * 1e6),
    batchSize: Number(env.BATCH_SIZE || 8),
    slippageBps: Number(env.SLIPPAGE_BPS || 100),
    jup: (env.JUP_API || "https://lite-api.jup.ag").replace(/\/$/, ""),
  };
  // The pool PDA follows from the pool program and the mint, so POOL_ACCOUNT is optional.
  if (!cfg.pool && cfg.poolProgram && cfg.mint) {
    try { cfg.pool = PublicKey.findProgramAddressSync([new TextEncoder().encode("pool"), new PublicKey(cfg.mint).toBytes()], new PublicKey(cfg.poolProgram))[0].toBase58(); } catch {}
  }
  return cfg;
}

export const dropMs = (cfg) => cfg.dropMinutes * 60_000;

// Streak boost for a wallet that has held without selling for `days`.
export function streakMult(cfg, days) {
  let m = 1;
  for (const s of cfg.streaks) if (days >= s.days) m = s.mult;
  return m;
}
export const nextStreak = (cfg, days) => cfg.streaks.find((s) => days < s.days) || null;
