// /api/state and /api/wallet from D1 (what the indexer has recorded).
import { streakMult, nextStreak } from "./config.js";
import { cachedPrices } from "./indexer.js";
import { profilesFor } from "./profiles.js";

const DAY = 86_400_000;

export async function liveState(env, cfg) {
  const db = env.DB;
  const now = Date.now();
  const { sol, token } = await cachedPrices(env, cfg, now);
  const [totals, drops, top, latest, pend, last, avg, mintRow, vol, memb] = await db.batch([
    db.prepare("SELECT COALESCE(SUM(usdc_micro), 0) AS paid, COUNT(*) AS drops FROM drops WHERE status = 'done'"),
    db.prepare(`SELECT n, at, usdc_micro, holders, (SELECT sig FROM batches b WHERE b.drop_n = d.n AND b.status = 'confirmed' ORDER BY i LIMIT 1) AS tx FROM drops d WHERE status = 'done' AND usdc_micro > 0 ORDER BY n DESC LIMIT 48`),
    db.prepare("SELECT wallet, sells, paid_usdc, last_at FROM sellers ORDER BY paid_usdc DESC LIMIT 25"),
    db.prepare("SELECT wallet, sol_out, fee_lamports, sol_usd, at FROM sells ORDER BY at DESC LIMIT 25"),
    db.prepare(`SELECT COALESCE(SUM(fee_lamports), 0) AS f FROM sells s WHERE drop_n IS NULL
      OR drop_n IN (SELECT n FROM drops WHERE status IN ('snapshot', 'swap'))`),
    db.prepare("SELECT holders, weight_total FROM drops WHERE status = 'done' ORDER BY n DESC LIMIT 1"),
    db.prepare("SELECT COALESCE(AVG(usdc_micro), 0) AS a FROM drops WHERE status = 'done' AND at > ?").bind(now - DAY),
    db.prepare("SELECT v FROM kv WHERE k = 'mint'"),
    db.prepare("SELECT COALESCE(SUM(sol_lamports / 1e9 * sol_usd), 0) AS v, COUNT(*) AS n FROM trades"),
    // Members leaderboard: most USDC actually received (confirmed batches only).
    db.prepare(`SELECT p.wallet, SUM(p.micro) AS micro, COUNT(*) AS rounds, h.balance, h.since, s.last_at
      FROM payouts p JOIN batches b ON b.drop_n = p.drop_n AND b.i = p.batch AND b.status = 'confirmed'
      LEFT JOIN holders h ON h.wallet = p.wallet LEFT JOIN sellers s ON s.wallet = p.wallet
      WHERE p.micro > 0 GROUP BY p.wallet ORDER BY micro DESC LIMIT 25`),
  ]);
  // Drops are numbered 1, 2, 3... in the order they were paid.
  const doneCount = totals.results[0].drops;
  const shown = drops.results;
  const usd = (lamports, price) => (lamports / 1e9) * price;
  // X names and pictures for everyone shown on the boards.
  const profiles = await profilesFor(db, [...top.results, ...latest.results, ...memb.results].map((r) => r.wallet)).catch(() => ({}));
  return {
    live: true,
    profiles,
    price: token,
    eligibleSupply: last.results[0]?.weight_total || 0,
    totals: { paidUsdc: totals.results[0].paid / 1e6, drops: doneCount, holders: last.results[0]?.holders || 0, volumeUsd: vol.results[0].v, trades: vol.results[0].n },
    avgDrop24: avg.results[0].a / 1e6,
    pending: usd(pend.results[0].f, sol),
    wall: {
      top: top.results.map((r) => ({ wallet: r.wallet, paidUsdc: r.paid_usdc, sells: r.sells, at: new Date(r.last_at).toISOString() })),
      latest: latest.results.map((r) => ({ wallet: r.wallet, soldUsd: usd(r.sol_out + r.fee_lamports, r.sol_usd), paidUsdc: usd(r.fee_lamports, r.sol_usd), at: new Date(r.at).toISOString() })),
    },
    members: memb.results.map((r) => {
      const dec = mintRow.results[0] ? JSON.parse(mintRow.results[0].v).decimals : 6;
      const days = r.since == null ? null : Math.floor((now - Math.max(r.since, r.last_at ?? 0)) / DAY);
      return { wallet: r.wallet, receivedUsdc: r.micro / 1e6, rounds: r.rounds, balance: r.balance ? Number(r.balance) / 10 ** dec : 0, devotionDays: days, multiplier: days == null ? 1 : streakMult(cfg, days) };
    }),
    drops: shown.map((r, i) => ({ n: doneCount - i, at: new Date(r.at).toISOString(), usdc: r.usdc_micro / 1e6, holders: r.holders, tx: r.tx })),
    decimals: mintRow.results[0] ? JSON.parse(mintRow.results[0].v).decimals : null,
  };
}

