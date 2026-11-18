// The airdrop engine.
//
// Helius webhook  -> records every buy and sell, queues the token accounts they touched for refunds (fees.js).
// Cron every min  -> mint poller (the same, from RPC), refunds and sweeps (fees.js), the curve (dbc.js), then moves the
//                    current airdrop one step at a time:
//   snapshot  every holder, their streak boost and weight; who needs a USDC account opened
//   sweep     the withheld CULT in pool vaults and the mint goes to the treasury (the payout wallet's token account)
//   swap      the treasury's CULT -> USDC on Jupiter (as much as fits MAX_SWAP_IMPACT_BPS), then spare SOL -> USDC
//   allocate  split the wallet's USDC by weight into fixed batches
//   paying    sign + send each batch; check them on later ticks until all land
//   done
// Every step is saved in D1 before anything is sent, so a crash or an overlapping tick resumes where it
// stopped and never pays a batch twice:
//   - a batch is claimed with a conditional UPDATE (status = 'pending') BEFORE it is sent, and only the run that
//     changed the row sends it;
//   - the tick lock lasts the platform's 15 minutes and is refreshed before every step and every send; a run that
//     lost it stops (see `fence`);
//   - a batch is only re-sent once its old transaction has failed on chain, or its blockhash expired by a margin
//     and getTransaction still can't find it. A transaction that is "processed" is never re-sent.
import { config, dropMs, streakMult, ADDR, SOL_MINT } from "./config.js";
import * as chain from "./chain.js";
import { LockLost } from "./chain.js";
import { onCurve, treasuryAta, parseMint, parseTokenAccount } from "./token22.js";
import { rpcChanges, enhancedChanges, touchedAccounts, readTrade } from "./trades.js";
import * as fees from "./fees.js";
import * as jup from "./jupiter.js";
import { dbcTick, poolProblem } from "./dbc.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const DAY = 86_400_000;
const MIN_SWAP_LAMPORTS = 10_000_000; // don't bother swapping under 0.01 SOL
const BATCHES_PER_TICK = 40;
const MAX_TRIES = 5;
const LOCK_MS = 15 * 60_000;  // Cloudflare's wall-time limit for one scheduled run
const SPLIT_AT = 2;           // failures before a batch is split into one transaction per holder

/* ---------------- pure helpers (unit tested) ---------------- */

// Split `pot` (micro-USDC) by weight. Amounts under `min` are dropped and roll into the next airdrop.
// A holder without a USDC account pays for opening it: `rent` (micro-USDC) comes off their own share, so nobody else's
// share shrinks and a fresh wallet can't farm the rent out of the pot. What's taken stays in the wallet.
export function allocate(rows, pot, min, batchSize, rent = 0) {
  const total = rows.reduce((a, r) => a + r.weight, 0);
  if (!total || pot <= 0) return { paid: [], total: 0 };
  const paid = [];
  for (const r of rows) {
    const micro = Math.floor((pot * r.weight) / total) - (r.needs_ata ? rent : 0);
    if (micro >= min) paid.push({ wallet: r.wallet, micro, needs_ata: r.needs_ata });
  }
  paid.sort((a, b) => b.micro - a.micro);
  paid.forEach((p, i) => (p.batch = Math.floor(i / batchSize)));
  return { paid, total: paid.reduce((a, p) => a + p.micro, 0) };
}

// What opening one USDC account costs, in micro-USDC at this SOL price. Rounded up: toward the house.
export const rentMicro = (solUsd) => Math.ceil((chain.ATA_RENT * solUsd) / 1000);

// Only wallets with a key can be paid. A program-owned address (a pool's vault owner) is off the curve: it would
// otherwise be paid most of the pot into an account nobody can move.

// Holder map -> eligible rows with streak-boosted weights.
export function weigh(cfg, { holders, since, lastSell, decimals, price, now }) {
  const skip = new Set([cfg.payout, ...cfg.exclude]);
  const rows = [];
  for (const [wallet, raw] of holders) {
    if (skip.has(wallet) || !onCurve(wallet)) continue;
    const tokens = Number(raw) / 10 ** decimals;
    if (tokens * price < cfg.minHoldUsd) continue;
    const start = Math.max(since.get(wallet) ?? now, lastSell.get(wallet) ?? 0);
    const mult = streakMult(cfg, Math.floor((now - start) / DAY));
    rows.push({ wallet, weight: tokens * mult });
  }
  return rows;
}

/* ---------------- D1 helpers ---------------- */

const kvGet = async (db, k) => { const r = await db.prepare("SELECT v, at FROM kv WHERE k = ?").bind(k).first(); return r ? { v: JSON.parse(r.v), at: r.at } : null; };
const kvSet = (db, k, v, at = Date.now()) => db.prepare("INSERT INTO kv (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at").bind(k, JSON.stringify(v), at).run();

