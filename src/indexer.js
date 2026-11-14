// The airdrop engine.
//
// Helius webhook  -> records every sell into the pool (who, how much, the 15% fee in SOL).
// Cron every 5 min -> moves the current airdrop one step at a time:
//   snapshot  every holder, their streak boost and weight; who needs a USDC account opened
//   swap      the payout wallet's spare SOL -> USDC on Jupiter
//   allocate  split the wallet's USDC by weight into fixed batches
//   paying    sign + send each batch; check them on later ticks until all land
//   done
// Every step is saved in D1 before anything is sent, so a crash or an overlapping tick resumes where it
// stopped and never pays a batch twice: a batch is only re-sent once its old transaction has failed or
// its blockhash has expired (it can no longer land).
import { config, dropMs, streakMult, ADDR } from "./config.js";
import * as chain from "./chain.js";
import { readPool } from "./trade.js";

const DAY = 86_400_000;
const MIN_SWAP_LAMPORTS = 10_000_000; // don't bother swapping under 0.01 SOL
const BATCHES_PER_TICK = 40;
const MAX_TRIES = 5;

/* ---------------- pure helpers (unit tested) ---------------- */

// Helius "enhanced" transaction -> a sell record, or null if it isn't a sell into our pool.
export function parseSell(tx, cfg) {
  if (!tx || tx.transactionError) return null;
  const into = (tx.tokenTransfers || []).filter((t) => t.mint === cfg.mint && t.toUserAccount === cfg.pool && t.fromUserAccount);
  if (!into.length) return null;
  const wallet = into[0].fromUserAccount;
  if (wallet === cfg.pool || wallet === cfg.payout || !ADDR.test(wallet)) return null;
  const tokens = into.filter((t) => t.fromUserAccount === wallet).reduce((a, t) => a + Number(t.tokenAmount || 0), 0);
  const change = (acct) => (tx.accountData || []).filter((a) => a.account === acct).reduce((s, a) => s + Number(a.nativeBalanceChange || 0), 0);
  const fee = Math.max(0, change(cfg.payout));
  const solOut = Math.max(0, change(wallet) + (tx.feePayer === wallet ? Number(tx.fee || 0) : 0));
  return { sig: tx.signature, wallet, tokens, solOut, fee, at: Number(tx.timestamp || 0) * 1000 || Date.now() };
}

// Split `pot` (micro-USDC) by weight. Amounts under `min` are dropped and roll into the next airdrop.
export function allocate(rows, pot, min, batchSize) {
  const total = rows.reduce((a, r) => a + r.weight, 0);
  if (!total || pot <= 0) return { paid: [], total: 0 };
  const paid = [];
  for (const r of rows) {
    const micro = Math.floor((pot * r.weight) / total);
    if (micro >= min) paid.push({ wallet: r.wallet, micro, needs_ata: r.needs_ata });
  }
  paid.sort((a, b) => b.micro - a.micro);
  paid.forEach((p, i) => (p.batch = Math.floor(i / batchSize)));
  return { paid, total: paid.reduce((a, p) => a + p.micro, 0) };
}