export async function liveWallet(env, cfg, address) {
  const db = env.DB;
  const now = Date.now();
  const { token: price } = await cachedPrices(env, cfg, now);
  const [h, s, got, last, avg, mintRow] = await db.batch([
    db.prepare("SELECT balance, since FROM holders WHERE wallet = ?").bind(address),
    db.prepare("SELECT last_at FROM sellers WHERE wallet = ?").bind(address),
    db.prepare(`SELECT COALESCE(SUM(p.micro), 0) AS m FROM payouts p JOIN batches b ON b.drop_n = p.drop_n AND b.i = p.batch
      WHERE p.wallet = ? AND b.status = 'confirmed'`).bind(address),
    db.prepare(`SELECT d.weight_total, (SELECT weight FROM payouts p WHERE p.drop_n = d.n AND p.wallet = ?) AS mine FROM drops d WHERE status = 'done' ORDER BY n DESC LIMIT 1`).bind(address),
    db.prepare("SELECT COALESCE(AVG(usdc_micro), 0) AS a FROM drops WHERE status = 'done' AND at > ?").bind(now - DAY),
    db.prepare("SELECT v FROM kv WHERE k = 'mint'"),
  ]);
  const decimals = mintRow.results[0] ? JSON.parse(mintRow.results[0].v).decimals : 6;
  const row = h.results[0];
  const balance = row ? Number(row.balance) / 10 ** decimals : 0;
  const start = Math.max(row?.since ?? now, s.results[0]?.last_at ?? 0);
  const streakDays = row ? Math.floor((now - start) / DAY) : 0;
  const multiplier = streakMult(cfg, streakDays);
  const usd = balance * price;
  const eligible = usd >= cfg.minHoldUsd;
  const W = last.results[0]?.weight_total || 0;
  // In the last snapshot: their exact weight. New since then: as if added to it.
  const mine = last.results[0]?.mine, w = balance * multiplier;
  const share = !eligible || !W ? 0 : mine ? mine / W : w / (W + w);
  return {
    address, live: true, balance, usd, eligible, streakDays, multiplier,
    nextStreak: nextStreak(cfg, streakDays),
    share, receivedUsdc: got.results[0].m / 1e6,
    estNext: (avg.results[0].a / 1e6) * share,
  };
}

// Price series for the chart: up to `buckets` points over the range, last price in each bucket, carried
// forward through quiet stretches, ending at the pool's price right now.
export const RANGES = { "24h": 86_400_000, "7d": 7 * 86_400_000, all: Infinity };

export function bucketSeries(trades, { from, to, buckets = 120, startPrice = null, nowPrice = null }) {
  if (!trades.length && startPrice == null) return [];
  const span = Math.max(1, to - from), size = span / buckets, out = [];
  let price = startPrice, i = 0;
  for (let b = 0; b < buckets; b++) {
    const end = from + size * (b + 1);
    let moved = false;
    while (i < trades.length && trades[i].at <= end) { price = trades[i].usd; i++; moved = true; }
    // Start once there's a price: from a trade in range, or carried in from before it (a quiet range is a flat line).
    if (price != null && (moved || out.length || startPrice != null)) out.push([Math.round(end), price]);
  }
  if (nowPrice) out.push([to, nowPrice]);
  return out;
}

export async function liveChart(env, cfg, range) {
  const now = Date.now();
  const span = RANGES[range] ?? RANGES["24h"];
  const { token } = await cachedPrices(env, cfg, now);
  const first = await env.DB.prepare("SELECT MIN(at) AS at FROM trades").first();
  if (!first?.at) return { range, points: token ? [[now, token]] : [] };
  const from = Math.max(first.at, now - span);
  const [rows, before] = await env.DB.batch([
    env.DB.prepare("SELECT at, price_sol * sol_usd AS usd FROM trades WHERE at >= ? ORDER BY at LIMIT 20000").bind(from),
    env.DB.prepare("SELECT price_sol * sol_usd AS usd FROM trades WHERE at < ? ORDER BY at DESC LIMIT 1").bind(from),
  ]);
  const points = bucketSeries(rows.results, { from, to: now, startPrice: before.results[0]?.usd ?? null, nowPrice: token || null });
  return { range, points };
}