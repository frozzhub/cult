// $PAPER Worker: serves the site, a small read-only API, the Helius webhook and the airdrop cron.
//   GET  /api/state           -> totals, next airdrop, Wall of Paper Hands, airdrop history
//   GET  /api/wallet/:address -> one holder's balance, streak, multiplier and USDC received
//   POST /api/hook            -> Helius webhook: records sells (needs HELIUS_WEBHOOK_SECRET)
//   /api/pool, /api/trade, /api/send, /api/tx/:sig -> buy/sell against the pool (trade.js)
//   cron */5 * * * *          -> moves the current airdrop forward (see indexer.js)
//
// DEMO="1" serves generated sample data. With DEMO off and no MINT, the site shows a pre-launch state.
import { config } from "./config.js";
import { handleWebhook, tick } from "./indexer.js";
import { liveState, liveWallet } from "./live.js";
import { handleTrade, tradeReady, poolAccounts } from "./trade.js";

const HOUR = 3600_000;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/api/hook" && req.method === "POST") return await handleWebhook(req, env);
      // ?demo=1 previews the site with sample data, devnet only (never next to real mainnet numbers).
      const demo = url.searchParams.get("demo") === "1" && env.CLUSTER === "devnet";
      if (url.pathname === "/api/state") return json(await state(demo ? { ...env, DEMO: "1" } : env));
      if (/^\/api\/(pool|trade|send|tx\/)/.test(url.pathname)) return await handleTrade(req, env, config(env), url.pathname);
      const m = url.pathname.match(/^\/api\/wallet\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (m) return json(await walletInfo(demo ? { ...env, DEMO: "1" } : env, m[1]));
    } catch (e) {
      console.error(url.pathname, e.message);
      return json({ error: "Something went wrong. Try again." }, 500);
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(req);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env).then((r) => console.log("tick", JSON.stringify(r))));
  },
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function nextDropAt(cfg, now = Date.now()) {
  const p = cfg.dropMinutes * 60_000;
  return new Date(Math.ceil((now + 1) / p) * p).toISOString();
}

// Only what the page needs from config (never the indexer settings).
const publicCfg = (c) => ({ cluster: c.cluster, clientRpc: c.clientRpc, ticker: c.ticker, mint: c.mint, sellTaxBps: c.sellTaxBps, dropMinutes: c.dropMinutes, minHoldUsd: c.minHoldUsd, streaks: c.streaks, xHandle: c.xHandle, demo: c.demo, trade: tradeReady(c), accounts: tradeReady(c) ? poolAccounts(c) : null });

async function state(env) {
  const cfg = config(env);
  const base = { ...publicCfg(cfg), nextDropAt: nextDropAt(cfg) };
  if (cfg.demo) return { ...base, ...demoState() };
  if (cfg.mint && env.DB) return { ...base, ...(await liveState(env, cfg)) };
  return { ...base, live: false };
}

async function walletInfo(env, address) {
  const cfg = config(env);
  if (cfg.demo) return demoWallet(cfg, address);
  if (cfg.mint && env.DB) return liveWallet(env, cfg, address);
  return { address, live: false };
}

/* ---------------- demo data (deterministic per hour, so refreshes agree) ---------------- */

function rng(seed) {
  let s = typeof seed === "string" ? [...seed].reduce((a, c) => (Math.imul(a ^ c.charCodeAt(0), 2654435761) >>> 0), 2166136261) : seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const addr = (r) => Array.from({ length: 44 }, () => B58[Math.floor(r() * 58)]).join("");
const round2 = (n) => Math.round(n * 100) / 100;

const DEMO_LAUNCH = Date.parse("2026-10-27T00:00:00Z");
const DEMO_SUPPLY = 1_000_000_000;
const DEMO_PRICE = 0.00042; // USD per token
const DEMO_ELIGIBLE = 612_000_000; // tokens held by eligible wallets, streak-weighted

function demoDrop(h) {
  const r = rng(h * 7919);
  const age = (h * HOUR - DEMO_LAUNCH) / HOUR;
  const growth = Math.min(1, 0.25 + age / 400);
  const usdc = round2((250 + r() * 1300) * growth);
  const holders = Math.round(900 + age * 2.6 + r() * 40);
  return { n: Math.round(age), at: new Date(h * HOUR).toISOString(), usdc, holders, tx: addr(r).slice(0, 44) + addr(r).slice(0, 44) };
}

function demoState() {
  const now = Date.now();
  const curH = Math.floor(now / HOUR);
  const firstH = Math.floor(DEMO_LAUNCH / HOUR);
  let paid = 0;
  for (let h = firstH + 1; h <= curH; h++) paid += demoDrop(h).usdc;
  const drops = [];
  for (let h = curH; h > curH - 48; h--) drops.push(demoDrop(h));
  const avg24 = drops.slice(0, 24).reduce((a, d) => a + d.usdc, 0) / 24;

  // Sells since the last drop build the pending pot. One sell roughly every 2-5 minutes.
  const latest = [];
  const r = rng(curH);
  let t = now;
  for (let i = 0; i < 30; i++) {
    t -= (60 + r() * 240) * 1000;
    const soldUsd = Math.round(80 + r() ** 2 * 4200);
    latest.push({ wallet: addr(r), soldUsd, paidUsdc: round2(soldUsd * 0.15), at: new Date(t).toISOString() });
  }
  // The pot for the coming drop fills in step with the hour, so it ends where that drop lands.
  const pending = round2(demoDrop(curH + 1).usdc * ((now - curH * HOUR) / HOUR));

  const rt = rng(424242 + Math.floor(curH / 6));
  const top = Array.from({ length: 25 }, () => {
    const paidUsdc = round2(150 + rt() ** 3 * 9000);
    return { wallet: addr(rt), paidUsdc, sells: 1 + Math.floor(rt() * 30), at: new Date(now - rt() * 9 * 86400_000).toISOString() };
  }).sort((a, b) => b.paidUsdc - a.paidUsdc);

  return {
    live: true,
    demo: true,
    price: DEMO_PRICE,
    supply: DEMO_SUPPLY,
    eligibleSupply: DEMO_ELIGIBLE,
    totals: { paidUsdc: round2(paid), drops: curH - firstH, holders: drops[0].holders },
    avgDrop24: round2(avg24),
    pending,
    wall: { top, latest },
    drops,
  };
}

function demoWallet(cfg, address) {
  const r = rng(address);
  const balance = Math.round(40_000 + r() ** 2 * 6_000_000);
  const streakDays = Math.floor(r() * 36);
  const tier = [...cfg.streaks].reverse().find((s) => streakDays >= s.days);
  const mult = tier ? tier.mult : 1;
  const usd = balance * DEMO_PRICE;
  const eligible = usd >= cfg.minHoldUsd;
  const share = eligible ? (balance * mult) / DEMO_ELIGIBLE : 0;
  const st = demoState();
  const received = round2(st.drops.slice(0, Math.min(48, streakDays * 24 || 6)).reduce((a, d) => a + d.usdc * share, 0) * (1 + streakDays / 6));
  return {
    address, live: true, demo: true,
    balance, usd: round2(usd), eligible, streakDays, multiplier: mult,
    nextStreak: cfg.streaks.find((s) => streakDays < s.days) || null,
    share, receivedUsdc: received,
    estNext: round2(st.avgDrop24 * share),
  };
}