// SOL and CULT prices in USD from Jupiter's price API (keyed: JUP_API + x-api-key), cached 60 s in kv. A figure Jupiter
// doesn't give keeps its last good value, and a coin Jupiter hasn't priced yet falls back to the curve's own price
// (dbc.js keeps it in kv). Never 0 into a snapshot: with nothing known the answer is { sol: 0, token: 0 } and the
// callers refuse. After a failure the next try is 30 s away, not 60 s of hammering a down API.
export async function cachedPrices(env, cfg, now = Date.now()) {
  const c = await kvGet(env.DB, "price");
  if (c && now - c.at < 60_000) return c.v;
  const last = c?.v || { sol: 0, token: 0 };
  let got = { sol: 0, token: 0 }, ok = true;
  try { got = await chain.prices(env, cfg); } catch (e) { ok = false; console.error("price", e.message); }
  const sol = got.sol > 0 ? got.sol : last.sol;
  let token = got.token > 0 ? got.token : last.token;
  if (!(token > 0) && sol > 0) {
    const cur = (await kvGet(env.DB, "curve"))?.v;
    if (cur?.priceSol > 0 && now - cur.at < 600_000) token = cur.priceSol * sol;
  }
  const v = { sol, token };
  // A coin with no price yet is asked about again at the next call (the curve read may have arrived since, and a new coin is
  // exactly when Jupiter has no price); after a failed call the next try is 30 s away.
  if (sol > 0 || token > 0) await kvSet(env.DB, "price", v, !(token > 0) ? now - 60_000 : ok ? now : now - 30_000);
  return v;
}

/* ---------------- trades and sells ---------------- */

// One buy or sell, stored once (the webhook and the poller can both see it). A sell also goes on the Wall.
// usd values use the price known now: a few seconds old from the webhook, a minute or so from the poller.
export async function recordTrade(env, t, at, prices, decimals) {
  const tokens = Number(t.tokens), whole = tokens / 10 ** decimals;
  const usd = whole * prices.token, feeUsd = (Number(t.withheld) / 10 ** decimals) * prices.token;
  const r = await env.DB.prepare(`INSERT OR IGNORE INTO trades (sig, at, side, wallet, sol_lamports, price_sol, sol_usd, fee_lamports, tokens, withheld, usd, price_usd)
    VALUES (?, ?, ?, ?, 0, ?, ?, 0, ?, ?, ?, ?)`).bind(t.sig, at, t.side, t.wallet, prices.sol > 0 ? prices.token / prices.sol : 0, prices.sol, tokens, Number(t.withheld), usd, prices.token).run();
  if (!r.meta.changes || t.side !== "sell") return false;
  const s = await env.DB.prepare("INSERT OR IGNORE INTO sells (sig, wallet, tokens, sol_out, fee_lamports, sol_usd, at, fee_tokens, usd, fee_usd) VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?)")
    .bind(t.sig, t.wallet, whole, prices.sol, at, Number(t.withheld), usd, feeUsd).run();
  if (!s.meta.changes) return false;
  await env.DB.prepare(`INSERT INTO sellers (wallet, sells, paid_usdc, last_at) VALUES (?, 1, ?, ?)
    ON CONFLICT(wallet) DO UPDATE SET sells = sells + 1, paid_usdc = paid_usdc + excluded.paid_usdc, last_at = MAX(last_at, excluded.last_at)`)
    .bind(t.wallet, feeUsd, at).run();
  return true;
}

// Queue every token account of the coin a transaction touched for the refund engine (owner included when it is known).
export const queueEntries = (c) => [...new Map([...c.changes.map((x) => [x.address, x.owner]), ...(c.touched || []).map((a) => [a, null])]).entries()].map(([address, owner]) => ({ address, owner }));