// Holder map -> eligible rows with streak-boosted weights.
export function weigh(cfg, { holders, since, lastSell, decimals, price, now }) {
  const skip = new Set([cfg.pool, cfg.payout, ...cfg.exclude]);
  const rows = [];
  for (const [wallet, raw] of holders) {
    if (skip.has(wallet)) continue;
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

// SOL price from Jupiter. $PAPER price from our own pool's reserves (Jupiter can't see a custom pool),
// falling back to Jupiter's price if the pool isn't configured.
export async function cachedPrices(env, cfg, now = Date.now()) {
  const c = await kvGet(env.DB, "price");
  if (c && now - c.at < 60_000) return c.v;
  try {
    const p = await chain.prices(env, cfg);
    if (cfg.poolProgram && p.sol) {
      const pool = await readPool(env, cfg).catch(() => null);
      if (pool && pool.tokenReserve > 0n) p.token = poolPrice(pool, p.sol);
      else if (c?.v?.token) p.token = c.v.token; // pool read failed: keep the last good price rather than 0
    }
    if (p.sol) { await kvSet(env.DB, "price", p, now); return p; }
  } catch (e) { console.error("price", e.message); }
  return c?.v || { sol: 0, token: 0 };
}

export const poolPrice = (pool, solUsd) => (Number(pool.solReserve) / 1e9 / (Number(pool.tokenReserve) / 10 ** pool.decimals)) * solUsd;

/* ---------------- RPC polling (backup for the webhook, and the only feed without Helius) ---------------- */

// The pool account holds its curve SOL plus rent. Rent rates change, so it's measured from the pool itself.
export const POOL_RENT = 1_234_440; // measured on devnet 2026-11-14; only a fallback

// A standard getTransaction (jsonParsed) -> a trade through the pool, or null.
//   buy:  pool gains SOL and loses $PAPER      sell: pool gains $PAPER and loses SOL
// Anything else (seeding the pool, plain transfers) isn't a trade. Price is SOL per $PAPER after the trade.
export function parseTrade(sig, tx, cfg, rent = POOL_RENT) {
  if (!tx || tx.meta?.err || !cfg.pool) return null;
  const keys = (tx.transaction?.message?.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
  const pi = keys.indexOf(cfg.pool);
  if (pi < 0) return null;
  const solDelta = tx.meta.postBalances[pi] - tx.meta.preBalances[pi];
  const sum = (list, owner) => (list || []).filter((b) => b.mint === cfg.mint && b.owner === owner).reduce((a, b) => a + Number(b.uiTokenAmount?.amount || 0), 0);
  const tokPost = sum(tx.meta.postTokenBalances, cfg.pool);
  const tokDelta = tokPost - sum(tx.meta.preTokenBalances, cfg.pool);
  const side = solDelta > 0 && tokDelta < 0 ? "buy" : solDelta < 0 && tokDelta > 0 ? "sell" : null;
  if (!side || !tokPost) return null;
  const decimals = (tx.meta.postTokenBalances || []).find((b) => b.mint === cfg.mint)?.uiTokenAmount?.decimals ?? 6;
  const owners = [...new Set((tx.meta.postTokenBalances || []).filter((b) => b.mint === cfg.mint && b.owner && b.owner !== cfg.pool).map((b) => b.owner))];
  return {
    sig, side,
    wallet: keys[0] && keys[0] !== cfg.pool ? keys[0] : owners[0] || "",
    sol: Math.abs(solDelta),
    priceSol: ((tx.meta.postBalances[pi] - rent) / 1e9) / (tokPost / 10 ** decimals),
    at: Number(tx.blockTime || 0) * 1000 || Date.now(),
  };
}

// A standard getTransaction (jsonParsed) -> a sell record, or null. A sell is any successful tx where
// the pool's $PAPER balance went up and one wallet's went down.
export function parseRpcSell(sig, tx, cfg) {
  if (!tx || tx.meta?.err) return null;
  const keys = (tx.transaction?.message?.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
  const bal = (list) => {
    const m = new Map();
    for (const b of list || []) if (b.mint === cfg.mint && b.owner) m.set(b.owner, (m.get(b.owner) || 0) + Number(b.uiTokenAmount?.amount || 0));
    return m;
  };
  const pre = bal(tx.meta.preTokenBalances), post = bal(tx.meta.postTokenBalances);
  const delta = (o) => (post.get(o) || 0) - (pre.get(o) || 0);
  if (!(delta(cfg.pool) > 0)) return null; // pool didn't receive $PAPER: a buy or something else
  const lam = (acct) => { const i = keys.indexOf(acct); return i < 0 ? 0 : tx.meta.postBalances[i] - tx.meta.preBalances[i]; };
  // A sell also takes SOL out of the pool. Seeding the pool at launch adds both, so it isn't one.
  if (keys.includes(cfg.pool) && !(lam(cfg.pool) < 0)) return null;
  const owners = new Set([...pre.keys(), ...post.keys()]);
  let wallet = null, sold = 0;
  for (const o of owners) if (o !== cfg.pool && delta(o) < sold) { sold = delta(o); wallet = o; }
  if (!wallet || wallet === cfg.payout || !ADDR.test(wallet)) return null;
  const decimals = (tx.meta.postTokenBalances || []).find((b) => b.mint === cfg.mint)?.uiTokenAmount?.decimals ?? 6;
  return {
    sig, wallet,
    tokens: -sold / 10 ** decimals,
    fee: Math.max(0, cfg.payout ? lam(cfg.payout) : 0),
    solOut: Math.max(0, lam(wallet) + (keys[0] === wallet ? Number(tx.meta.fee || 0) : 0)),
    at: Number(tx.blockTime || 0) * 1000 || Date.now(),
  };
}

// Stores a sell once (webhook and poller can both see the same one) and updates the Wall.
async function recordSell(env, s, solUsd) {
  const r = await env.DB.prepare("INSERT OR IGNORE INTO sells (sig, wallet, tokens, sol_out, fee_lamports, sol_usd, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(s.sig, s.wallet, s.tokens, s.solOut, s.fee, solUsd, s.at).run();
  if (!r.meta.changes) return false;
  await env.DB.prepare(`INSERT INTO sellers (wallet, sells, paid_usdc, last_at) VALUES (?, 1, ?, ?)
    ON CONFLICT(wallet) DO UPDATE SET sells = sells + 1, paid_usdc = paid_usdc + excluded.paid_usdc, last_at = MAX(last_at, excluded.last_at)`)
    .bind(s.wallet, (s.fee / 1e9) * solUsd, s.at).run();
  return true;
}

// Every $PAPER token account a transaction touched, with its balance after it: [{ address, owner, amount }].
export function parseTokenBalances(tx, cfg) {
  if (!tx || tx.meta?.err) return [];
  const keys = (tx.transaction?.message?.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
  return (tx.meta.postTokenBalances || [])
    .filter((b) => b.mint === cfg.mint && b.owner && keys[b.accountIndex])
    .map((b) => ({ address: keys[b.accountIndex], owner: b.owner, amount: String(b.uiTokenAmount?.amount || "0") }));
}

const MAX_TX_PER_TICK = 300; // keeps a tick well inside Workers' subrequest limit; the rest waits for the next one

// Walks the mint's transaction history (every $PAPER transfer references the mint): records sells and keeps
// the holder index (token_accounts) current. Oldest first; the cursor only moves past what was processed.
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
  const { sol } = await cachedPrices(env, cfg, now);
  const rent = await poolRent(env, cfg);
  let added = 0;
  for (const s of batch) {
    if (s.err) continue;
    if (env.POLL_GAP_MS) await new Promise((r) => setTimeout(r, Number(env.POLL_GAP_MS))); // gentle on free RPC tiers
    const tx = await chain.rpc(env, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
    const accts = parseTokenBalances(tx, cfg);
    if (accts.length) {
      await env.DB.prepare(`INSERT INTO token_accounts (address, owner, amount, slot)
        SELECT json_extract(value, '$.address'), json_extract(value, '$.owner'), json_extract(value, '$.amount'), ?2 FROM json_each(?1) WHERE true
        ON CONFLICT(address) DO UPDATE SET owner = excluded.owner, amount = excluded.amount, slot = excluded.slot WHERE excluded.slot >= token_accounts.slot`)
        .bind(JSON.stringify(accts), Number(tx.slot || 0)).run();
    }
    const trade = parseTrade(s.signature, tx, cfg, rent);
    if (trade) {
      await env.DB.prepare("INSERT OR IGNORE INTO trades (sig, at, side, wallet, sol_lamports, price_sol, sol_usd) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(trade.sig, trade.at, trade.side, trade.wallet, trade.sol, trade.priceSol, sol).run();
    }
    const sell = cfg.pool ? parseRpcSell(s.signature, tx, cfg) : null;
    if (sell && (await recordSell(env, sell, sol))) added++;
  }
  await kvSet(env.DB, "poll_cursor", batch[batch.length - 1].signature, now);
  await kvSet(env.DB, "poll_state", { behind: sigs.length - batch.length, ok: true }, now);
  return { polled: batch.length, added, behind: sigs.length - batch.length };
}

// The pool account's rent in lamports, read once from the pool (lamports minus its recorded reserve).
async function poolRent(env, cfg) {
  const c = await kvGet(env.DB, "pool_rent");
  if (c?.v) return c.v;
  if (!cfg.poolProgram) return POOL_RENT;
  try { const p = await readPool(env, cfg, { fresh: true }); if (p.rent > 0n) { await kvSet(env.DB, "pool_rent", Number(p.rent)); return Number(p.rent); } }
  catch (e) { console.error("pool rent", e.message); }
  return POOL_RENT;
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

async function setDrop(db, n, fields) {
  const keys = Object.keys(fields);
  await db.prepare(`UPDATE drops SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated = ? WHERE n = ?`).bind(...keys.map((k) => fields[k]), Date.now(), n).run();
  return db.prepare("SELECT * FROM drops WHERE n = ?").bind(n).first();
}

/* ---------------- webhook ---------------- */

export async function handleWebhook(req, env) {
  const cfg = config(env);
  const secret = env.HELIUS_WEBHOOK_SECRET;
  if (!secret || req.headers.get("authorization") !== secret) return new Response("unauthorized", { status: 401 });
  if (!cfg.mint || !cfg.pool || !cfg.payout) return Response.json({ ok: true, ignored: "not configured" });
  const body = await req.json().catch(() => null);
  const txs = Array.isArray(body) ? body : body ? [body] : [];
  const { sol } = await cachedPrices(env, cfg);
  let added = 0;
  for (const tx of txs) {
    const s = parseSell(tx, cfg);
    if (s && (await recordSell(env, s, sol))) added++; // false = Helius retried one we already have
  }
  return Response.json({ ok: true, added });
}

/* ---------------- cron tick ---------------- */

export async function tick(env, now = Date.now()) {
  const cfg = config(env);
  if (!cfg.mint || !cfg.pool || !ADDR.test(cfg.payout)) return { skipped: "MINT, POOL_ACCOUNT and PAYOUT_WALLET must be set" };
  const db = env.DB;
  const token = crypto.randomUUID();
  const got = await db.prepare("INSERT INTO kv (k, v, at) VALUES ('lock', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at WHERE kv.at < ?")
    .bind(JSON.stringify(token), now + 4 * 60_000, now).run();
  if (!got.meta.changes) return { skipped: "another tick is running" };
  let d;
  try {
    await cachedPrices(env, cfg, now);
    const polled = await pollMint(env, cfg, now).catch((e) => ({ pollError: e.message }));
    if (polled.pollError) console.error("poll", polled.pollError);
    d = await db.prepare("SELECT * FROM drops WHERE status NOT IN ('done', 'skipped') ORDER BY n LIMIT 1").first();
    if (!d) d = await openNext(db, cfg, now);
    if (!d) return { idle: true };
    for (let i = 0; i < 6; i++) {
      const before = d.status;
      d = await STEPS[before](env, cfg, d, now);
      if (d.status === before || d.status === "done" || d.status === "skipped") break;
    }
    return { drop: d.n, status: d.status };
  } catch (e) {
    console.error("tick", e.message);
    if (d) await setDrop(db, d.n, { error: String(e.message).slice(0, 500) });
    return { error: e.message };
  } finally {
    await db.prepare("DELETE FROM kv WHERE k = 'lock' AND v = ?").bind(JSON.stringify(token)).run();
  }
}

async function openNext(db, cfg, now) {
  const n = Math.floor(now / dropMs(cfg));
  const last = await db.prepare("SELECT MAX(n) AS n FROM drops").first();
  if (last?.n != null && last.n >= n) return null;
  const at = n * dropMs(cfg);
  await db.prepare("INSERT INTO drops (n, at, status, updated) VALUES (?, ?, 'snapshot', ?)").bind(n, at, now).run();
  await db.prepare("UPDATE sells SET drop_n = ? WHERE drop_n IS NULL AND at < ?").bind(n, at).run();
  const fee = await db.prepare("SELECT COALESCE(SUM(fee_lamports), 0) AS f FROM sells WHERE drop_n = ?").bind(n).first();
  return setDrop(db, n, { fee_lamports: fee.f });
}

const STEPS = {
  async snapshot(env, cfg, d, now) {
    const db = env.DB;
    const { token: price } = await cachedPrices(env, cfg, now);
    if (!price) throw new Error("No $PAPER price yet. Retrying next tick.");
    const m = await mint(env, cfg);
    // Using our own index only makes sense once the poller has caught up with the mint's history.
    if (env.HOLDERS === "index") {
      const ps = await kvGet(db, "poll_state");
      if (!ps?.v?.ok || ps.v.behind > 0 || ps.at < d.at) return setDrop(db, d.n, { error: "Waiting for the holder index to catch up." });
    }
    // Prefer a live snapshot (Helius DAS etc.); if the RPC can't do one, use our own index from the mint's history.
    const holders = env.HOLDERS === "index" ? await indexedHolders(db)
      : await chain.tokenHolders(env, cfg.mint, m.program).catch(async (e) => {
        console.error("snapshot fell back to the index:", e.message);
        return indexedHolders(db);
      });

    // Keep each holder's `since`; anyone who's gone drops out (and starts fresh if they come back).
    const prev = new Map((await db.prepare("SELECT wallet, since FROM holders").all()).results.map((r) => [r.wallet, r.since]));
    await jsonRows(db, `INSERT INTO holders (wallet, balance, since, seen)
      SELECT json_extract(value, '$.w'), json_extract(value, '$.b'), ?2, ?3 FROM json_each(?1) WHERE true
      ON CONFLICT(wallet) DO UPDATE SET balance = excluded.balance, seen = excluded.seen`,
      [...holders].map(([w, b]) => ({ w, b: b.toString() })), now, d.n);
    await db.prepare("DELETE FROM holders WHERE seen < ?").bind(d.n).run();

    const lastSell = new Map((await db.prepare("SELECT wallet, last_at FROM sellers").all()).results.map((r) => [r.wallet, r.last_at]));
    const rows = weigh(cfg, { holders, since: prev, lastSell, decimals: m.decimals, price, now });
    if (!rows.length) return setDrop(db, d.n, { status: "skipped", holders: 0, price_usd: price, error: null });

    const missing = await chain.missingUsdcAccounts(env, rows.map((r) => r.wallet));
    await db.prepare("DELETE FROM payouts WHERE drop_n = ?").bind(d.n).run();
    await jsonRows(db, `INSERT INTO payouts (drop_n, wallet, weight, needs_ata)
      SELECT ?2, json_extract(value, '$.w'), json_extract(value, '$.x'), json_extract(value, '$.a') FROM json_each(?1)`,
      rows.map((r) => ({ w: r.wallet, x: r.weight, a: missing.has(r.wallet) ? 1 : 0 })), d.n);
    return setDrop(db, d.n, {
      status: "swap", price_usd: price, error: null,
      weight_total: rows.reduce((a, r) => a + r.weight, 0),
      rent_lamports: missing.size * chain.ATA_RENT,
    });
  },

  async swap(env, cfg, d, now) {
    const db = env.DB;
    if (d.swap_sig) {
      if (d.swap_sig === "dry-run" || d.swap_sig === "none") return setDrop(db, d.n, { status: "allocate" });
      const st = (await chain.sigStatuses(env, [d.swap_sig]))[d.swap_sig];
      if (st === "confirmed") return setDrop(db, d.n, { status: "allocate", error: null });
      if (st === "failed" || (await chain.blockHeight(env)) > d.swap_lvbh) return setDrop(db, d.n, { swap_sig: null, swap_lvbh: null, error: "Swap didn't land, retrying." });
      return d; // still landing
    }
    const payees = (await db.prepare("SELECT COUNT(*) AS c FROM payouts WHERE drop_n = ?").bind(d.n).first()).c;
    const txFees = Math.ceil(payees / cfg.batchSize) * chain.TX_FEE;
    if (cfg.dryRun) return setDrop(db, d.n, { swap_sig: "dry-run", swap_lamports: d.fee_lamports, status: "allocate" });
    // SWAP=off: no Jupiter (devnet). The pot is whatever payout token the wallet already holds.
    if (env.SWAP === "off") return setDrop(db, d.n, { swap_sig: "none", swap_lamports: 0, status: "allocate" });

    const kp = chain.payoutKeypair(env, cfg);
    const bal = Number(await chain.solBalance(env, cfg.payout));
    const spare = bal - cfg.solReserve - d.rent_lamports - txFees;
    if (spare < MIN_SWAP_LAMPORTS) return setDrop(db, d.n, { swap_sig: "none", swap_lamports: 0, status: "allocate" });
    const s = await chain.buildSwap(env, cfg, kp, spare);
    d = await setDrop(db, d.n, { swap_sig: s.sig, swap_lvbh: s.lvbh || (await chain.blockHeight(env)) + 150, swap_lamports: spare });
    await chain.sendTx(env, s.tx);
    for (let i = 0; i < 8; i++) { // usually lands in a few seconds
      await new Promise((r) => setTimeout(r, 2500));
      if ((await chain.sigStatuses(env, [s.sig]))[s.sig] === "confirmed") return setDrop(db, d.n, { status: "allocate", error: null });
    }
    return d;
  },

  async allocate(env, cfg, d) {
    const db = env.DB;
    let pot;
    if (cfg.dryRun) {
      const { sol } = await cachedPrices(env, cfg);
      pot = Math.floor((d.fee_lamports / 1e9) * sol * 1e6);
    } else {
      pot = Number(await chain.usdcBalance(env, cfg.payout)); // includes dust rolled over from earlier drops
    }
    const rows = (await db.prepare("SELECT wallet, weight, needs_ata FROM payouts WHERE drop_n = ?").bind(d.n).all()).results;
    const { paid, total } = allocate(rows, pot, cfg.minPayoutMicro, cfg.batchSize);
    await db.prepare("UPDATE payouts SET micro = 0, batch = NULL WHERE drop_n = ?").bind(d.n).run();
    await jsonRows(db, `UPDATE payouts SET micro = json_extract(j.value, '$.m'), batch = json_extract(j.value, '$.b')
      FROM json_each(?1) AS j WHERE payouts.drop_n = ?2 AND payouts.wallet = json_extract(j.value, '$.w')`,
      paid.map((p) => ({ w: p.wallet, m: p.micro, b: p.batch })), d.n);
    const nBatches = paid.length ? paid[paid.length - 1].batch + 1 : 0;
    await db.prepare("DELETE FROM batches WHERE drop_n = ?").bind(d.n).run();
    if (nBatches) await db.prepare("INSERT INTO batches (drop_n, i, status) SELECT ?, value, 'pending' FROM json_each(?)").bind(d.n, JSON.stringify([...Array(nBatches).keys()])).run();
    return setDrop(db, d.n, { status: nBatches ? "paying" : "done", usdc_micro: total, holders: paid.length });
  },

  async paying(env, cfg, d) {
    const db = env.DB;
    const open = (await db.prepare("SELECT * FROM batches WHERE drop_n = ? AND status IN ('pending', 'sent') ORDER BY i").bind(d.n).all()).results;

    // Check the ones already sent.
    const sent = open.filter((b) => b.status === "sent");
    if (sent.length && !cfg.dryRun) {
      const st = await chain.sigStatuses(env, sent.map((b) => b.sig));
      const height = await chain.blockHeight(env);
      for (const b of sent) {
        const s = st[b.sig];
        if (s === "confirmed") { b.status = "confirmed"; await db.prepare("UPDATE batches SET status = 'confirmed' WHERE drop_n = ? AND i = ?").bind(d.n, b.i).run(); }
        else if (s === "failed" || height > b.lvbh) {
          b.status = b.tries + 1 >= MAX_TRIES ? "failed" : "pending";
          await db.prepare("UPDATE batches SET status = ?, sig = NULL, tries = tries + 1 WHERE drop_n = ? AND i = ?").bind(b.status, d.n, b.i).run();
        }
      }
    }

    // Send pending ones. Signature is saved before sending, so a crash can't cause a double send.
    const pending = open.filter((b) => b.status === "pending").slice(0, BATCHES_PER_TICK);
    if (pending.length) {
      const kp = cfg.dryRun ? null : chain.payoutKeypair(env, cfg);
      const bh = cfg.dryRun ? null : await chain.latestBlockhash(env);
      for (const b of pending) {
        if (cfg.dryRun) { await db.prepare("UPDATE batches SET status = 'confirmed', sig = ? WHERE drop_n = ? AND i = ?").bind(`dry-run-${d.n}-${b.i}`, d.n, b.i).run(); continue; }
        const items = (await db.prepare("SELECT wallet, micro, needs_ata FROM payouts WHERE drop_n = ? AND batch = ?").bind(d.n, b.i).all()).results;
        const tx = chain.buildPayoutTx(kp, bh.blockhash, items, chain.payMint(env));
        const sig = chain.sigOf(tx);
        await db.prepare("UPDATE batches SET status = 'sent', sig = ?, lvbh = ? WHERE drop_n = ? AND i = ?").bind(sig, bh.lastValidBlockHeight, d.n, b.i).run();
        try { await chain.sendTx(env, tx); } catch (e) { console.error("send batch", d.n, b.i, e.message); } // checked next tick
      }
    }

    const left = await db.prepare("SELECT COUNT(*) AS c FROM batches WHERE drop_n = ? AND status IN ('pending', 'sent')").bind(d.n).first();
    if (left.c) return d;
    // Failed batches' USDC stays in the wallet and goes out with the next airdrop.
    const paid = await db.prepare(`SELECT COALESCE(SUM(p.micro), 0) AS m, COUNT(*) AS c FROM payouts p JOIN batches b ON b.drop_n = p.drop_n AND b.i = p.batch
      WHERE p.drop_n = ? AND b.status = 'confirmed'`).bind(d.n).first();
    return setDrop(db, d.n, { status: "done", usdc_micro: paid.m, holders: paid.c, error: null });
  },
};
