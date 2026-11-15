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
import { liveState, liveWallet, liveChart, RANGES } from "./live.js";
import { handleTrade, tradeReady, poolAccounts } from "./trade.js";
import { handleProfiles, syncX } from "./profiles.js";

const HOUR = 3600_000;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/api/hook" && req.method === "POST") return await handleWebhook(req, env);
      if (/^\/api\/(auth\/|me$|x\/|profile\/)/.test(url.pathname)) return await handleProfiles(req, env, url);
      // ?demo=1 previews the site with sample data, devnet only (never next to real mainnet numbers).
      const demo = url.searchParams.get("demo") === "1" && env.CLUSTER === "devnet";
      if (url.pathname === "/api/state") return json(await state(demo ? { ...env, DEMO: "1" } : env));
      if (url.pathname === "/api/chart") return json(await chart(demo ? { ...env, DEMO: "1" } : env, url.searchParams.get("range")));
      if (/^\/api\/(pool|trade|send|tx\/)/.test(url.pathname)) return await handleTrade(req, env, config(env), url.pathname);
      const m = url.pathname.match(/^\/api\/wallet\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (m) return json(await walletInfo(demo ? { ...env, DEMO: "1" } : env, m[1]));
    } catch (e) {
      if (e?.status >= 400 && e.status < 500) return json({ error: e.message }, e.status); // our own, user-facing errors
      console.error(url.pathname, e.message);
      return json({ error: "Something went wrong. Try again." }, 500);
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    const res = await env.ASSETS.fetch(req);
    if (!(res.headers.get("content-type") || "").includes("text/html")) return res;
    // Link previews need absolute URLs, for whichever domain serves the page.
    const abs = { element: (e) => e.setAttribute("content", url.origin + "/og.png") };
    return new HTMLRewriter()
      .on('meta[property="og:image"]', abs).on('meta[name="twitter:image"]', abs)
      .on("head", { element: (e) => e.append(`<meta property="og:url" content="${url.origin}/">`, { html: true }) })
      .transform(res);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env).then((r) => console.log("tick", JSON.stringify(r))));
    // Keep linked profiles matching X (each one about once a day).
    if (env.DB) ctx.waitUntil(syncX(env).then((r) => r.due && console.log("x sync", JSON.stringify(r))).catch((e) => console.error("x sync", e.message)));
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
  if (cfg.demo) return { ...base, ...demoState(cfg.dropMinutes * 60_000) };
  if (cfg.mint && env.DB) return { ...base, ...(await liveState(env, cfg)) };
  return { ...base, live: false };
}

async function chart(env, range) {
  const cfg = config(env);
  if (!(range in RANGES)) range = "24h";
  if (cfg.demo) return demoChart(range);
  if (cfg.mint && env.DB) return liveChart(env, cfg, range);
  return { range, points: [] };
}

async function walletInfo(env, address) {
  const cfg = config(env);
  if (cfg.demo) return demoWallet(cfg, address);
  if (cfg.mint && env.DB) return liveWallet(env, cfg, address);
  return { address, live: false };
}

/* ---------------- demo data (deterministic per period, so refreshes agree) ---------------- */

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

// One sample drop for period k (P = drop length in ms). Sizes scale with P so totals look the same at any cadence.
function demoDrop(k, P) {
  const r = rng(k * 7919);
  const age = (k * P - DEMO_LAUNCH) / HOUR; // hours since launch
  const growth = Math.min(1, 0.25 + age / 400);
  const usdc = round2((250 + r() * 1300) * growth * (P / HOUR));
  const holders = Math.round(900 + age * 2.6 + r() * 40);
  return { n: k - Math.floor(DEMO_LAUNCH / P), at: new Date(k * P).toISOString(), usdc, holders, tx: addr(r).slice(0, 44) + addr(r).slice(0, 44) };
}

function demoState(P = HOUR) {
  const now = Date.now();
  const cur = Math.floor(now / P);
  const first = Math.floor(DEMO_LAUNCH / P);
  let paid = 0, day = 0;
  const perDay = Math.round(86_400_000 / P);
  for (let k = first + 1; k <= cur; k++) { const u = demoDrop(k, P).usdc; paid += u; if (k > cur - perDay) day += u; }
  const drops = [];
  for (let k = cur; k > cur - 48; k--) drops.push(demoDrop(k, P));

  // Recent sells. One roughly every 2-5 minutes.
  const latest = [];
  const r = rng(Math.floor(now / HOUR));
  let t = now;
  for (let i = 0; i < 30; i++) {
    t -= (60 + r() * 240) * 1000;
    const soldUsd = Math.round(80 + r() ** 2 * 4200);
    latest.push({ wallet: addr(r), soldUsd, paidUsdc: round2(soldUsd * 0.15), at: new Date(t).toISOString() });
  }
  // The pot for the coming drop fills in step with the round, so it ends where that drop lands.
  const pending = round2(demoDrop(cur + 1, P).usdc * ((now - cur * P) / P));
  const curH = Math.floor(now / HOUR);
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
    // Volume: sells pay 15%, so sells ~= paid / 0.15; buys run a bit ahead of sells.
    totals: { paidUsdc: round2(paid), drops: cur - first, holders: drops[0].holders, volumeUsd: round2((paid / 0.15) * 2.1) },
    avgDrop24: round2(day / perDay),
    pending,
    wall: { top, latest },
    members: demoMembers(paid, cur - first),
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
  const st = demoState(cfg.dropMinutes * 60_000);
  const received = round2(st.drops.slice(0, Math.min(48, streakDays * 24 || 6)).reduce((a, d) => a + d.usdc * share, 0) * (1 + streakDays / 6));
  return {
    address, live: true, demo: true,
    balance, usd: round2(usd), eligible, streakDays, multiplier: mult,
    nextStreak: cfg.streaks.find((s) => streakDays < s.days) || null,
    share, receivedUsdc: received,
    estNext: round2(st.avgDrop24 * share),
  };
}

// Sample price history: a deterministic random walk (per hour) that ends at the sample price.
function demoChart(range) {
  const now = Date.now(), span = { "24h": 86_400_000, "7d": 7 * 86_400_000, all: now - DEMO_LAUNCH }[range];
  const n = 120, r = rng(7777 + Math.floor(now / HOUR) + span / HOUR);
  const vol = range === "24h" ? 0.018 : range === "7d" ? 0.035 : 0.05, drift = range === "all" ? 0.014 : range === "7d" ? 0.0016 : 0.0007;
  const pts = [];
  let p = DEMO_PRICE;
  for (let i = n; i >= 0; i--) {
    pts.push([Math.round(now - (span * (n - i)) / n), p]);
    p = p / Math.exp(drift + vol * (r() + r() + r() - 1.5)); // walking back in time
  }
  return { range, points: pts.reverse() };
}
// Sample members leaderboard: the biggest bags that held longest got paid most.
function demoMembers(paid, rounds) {
  const r = rng(90210);
  return Array.from({ length: 25 }, () => {
    const devotionDays = Math.floor(3 + r() * 19);
    const share = r() ** 2.6 * 0.03; // a few whales, a long tail
    return { wallet: addr(r), receivedUsdc: round2(paid * share), rounds: Math.max(1, Math.min(rounds, Math.round(devotionDays * 144 * (0.7 + r() * 0.3)))), balance: Math.round(200_000 + share * 400_000_000), devotionDays, multiplier: devotionDays >= 30 ? 1.5 : devotionDays >= 7 ? 1.25 : 1 };
  }).sort((a, b) => b.receivedUsdc - a.receivedUsdc);
}