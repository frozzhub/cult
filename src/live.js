// /api/state and /api/wallet from D1 (what the indexer has recorded).
import { streakMult, nextStreak } from "./config.js";
import { cachedPrices } from "./indexer.js";

const DAY = 86_400_000;

export async function liveState(env, cfg) {
  const db = env.DB;
  const now = Date.now();
  const { sol, token } = await cachedPrices(env, cfg, now);
  const [totals, drops, top, latest, pend, last, avg, mintRow] = await db.batch([
    db.prepare("SELECT COALESCE(SUM(usdc_micro), 0) AS paid, COUNT(*) AS drops FROM drops WHERE status = 'done'"),
    db.prepare(`SELECT n, at, usdc_micro, holders, (SELECT sig FROM batches b WHERE b.drop_n = d.n AND b.status = 'confirmed' ORDER BY i LIMIT 1) AS tx FROM drops d WHERE status = 'done' AND usdc_micro > 0 ORDER BY n DESC LIMIT 48`),
    db.prepare("SELECT wallet, sells, paid_usdc, last_at FROM sellers ORDER BY paid_usdc DESC LIMIT 25"),
    db.prepare("SELECT wallet, sol_out, fee_lamports, sol_usd, at FROM sells ORDER BY at DESC LIMIT 25"),
    db.prepare(`SELECT COALESCE(SUM(fee_lamports), 0) AS f FROM sells s WHERE drop_n IS NULL
      OR drop_n IN (SELECT n FROM drops WHERE status IN ('snapshot', 'swap'))`),
    db.prepare("SELECT holders, weight_total FROM drops WHERE status = 'done' ORDER BY n DESC LIMIT 1"),
    db.prepare("SELECT COALESCE(AVG(usdc_micro), 0) AS a FROM drops WHERE status = 'done' AND at > ?").bind(now - DAY),
    db.prepare("SELECT v FROM kv WHERE k = 'mint'"),
  ]);
  // Drops are numbered 1, 2, 3... in the order they were paid.
  const doneCount = totals.results[0].drops;
  const shown = drops.results;
  const usd = (lamports, price) => (lamports / 1e9) * price;
  return {
    live: true,
    price: token,
    eligibleSupply: last.results[0]?.weight_total || 0,
    totals: { paidUsdc: totals.results[0].paid / 1e6, drops: doneCount, holders: last.results[0]?.holders || 0 },
    avgDrop24: avg.results[0].a / 1e6,
    pending: usd(pend.results[0].f, sol),
    wall: {
      top: top.results.map((r) => ({ wallet: r.wallet, paidUsdc: r.paid_usdc, sells: r.sells, at: new Date(r.last_at).toISOString() })),
      latest: latest.results.map((r) => ({ wallet: r.wallet, soldUsd: usd(r.sol_out + r.fee_lamports, r.sol_usd), paidUsdc: usd(r.fee_lamports, r.sol_usd), at: new Date(r.at).toISOString() })),
    },
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