// Every $CULT token account a transaction touched, with its balance after it: [{ address, owner, amount }].
export function parseTokenBalances(tx, cfg) {
  if (!tx || tx.meta?.err) return [];
  const keys = (tx.transaction?.message?.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
  return (tx.meta.postTokenBalances || [])
    .filter((b) => b.mint === cfg.mint && b.owner && keys[b.accountIndex])
    .map((b) => ({ address: keys[b.accountIndex], owner: b.owner, amount: String(b.uiTokenAmount?.amount || "0") }));
}

const MAX_TX_PER_TICK = 300; // keeps a tick well inside Workers' subrequest limit; the rest waits for the next one

// Walks the mint's transaction history (every transfer references the mint): records buys and sells, queues the token
// accounts each one touched for refunds, and keeps the holder index (token_accounts) current. Oldest first; the cursor
// only moves past what was processed. Without a price nothing is recorded and the cursor stays (the same transactions
// are read again next tick; every write here is idempotent), but the accounts are still queued: refunds need no price.
export async function pollMint(env, cfg, now = Date.now()) {
  if (!cfg.mint || env.POLL_SELLS === "0") return { polled: 0 };
  const cursor = (await kvGet(env.DB, "poll_cursor"))?.v;
  const pageSize = Number(env.POLL_PAGE || 1000);
  const sigs = [];
  let before;
  for (let page = 0; page < 50; page++) {
    const r = await chain.rpc(env, "getSignaturesForAddress", [cfg.mint, { limit: pageSize, ...(cursor ? { until: cursor } : {}), ...(before ? { before } : {}) }]);
    sigs.push(...(r || []));
    if (!r || r.length < pageSize) break;
    before = r[r.length - 1].signature;
  }
  if (!sigs.length) { await kvSet(env.DB, "poll_state", { behind: 0, ok: true }, now); return { polled: 0 }; }
  const batch = sigs.reverse().slice(0, MAX_TX_PER_TICK); // oldest first
  const prices = await cachedPrices(env, cfg, now);
  const priced = prices.token > 0 && prices.sol > 0;
  const decimals = (await mint(env, cfg)).decimals;
  let added = 0;
  const queue = [];
  for (const s of batch) {
    if (s.err) continue;
    if (env.POLL_GAP_MS) await new Promise((r) => setTimeout(r, Number(env.POLL_GAP_MS))); // gentle on free RPC tiers
    // maxSupportedTransactionVersion 1: mainnet carries version-1 transactions, and the RPC errors on one with 0.
    const tx = await chain.rpc(env, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
    const accts = parseTokenBalances(tx, cfg);
    if (accts.length) {
      await env.DB.prepare(`INSERT INTO token_accounts (address, owner, amount, slot)
        SELECT json_extract(value, '$.address'), json_extract(value, '$.owner'), json_extract(value, '$.amount'), ?2 FROM json_each(?1) WHERE true
        ON CONFLICT(address) DO UPDATE SET owner = excluded.owner, amount = excluded.amount, slot = excluded.slot WHERE excluded.slot >= token_accounts.slot`)
        .bind(JSON.stringify(accts), Number(tx.slot || 0)).run();
    }
    const c = rpcChanges(tx, cfg.mint);
    if (!c) continue;
    queue.push(...queueEntries(c));
    const t = priced && readTrade(c, { payout: cfg.payout, taxBps: cfg.sellTaxBps });
    if (t && (await recordTrade(env, { ...t, sig: s.signature }, c.at || Date.now(), prices, decimals))) added++;
  }
  if (queue.length) await fees.enqueue(env.DB, queue, now);
  if (!priced) { await kvSet(env.DB, "poll_state", { behind: sigs.length, ok: false }, now); return { polled: 0, noPrice: true }; }
  await kvSet(env.DB, "poll_cursor", batch[batch.length - 1].signature, now);
  await kvSet(env.DB, "poll_state", { behind: sigs.length - batch.length, ok: true }, now);
  return { polled: batch.length, added, behind: sigs.length - batch.length };
}

// Holders from our own index: Map(owner -> raw balance).
export async function indexedHolders(db) {
  const rows = (await db.prepare("SELECT owner, amount FROM token_accounts WHERE amount != '0'").all()).results;
  const out = new Map();
  for (const r of rows) out.set(r.owner, (out.get(r.owner) || 0n) + BigInt(r.amount));
  return out;
}

async function mint(env, cfg) {
  const c = await kvGet(env.DB, "mint");
  if (c?.v?.mint === cfg.mint) return c.v;
  const m = { mint: cfg.mint, ...(await chain.mintInfo(env, cfg.mint)) };
  await kvSet(env.DB, "mint", m);
  return m;
}

// Insert/update many rows in one statement through json_each (keeps us far under D1's query limits).
async function jsonRows(db, sql, rows, ...binds) {
  for (let i = 0; i < rows.length; i += 1000) await db.prepare(sql).bind(JSON.stringify(rows.slice(i, i + 1000)), ...binds).run();
}

// `where` (SQL with ? marks, values in `args`) makes the update conditional: a status change names the status it
// expects, so a run that fell behind can't move the drop backwards. Returns the row as it is now, so the caller can
// tell whether its update took (the row still shows the old status, or another run's signature).
async function setDrop(db, n, fields, where = "", ...args) {
  const keys = Object.keys(fields);
  await db.prepare(`UPDATE drops SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated = ? WHERE n = ?${where ? ` AND ${where}` : ""}`)
    .bind(...keys.map((k) => fields[k]), Date.now(), n, ...args).run();
  return db.prepare("SELECT * FROM drops WHERE n = ?").bind(n).first();
}

const settleSent = chain.settleSent;

/* ---------------- webhook ---------------- */

// A Helius "enhanced" webhook on the mint. For each transaction: queue the token accounts it touched for refunds, and (when
// refunds are live) refund the wallet-owned ones right away, after answering Helius (ctx.waitUntil) so the buyer's refund
// is on chain within seconds of the buy. Then record the buy or sell. Refunds need no price, so they come first.
export async function handleWebhook(req, env, ctx) {
  const cfg = config(env);
  const secret = env.HELIUS_WEBHOOK_SECRET;
  if (!secret || req.headers.get("authorization") !== secret) return new Response("unauthorized", { status: 401 });
  if (!cfg.mint || !ADDR.test(cfg.payout)) return Response.json({ ok: true, ignored: "not configured" });
  const body = await req.json().catch(() => null);
  const txs = Array.isArray(body) ? body : body ? [body] : [];
  const queue = [], trades = [];
  for (const tx of txs) {
    const c = enhancedChanges(tx, cfg.mint);
    if (!c) continue;
    queue.push(...queueEntries(c));
    const t = readTrade(c, { payout: cfg.payout, taxBps: cfg.sellTaxBps });
    if (t) trades.push({ ...t, sig: c.sig, at: c.at || Date.now() });
  }
  await refundNow(env, cfg, ctx, queue);
  let added = 0;
  if (trades.length) {
    const prices = await cachedPrices(env, cfg);
    if (!(prices.token > 0 && prices.sol > 0)) return Response.json({ error: "No price yet." }, { status: 503 }); // Helius sends it again
    const decimals = (await mint(env, cfg)).decimals;
    for (const t of trades) if (await recordTrade(env, t, t.at, prices, decimals)) added++; // false = a retry of one we have
  }
  return Response.json({ ok: true, added, queued: queue.length });
}

// Queue accounts, then run the refund engine on them (after the response when there is a ctx).
async function refundNow(env, cfg, ctx, entries) {
  if (!entries.length) return;
  await fees.enqueue(env.DB, entries);
  if (cfg.refundsDryRun) return;
  const work = fees.runFees(env, cfg, fees.realDeps(env), { only: entries.map((e) => e.address), kinds: ["refund"] }).catch((e) => console.error("refund", e.message));
  if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
}

// The site tells us a signature after a buy confirms; we read it from the chain ourselves (the browser's word is only a hint
// to look now) and queue and refund the accounts it touched. Same path as the webhook, for a Helius that is slow.
// `refunded` is read from the chain again here, so the page can poll this to see the refund land: true once none of the
// wallet-owned accounts the transaction touched holds withheld tokens (a pool vault's tax is not the buyer's business).
export async function hintSignature(env, cfg, sig, ctx) {
  if (!cfg.mint || !ADDR.test(cfg.payout)) return { queued: 0, refunded: false };
  const tx = await chain.rpc(env, "getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
  const c = rpcChanges(tx, cfg.mint);
  if (!c) return { queued: 0, refunded: false };
  const entries = queueEntries(c);
  await refundNow(env, cfg, ctx, entries);
  const read = await chain.getAccounts(env, entries.map((e) => e.address)).catch(() => null); // unknown is "not yet", never "refunded"
  const refunded = !!read && entries.length > 0 && entries.every((e) => {
    const a = parseTokenAccount(read.get(e.address));
    return !a || a.mint !== cfg.mint || !onCurve(a.owner) || a.withheld === 0n;
  });
  return { queued: entries.length, refunded };
}

/* ---------------- cron tick ---------------- */

// The tick pays out whatever the payout wallet holds, and only the mint's withdraw-withheld authority can move the tax
// into it. So the tick only runs when PAYOUT_WALLET is that authority. The mint can't change it (no config authority), so
// a pass is remembered, for these settings: a changed one is checked again. Also refused: a fee that isn't SELL_TAX_BPS, a mint
// that can still be minted or frozen, and (when DBC_CONFIG or CREATOR is set) a curve pool that isn't ours: the DBC config is
// public, so a stranger's copy of the coin on it passes every other check. Anything unknown (mint unreadable, not a Token-2022
// mint) is a refusal. Returns the reason, or null.
async function payoutProblem(env, cfg) {
  const want = { mint: cfg.mint, payout: cfg.payout, tax: cfg.sellTaxBps, config: cfg.dbcConfig, creator: cfg.creator };
  const c = await kvGet(env.DB, "payout_check");
  if (c && Object.keys(want).every((k) => c.v[k] === want[k])) return null;
  let m;
  try { m = parseMint((await chain.getAccounts(env, [cfg.mint])).get(cfg.mint)); }
  catch (e) { return `Couldn't read the mint to check its withdraw authority (${e.message}).`; }
  if (!m) return "MINT isn't a Token-2022 mint.";
  if (m.withdrawAuthority !== cfg.payout) return "PAYOUT_WALLET is not the wallet that can withdraw this mint's withheld tokens.";
  if (m.feeBps !== cfg.sellTaxBps) return `The mint's transfer fee is ${m.feeBps} bps but SELL_TAX_BPS is ${cfg.sellTaxBps}. Check MINT, or set SELL_TAX_BPS to match.`;
  if (m.mintAuthority || m.freezeAuthority) return "This mint can still be minted or frozen by its authority. Check MINT.";
  const pool = await poolProblem(env, cfg);
  if (pool) return pool;
  await kvSet(env.DB, "payout_check", want);
  return null;
}

// Refunds and sweeps every tick (cooldowns keep one account from being acted on over and over), and the full scan for
// anything the webhook or the poller missed every FEE_SCAN_MINUTES. Best effort: a failure never stops the round.
async function feeWork(env, cfg, now) {
  try {
    const scan = await kvGet(env.DB, "fee_scan");
    if (!scan || now - scan.at >= cfg.feeScanMinutes * 60_000) await kvSet(env.DB, "fee_scan", await fees.scanWithheld(env, cfg), now);
    return await fees.runFees(env, cfg);
  } catch (e) { console.error("fees", e.message); return { error: e.message }; }
}

export async function tick(env, now = Date.now()) {
  env = chain.cronEnv(env);
  const cfg = config(env);
  if (!cfg.mint || !ADDR.test(cfg.payout)) return { skipped: "MINT and PAYOUT_WALLET must be set" };
  const db = env.DB;
  const token = JSON.stringify(crypto.randomUUID());
  const got = await db.prepare("INSERT INTO kv (k, v, at) VALUES ('lock', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at WHERE kv.at < ?")
    .bind(token, now + LOCK_MS, now).run();
  if (!got.meta.changes) return { skipped: "another tick is running" };
  // Called before every step and every send. Pushes the lock out another 15 minutes (the real clock, not the tick's
  // `now`) while it is still ours; when another run has taken it, this run stops and writes nothing more.
  const fence = async () => {
    const r = await db.prepare("UPDATE kv SET at = ? WHERE k = 'lock' AND v = ?").bind(Date.now() + LOCK_MS, token).run();
    if (!r.meta.changes) throw new LockLost("lost the tick lock");
  };
  let d;
  try {
    const refuse = await payoutProblem(env, cfg);
    if (refuse) { console.error("tick refused:", refuse); return { skipped: refuse }; }
    await cachedPrices(env, cfg, now);
    const polled = await pollMint(env, cfg, now).catch((e) => ({ pollError: e.message }));
    if (polled.pollError) console.error("poll", polled.pollError);
    await fence();
    const feeRun = await feeWork(env, cfg, now);
    await fence();
    await dbcTick(env, cfg, cfg.dryRun ? null : chain.payoutKeypair(env, cfg), fence, now);
    await fence();
    d = await db.prepare("SELECT * FROM drops WHERE status NOT IN ('done', 'skipped') ORDER BY n LIMIT 1").first();
    if (!d) d = await openNext(db, cfg, now);
    if (!d) return { idle: true, fees: feeRun };
    for (let i = 0; i < 6; i++) {
      await fence();
      const before = d.status;
      d = await STEPS[before](env, cfg, d, now, fence);
      if (d.status === before || d.status === "done" || d.status === "skipped") break;
    }
    return { drop: d.n, status: d.status };
  } catch (e) {
    if (e instanceof LockLost) { console.error("tick stopped:", e.message); return { skipped: e.message }; }
    console.error("tick", e.message);
    if (d) await setDrop(db, d.n, { error: String(e.message).slice(0, 500) });
    return { error: e.message };
  } finally {
    await db.prepare("DELETE FROM kv WHERE k = 'lock' AND v = ?").bind(token).run();
  }
}

async function openNext(db, cfg, now) {
  const n = Math.floor(now / dropMs(cfg));
  const last = await db.prepare("SELECT MAX(n) AS n FROM drops").first();
  if (last?.n != null && last.n >= n) return null;
  const at = n * dropMs(cfg);
  await db.prepare("INSERT INTO drops (n, at, status, updated) VALUES (?, ?, 'snapshot', ?)").bind(n, at, now).run();
  await db.prepare("UPDATE sells SET drop_n = ? WHERE drop_n IS NULL AND at < ?").bind(n, at).run();
  const fee = await db.prepare("SELECT COALESCE(SUM(fee_usd), 0) AS f FROM sells WHERE drop_n = ?").bind(n).first();
  return setDrop(db, n, { fee_usd: fee.f });
}

// The treasury's CULT balance (the payout wallet's Token-2022 account), raw units, read at "confirmed". A missing account is 0.
async function treasuryBalance(env, cfg) {
  try { return BigInt((await chain.rpc(env, "getTokenAccountBalance", [treasuryAta(cfg.mint, cfg.payout).toBase58(), { commitment: "confirmed" }]))?.value?.amount || 0); }
  catch (e) { if (/could not find account|Invalid param/i.test(e.message)) return 0n; throw e; }
}

// Leg 1 of the swap: sell the treasury's CULT for USDC. As much as fits MAX_SWAP_IMPACT_BPS (price impact without the
// tax); the rest waits for a later round, and so does an amount worth less than MIN_SWAP_USD. Our own sale pays the tax
// into the vault again: expected, and it comes back at the next sweep. Returns { d, done }.
async function cultLeg(env, cfg, d, fence) {
  const db = env.DB;
  if (d.cult_sig) {
    if (d.cult_sig === "dry-run" || d.cult_sig === "none") return { d, done: true };
    const st = (await settleSent(env, [{ sig: d.cult_sig, lvbh: d.cult_lvbh }]))[d.cult_sig];
    if (st === "confirmed") return { d, done: true };
    if (st === "failed" || st === "lost") {
      d = await setDrop(db, d.n, { cult_sig: null, cult_lvbh: null, cult_amount: null, cult_out: null, error: "The CULT swap didn't land, retrying." }, "status = 'swap' AND cult_sig = ?", d.cult_sig);
    }
    return { d, done: false }; // still landing, or cleared and tried again next tick
  }
  const skip = async (mark) => ({ d: await setDrop(db, d.n, { cult_sig: mark }, "status = 'swap' AND cult_sig IS NULL"), done: true });
  if (cfg.dryRun) return skip("dry-run");
  if (env.SWAP === "off") return skip("none");
  const kp = chain.payoutKeypair(env, cfg);
  const raw = await treasuryBalance(env, cfg);
  const { token: price } = await cachedPrices(env, cfg);
  const decimals = (await mint(env, cfg)).decimals;
  const usdOf = (n) => (Number(n) / 10 ** decimals) * price;
  if (raw <= 0n) return skip("none");
  if (!(price > 0)) throw new Error("No $CULT price yet. Retrying next tick.");
  if (usdOf(raw) < cfg.minSwapUsd) return skip("none");
  const out = chain.payMint(env).toBase58();
  let amount = raw, q = null;
  for (let i = 0; i < 5 && !q; i++) {
    const got = await jup.quote(env, cfg, { inputMint: cfg.mint, outputMint: out, amount: String(amount), slippageBps: cfg.slippageBps });
    const impact = jup.impactBps(got, cfg.sellTaxBps);
    if (impact <= cfg.maxSwapImpactBps) { q = got; break; }
    // Impact grows about in step with size: cut to what should fit, with a margin, and look again.
    amount = BigInt(Math.floor(Number(amount) * (cfg.maxSwapImpactBps / impact) * 0.9));
    if (usdOf(amount) < cfg.minSwapUsd) return skip("none");
  }
  if (!q) return skip("none");
  const s = await jup.treasurySwap(env, cfg, kp, { inputMint: cfg.mint, inputProgram: TOKEN_2022_PROGRAM_ID.toBase58(), outputMint: out, outputProgram: TOKEN_PROGRAM_ID.toBase58(), amount: String(amount), quoteResponse: q });
  await fence();
  // Claimed (only while no signature is saved) before it is sent, like the SOL leg.
  d = await setDrop(db, d.n, { cult_sig: s.sig, cult_lvbh: s.lvbh || (await chain.blockHeight(env)) + 150, cult_amount: String(amount), cult_out: s.outMicro }, "status = 'swap' AND cult_sig IS NULL");
  if (d.cult_sig !== s.sig) return { d, done: false };
  await chain.sendTx(env, s.tx);
  for (let i = 0; i < 8; i++) { // usually lands in a few seconds
    await new Promise((r) => setTimeout(r, 2500));
    if ((await chain.sigStatuses(env, [s.sig]))[s.sig] === "confirmed") return { d, done: true };
  }
  return { d, done: false };
}

const STEPS = {
  async snapshot(env, cfg, d, now, fence) {
    const db = env.DB;
    const { token: price } = await cachedPrices(env, cfg, now);
    if (!price) throw new Error("No $CULT price yet. Retrying next tick.");
    const m = await mint(env, cfg);
    // Our own index only makes sense once the poller has caught up with the mint's history. The same test guards the
    // fallback below: a stale or empty index must not stand in for a failed live snapshot.
    const ps = await kvGet(db, "poll_state");
    const caught = !!ps?.v?.ok && ps.v.behind === 0 && ps.at >= d.at;
    const waiting = () => setDrop(db, d.n, { error: "Waiting for the holder index to catch up." });
    let holders;
    if (env.HOLDERS === "index") {
      if (!caught) return waiting();
      holders = await indexedHolders(db);
    } else {
      // Prefer a live snapshot (Helius DAS etc.); if the RPC can't do one, use our own index from the mint's history.
      try { holders = await chain.tokenHolders(env, cfg.mint, m.program); }
      catch (e) {
        console.error("snapshot fell back to the index:", e.message);
        if (!caught) return waiting();
        holders = await indexedHolders(db);
      }
    }

    // An empty list, or one that lost more than half the holders, is a bad read, not everyone leaving (the pool's own
    // vault always holds). Taking it as true would delete every holder's streak for good, so stop and read again.
    const prev = (await db.prepare("SELECT wallet, since FROM holders").all()).results;
    if (!holders.size) throw new Error("The holder list came back empty. Retrying next tick.");
    if (prev.length >= 20 && holders.size * 2 < prev.length && env.ALLOW_HOLDER_DROP !== "1")
      throw new Error(`The holder count fell from ${prev.length} to ${holders.size}. Holding this round until it's checked.`);

    await fence();
    // Keep each holder's `since`; anyone who's gone drops out (and starts fresh if they come back).
    const since = new Map(prev.map((r) => [r.wallet, r.since]));
    await jsonRows(db, `INSERT INTO holders (wallet, balance, since, seen)
      SELECT json_extract(value, '$.w'), json_extract(value, '$.b'), ?2, ?3 FROM json_each(?1) WHERE true
      ON CONFLICT(wallet) DO UPDATE SET balance = excluded.balance, seen = excluded.seen`,
      [...holders].map(([w, b]) => ({ w, b: b.toString() })), now, d.n);
    await db.prepare("DELETE FROM holders WHERE seen < ?").bind(d.n).run();

    const lastSell = new Map((await db.prepare("SELECT wallet, last_at FROM sellers").all()).results.map((r) => [r.wallet, r.last_at]));
    const rows = weigh(cfg, { holders, since, lastSell, decimals: m.decimals, price, now });
    if (!rows.length) return setDrop(db, d.n, { status: "skipped", holders: 0, price_usd: price, error: null }, "status = 'snapshot'");

    await fence();
    await db.prepare("DELETE FROM payouts WHERE drop_n = ?").bind(d.n).run();
    await jsonRows(db, `INSERT INTO payouts (drop_n, wallet, weight)
      SELECT ?2, json_extract(value, '$.w'), json_extract(value, '$.x') FROM json_each(?1)`,
      rows.map((r) => ({ w: r.wallet, x: r.weight })), d.n);
    return setDrop(db, d.n, { status: "sweep", price_usd: price, error: null, weight_total: rows.reduce((a, r) => a + r.weight, 0) }, "status = 'snapshot'");
  },

  // The tax sits withheld in pool vaults and the mint. Move it to the treasury (the payout wallet's token account) before
  // it is sold. Sweeps that are still landing hold the round here; one that can't be done never wedges the payouts.
  async sweep(env, cfg, d, now, fence) {
    const db = env.DB;
    if (!cfg.dryRun) {
      try {
        await fees.enqueue(db, [{ address: cfg.mint }], now); // the mint's own withheld tokens: anyone may harvest into it
        await fees.runFees(env, cfg, fees.realDeps(env), { kinds: ["sweep", "mint"], force: true });
      } catch (e) { console.error("sweep", e.message); }
      const open = await db.prepare("SELECT COUNT(*) AS c FROM fee_batches WHERE status = 'sent' AND kind IN ('sweep', 'mint')").first();
      if (open.c) return d;
    }
    return setDrop(db, d.n, { status: "swap", error: null }, "status = 'sweep'");
  },

  // Two legs, each its own transaction with its signature saved before it is sent: the treasury's CULT -> USDC, then
  // spare SOL -> USDC. The round's pot is the wallet's USDC once both are settled.
  async swap(env, cfg, d, now, fence) {
    const db = env.DB;
    const cult = await cultLeg(env, cfg, d, fence);
    if (!cult.done) return cult.d;
    d = cult.d;
    if (d.swap_sig) {
      if (d.swap_sig === "dry-run" || d.swap_sig === "none") return setDrop(db, d.n, { status: "allocate" }, "status = 'swap'");
      const st = (await settleSent(env, [{ sig: d.swap_sig, lvbh: d.swap_lvbh }]))[d.swap_sig];
      if (st === "confirmed") return setDrop(db, d.n, { status: "allocate", error: null }, "status = 'swap'");
      if (st === "failed" || st === "lost") return setDrop(db, d.n, { swap_sig: null, swap_lvbh: null, error: "Swap didn't land, retrying." }, "status = 'swap' AND swap_sig = ?", d.swap_sig);
      return d; // still landing
    }
    const payees = (await db.prepare("SELECT COUNT(*) AS c FROM payouts WHERE drop_n = ?").bind(d.n).first()).c;
    const txFees = Math.ceil(payees / cfg.batchSize) * chain.TX_FEE;
    if (cfg.dryRun) return setDrop(db, d.n, { swap_sig: "dry-run", swap_lamports: 0, status: "allocate" }, "status = 'swap'");
    // SWAP=off: no Jupiter (devnet). The pot is whatever payout token the wallet already holds.
    if (env.SWAP === "off") return setDrop(db, d.n, { swap_sig: "none", swap_lamports: 0, status: "allocate" }, "status = 'swap'");

    // New holders pay for their own USDC accounts out of their payout (see allocate), so the swap keeps back only
    // the standing reserve and the transaction fees. The reserve is also the float that opens those accounts.
    const kp = chain.payoutKeypair(env, cfg);
    const bal = Number(await chain.solBalance(env, cfg.payout));
    const spare = bal - cfg.solReserve - txFees;
    if (spare < MIN_SWAP_LAMPORTS) return setDrop(db, d.n, { swap_sig: "none", swap_lamports: 0, status: "allocate" }, "status = 'swap'");
    const s = await jup.treasurySwap(env, cfg, kp, { inputMint: SOL_MINT, inputProgram: TOKEN_PROGRAM_ID.toBase58(), outputMint: chain.payMint(env).toBase58(), outputProgram: TOKEN_PROGRAM_ID.toBase58(), amount: String(spare) });
    await fence();
    // Claim the swap (only while no signature is saved) before it is sent: a second run that built its own swap sees
    // it lost the claim and sends nothing.
    d = await setDrop(db, d.n, { swap_sig: s.sig, swap_lvbh: s.lvbh || (await chain.blockHeight(env)) + 150, swap_lamports: spare }, "status = 'swap' AND swap_sig IS NULL");
    if (d.swap_sig !== s.sig) return d;
    await chain.sendTx(env, s.tx);
    for (let i = 0; i < 8; i++) { // usually lands in a few seconds
      await new Promise((r) => setTimeout(r, 2500));
      if ((await chain.sigStatuses(env, [s.sig]))[s.sig] === "confirmed") return setDrop(db, d.n, { status: "allocate", error: null }, "status = 'swap'");
    }
    return d;
  },

  async allocate(env, cfg, d, now, fence) {
    const db = env.DB;
    // The SOL price turns the account rent into USDC. Unknown price: refuse, don't guess.
    const { sol } = await cachedPrices(env, cfg);
    if (!(sol > 0)) throw new Error("No SOL price yet. Retrying next tick.");
    let pot;
    if (cfg.dryRun) pot = Math.floor(d.fee_usd * 1e6);
    else pot = Number(await chain.usdcBalance(env, cfg.payout)); // includes dust rolled over from earlier drops
    const rows = (await db.prepare("SELECT wallet, weight FROM payouts WHERE drop_n = ?").bind(d.n).all()).results;
    // Who has no USDC account is read now, seconds before paying, so a holder can't close theirs after being counted.
    const missing = await chain.missingUsdcAccounts(env, rows.map((r) => r.wallet));
    const { paid, total } = allocate(rows.map((r) => ({ ...r, needs_ata: missing.has(r.wallet) ? 1 : 0 })), pot, cfg.minPayoutMicro, cfg.batchSize, rentMicro(sol));
    await fence();
    await db.prepare("UPDATE payouts SET micro = 0, batch = NULL, needs_ata = 0 WHERE drop_n = ?").bind(d.n).run();
    await jsonRows(db, `UPDATE payouts SET micro = json_extract(j.value, '$.m'), batch = json_extract(j.value, '$.b'), needs_ata = json_extract(j.value, '$.a')
      FROM json_each(?1) AS j WHERE payouts.drop_n = ?2 AND payouts.wallet = json_extract(j.value, '$.w')`,
      paid.map((p) => ({ w: p.wallet, m: p.micro, b: p.batch, a: p.needs_ata })), d.n);
    const nBatches = paid.length ? paid[paid.length - 1].batch + 1 : 0;
    await db.prepare("DELETE FROM batches WHERE drop_n = ?").bind(d.n).run();
    if (nBatches) await db.prepare("INSERT INTO batches (drop_n, i, status) SELECT ?, value, 'pending' FROM json_each(?)").bind(d.n, JSON.stringify([...Array(nBatches).keys()])).run();
    return setDrop(db, d.n, { status: nBatches ? "paying" : "done", usdc_micro: total, holders: paid.length }, "status = 'allocate'");
  },

  async paying(env, cfg, d, now, fence) {
    const db = env.DB;
    const open = (await db.prepare("SELECT * FROM batches WHERE drop_n = ? AND status IN ('pending', 'sent') ORDER BY i").bind(d.n).all()).results;

    // Check the ones already sent. Every change names the status and signature it expects, so a run that fell
    // behind can't overwrite a newer one.
    const sent = open.filter((b) => b.status === "sent");
    if (sent.length && !cfg.dryRun) {
      const st = await settleSent(env, sent);
      for (const b of sent) {
        const s = st[b.sig];
        if (s === "wait") continue;
        if (s === "confirmed") { await db.prepare("UPDATE batches SET status = 'confirmed' WHERE drop_n = ? AND i = ? AND status = 'sent' AND sig = ?").bind(d.n, b.i, b.sig).run(); continue; }
        // failed or lost: try again, and after SPLIT_AT failures pay each holder in a transaction of their own, so one
        // closed or frozen USDC account can only block its own holder.
        if (b.tries + 1 === SPLIT_AT && (await splitBatch(db, d.n, b))) continue;
        await db.prepare("UPDATE batches SET status = ?, sig = NULL, tries = tries + 1 WHERE drop_n = ? AND i = ? AND status = 'sent' AND sig = ?")
          .bind(b.tries + 1 >= MAX_TRIES ? "failed" : "pending", d.n, b.i, b.sig).run();
      }
    }

    // Send pending ones. The batch is claimed (pending -> sent, with its signature) BEFORE it is sent, by a
    // conditional UPDATE: only the run that changed the row sends it, so a crash or a second run can't send it twice.
    const pending = (await db.prepare("SELECT * FROM batches WHERE drop_n = ? AND status = 'pending' ORDER BY i LIMIT ?").bind(d.n, BATCHES_PER_TICK).all()).results;
    if (pending.length) {
      const kp = cfg.dryRun ? null : chain.payoutKeypair(env, cfg);
      const bh = cfg.dryRun ? null : await chain.latestBlockhash(env);
      for (const b of pending) {
        await fence();
        if (cfg.dryRun) { await db.prepare("UPDATE batches SET status = 'confirmed', sig = ? WHERE drop_n = ? AND i = ? AND status = 'pending'").bind(`dry-run-${d.n}-${b.i}`, d.n, b.i).run(); continue; }
        const items = (await db.prepare("SELECT wallet, micro, needs_ata FROM payouts WHERE drop_n = ? AND batch = ?").bind(d.n, b.i).all()).results;
        const tx = chain.buildPayoutTx(kp, bh.blockhash, items, chain.payMint(env));
        const sig = chain.sigOf(tx);
        const claim = await db.prepare("UPDATE batches SET status = 'sent', sig = ?, lvbh = ? WHERE drop_n = ? AND i = ? AND status = 'pending'").bind(sig, bh.lastValidBlockHeight, d.n, b.i).run();
        if (!claim.meta.changes) continue; // another run has it
        try { await chain.sendTx(env, tx); } catch (e) { console.error("send batch", d.n, b.i, e.message); } // checked next tick
      }
    }

    const left = await db.prepare("SELECT COUNT(*) AS c FROM batches WHERE drop_n = ? AND status IN ('pending', 'sent')").bind(d.n).first();
    if (left.c) return d;
    // Failed batches' USDC stays in the wallet and goes out with the next airdrop.
    // A practice round (swap_sig 'dry-run') keeps its own totals, listed apart by live.js. In any other round a batch the practice
    // run marked 'confirmed' (a made-up dry-run signature, when DRY_RUN flipped mid-round) was never paid: it isn't counted.
    const paid = await db.prepare(`SELECT COALESCE(SUM(p.micro), 0) AS m, COUNT(*) AS c FROM payouts p JOIN batches b ON b.drop_n = p.drop_n AND b.i = p.batch
      WHERE p.drop_n = ?1 AND b.status = 'confirmed' AND (?2 = 1 OR b.sig NOT LIKE 'dry-run-%')`).bind(d.n, d.swap_sig === "dry-run" ? 1 : 0).first();
    return setDrop(db, d.n, { status: "done", usdc_micro: paid.m, holders: paid.c, error: null }, "status = 'paying'");
  },
};

// One batch that failed SPLIT_AT times becomes one batch per holder (new batch numbers after the last), each with
// its payout row moved over. One D1 batch (a transaction), and every statement only applies while the old batch is
// still the 'sent' one with this signature. Returns false for a batch of one, which has nothing to split.
async function splitBatch(db, n, b) {
  const payees = (await db.prepare("SELECT wallet FROM payouts WHERE drop_n = ? AND batch = ? ORDER BY micro DESC").bind(n, b.i).all()).results;
  if (payees.length < 2) return false;
  const next = (await db.prepare("SELECT MAX(i) AS i FROM batches WHERE drop_n = ?").bind(n).first()).i + 1;
  const stmts = payees.flatMap((p, k) => [
    db.prepare("INSERT INTO batches (drop_n, i, status, tries) SELECT ?1, ?2, 'pending', ?3 WHERE EXISTS (SELECT 1 FROM batches WHERE drop_n = ?1 AND i = ?4 AND status = 'sent' AND sig = ?5)")
      .bind(n, next + k, SPLIT_AT, b.i, b.sig),
    db.prepare("UPDATE payouts SET batch = ?1 WHERE drop_n = ?2 AND wallet = ?3 AND batch = ?4 AND EXISTS (SELECT 1 FROM batches WHERE drop_n = ?2 AND i = ?1)")
      .bind(next + k, n, p.wallet, b.i),
  ]);
  stmts.push(db.prepare("UPDATE batches SET status = 'split', sig = NULL, tries = tries + 1 WHERE drop_n = ? AND i = ? AND status = 'sent' AND sig = ?").bind(n, b.i, b.sig));
  await db.batch(stmts);
  return true;
}
