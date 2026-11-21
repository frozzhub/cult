// $CULT on Meteora (Dynamic Bonding Curve, then a DAMM v2 pool after graduation).
//
// Every trade pays a 10% fee in SOL. Meteora keeps 20% of it; the treasury (PAYOUT_WALLET) earns the rest.
//   buy  -> we pay the buyer's whole 10% back within seconds, so joining is free
//   sell -> the fee stays: it's claimed into the treasury and goes out in the 10-minute USDC airdrop
//
// The refund watcher runs inside every cron invocation for ~55s, checking the pools every few seconds, so
// refunds land within seconds without any webhook. The Helius webhook (raw transactions) feeds the same
// path when it's configured, and the mint poller catches anything either missed.
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, TransactionInstruction, Connection } from "@solana/web3.js";
import { ADDR, SOL_MINT } from "./config.js";
import * as chain from "./chain.js";

// Pool authorities hold the vaults: never a buyer.
export const AUTHORITIES = new Set(["FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM", "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC"]);
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const REFUND_TX_FEE = 10_000;

const kvGet = async (db, k) => { const r = await db.prepare("SELECT v, at FROM kv WHERE k = ?").bind(k).first(); return r ? { v: JSON.parse(r.v), at: r.at } : null; };
const kvSet = (db, k, v, at = Date.now()) => db.prepare("INSERT INTO kv (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at").bind(k, JSON.stringify(v), at).run();

// Every account in a transaction, in index order (static keys, then lookup-table writable, then readonly).
// Works for jsonParsed ({pubkey}), json (strings) and Helius raw webhooks.
export function txKeys(tx) {
  const m = tx?.transaction?.message || {};
  const stat = (m.accountKeys || m.staticAccountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey?.toString?.() || String(k.pubkey)));
  const la = tx?.meta?.loadedAddresses;
  return la && !(m.accountKeys || []).some((k) => typeof k === "object" && k.source) ? [...stat, ...(la.writable || []), ...(la.readonly || [])].map(String) : stat;
}

// A transaction -> the swaps it made through any of our pools: [{ side, gross, fee, tokens, buyers|seller, priceSol }].
//   buy:  the quote vault gains `gross` SOL (fee included, it stays in the vault until claimed): fee = gross x 10%
//   sell: the quote vault pays out the seller's net SOL (90% of gross): fee = net / 9
// Anything else (claims, graduation moving liquidity, pool creation) changes both sides the same way: not a trade.
export function parseSwaps(sig, tx, cfg) {
  if (!tx || tx.meta?.err || !cfg.vaults?.length) return [];
  const keys = txKeys(tx);
  const bal = (list) => { const m = new Map(); for (const b of list || []) m.set(b.accountIndex, b); return m; };
  const pre = bal(tx.meta.preTokenBalances), post = bal(tx.meta.postTokenBalances);
  const amt = (m, i) => BigInt(m.get(i)?.uiTokenAmount?.amount || "0");
  const delta = (addr) => { const i = keys.indexOf(addr); return i < 0 ? null : amt(post, i) - amt(pre, i); };
  const decimals = [...post.values()].find((b) => b.mint === cfg.mint)?.uiTokenAmount?.decimals ?? 6;
  const at = Number(tx.blockTime || 0) * 1000 || Date.now();

  // $CULT balance change per owner, excluding vault authorities and our own wallets.
  const byOwner = new Map();
  const skip = new Set([cfg.payout]);
  for (const [side, m, sign] of [["pre", pre, -1n], ["post", post, 1n]]) {
    for (const b of m.values()) {
      if (b.mint !== cfg.mint || !b.owner || AUTHORITIES.has(b.owner)) continue;
      byOwner.set(b.owner, (byOwner.get(b.owner) || 0n) + sign * BigInt(b.uiTokenAmount?.amount || "0"));
    }
  }
  const out = [];
  const bps = BigInt(cfg.feeBps);
  for (const { base, quote } of cfg.vaults) {
    const db = delta(base), dq = delta(quote);
    if (db == null || dq == null || db === 0n || dq === 0n) continue;
    if (db < 0n && dq > 0n) {
      const fee = (dq * bps) / 10_000n;
      const gainers = [...byOwner].filter(([o, d]) => d > 0n && !skip.has(o) && ADDR.test(o));
      const total = gainers.reduce((a, [, d]) => a + d, 0n);
      // Usually one buyer. A bundle buying for several wallets splits the refund by tokens received.
      const buyers = total ? gainers.map(([wallet, d]) => ({ wallet, lamports: Number((fee * d) / total) })).filter((b) => b.lamports > 0) : [];
      out.push({ sig, side: "buy", gross: Number(dq), fee: Number(fee), tokens: Number(-db) / 10 ** decimals, buyers, wallet: buyers[0]?.wallet || keys[0], priceSol: Number(dq - fee) / 1e9 / (Number(-db) / 10 ** decimals), at });
    } else if (db > 0n && dq < 0n) {
      const net = -dq;
      const fee = (net * bps) / (10_000n - bps);
      let seller = null, sold = 0n;
      for (const [o, d] of byOwner) if (d < sold && o !== cfg.payout) { sold = d; seller = o; }
      out.push({ sig, side: "sell", gross: Number(net + fee), fee: Number(fee), net: Number(net), tokens: Number(db) / 10 ** decimals, wallet: seller || keys[0], priceSol: Number(net + fee) / 1e9 / (Number(db) / 10 ** decimals), at });
    }
  }
  return out;
}

/* ---------------- storing what we saw ---------------- */

// Records trades, sells (for the Wall and the round's pot) and buy refunds. Safe to call twice for the same tx.
export async function recordSwaps(env, cfg, swaps, solUsd) {
  const db = env.DB;
  let refunds = 0;
  for (const s of swaps) {
    await db.prepare("INSERT OR IGNORE INTO trades (sig, at, side, wallet, sol_lamports, price_sol, sol_usd) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(s.sig, s.at, s.side, s.wallet, s.gross, s.priceSol, solUsd).run();
    if (s.side === "sell" && s.wallet !== cfg.payout) {
      const r = await db.prepare("INSERT OR IGNORE INTO sells (sig, wallet, tokens, sol_out, fee_lamports, sol_usd, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(s.sig, s.wallet, s.tokens, s.net, s.fee, solUsd, s.at).run();
      if (r.meta.changes) await db.prepare(`INSERT INTO sellers (wallet, sells, paid_usdc, last_at) VALUES (?, 1, ?, ?)
        ON CONFLICT(wallet) DO UPDATE SET sells = sells + 1, paid_usdc = paid_usdc + excluded.paid_usdc, last_at = MAX(last_at, excluded.last_at)`)
        .bind(s.wallet, (s.fee / 1e9) * solUsd, s.at).run();
    }
    if (s.side === "buy" && cfg.refunds) {
      for (const b of s.buyers) {
        const r = await db.prepare("INSERT OR IGNORE INTO refunds (sig, wallet, lamports, at) VALUES (?, ?, ?, ?)").bind(s.sig, b.wallet, b.lamports, s.at).run();
        refunds += r.meta.changes;
      }
    }
  }
  return refunds;
}

/* ---------------- paying refunds ---------------- */

export function buildRefundTx(kp, blockhash, { wallet, lamports, sig }) {
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(wallet), lamports }),
    new TransactionInstruction({ programId: MEMO, keys: [], data: new TextEncoder().encode(`CULT: your 10% buy fee back (${sig.slice(0, 8)})`) }),
  ];
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  tx.sign([kp]);
  return tx;
}

const sumPending = async (db) => Number((await db.prepare("SELECT COALESCE(SUM(lamports), 0) AS s FROM refunds WHERE status IN ('pending', 'sent')").first()).s);
export const owedRefunds = sumPending;

// Checks sent refunds, re-sends lost ones, sends pending ones. Claims the pool fees first if the
// treasury is short. Returns { sent, confirmed, waiting }.
export async function payRefunds(env, cfg, { claim = claimFees } = {}) {
  const db = env.DB;
  const open = (await db.prepare("SELECT * FROM refunds WHERE status IN ('pending', 'sent') ORDER BY at LIMIT 60").all()).results;
  if (!open.length) return { sent: 0, confirmed: 0, waiting: 0 };
  let confirmed = 0;
  const sent = open.filter((r) => r.status === "sent");
  if (sent.length && !cfg.dryRun) {
    const st = await chain.sigStatuses(env, sent.map((r) => r.tx));
    const height = sent.some((r) => !st[r.tx]) ? await chain.blockHeight(env) : 0;
    for (const r of sent) {
      if (st[r.tx] === "confirmed") { r.status = "confirmed"; confirmed++; await db.prepare("UPDATE refunds SET status = 'confirmed', paid_at = ? WHERE sig = ? AND wallet = ?").bind(Date.now(), r.sig, r.wallet).run(); }
      else if (st[r.tx] === "failed" || height > r.lvbh) {
        r.status = r.tries + 1 >= 6 ? "failed" : "pending";
        await db.prepare("UPDATE refunds SET status = ?, tx = NULL, tries = tries + 1 WHERE sig = ? AND wallet = ?").bind(r.status, r.sig, r.wallet).run();
      }
    }
  }
  const pending = open.filter((r) => r.status === "pending");
  if (!pending.length) return { sent: 0, confirmed, waiting: 0 };
  if (cfg.dryRun) {
    for (const r of pending) await db.prepare("UPDATE refunds SET status = 'confirmed', tx = ?, paid_at = ? WHERE sig = ? AND wallet = ?").bind("dry-run-" + r.sig.slice(0, 16), Date.now(), r.sig, r.wallet).run();
    return { sent: pending.length, confirmed: confirmed + pending.length, waiting: 0 };
  }
  const kp = chain.payoutKeypair(env, cfg);
  const need = pending.reduce((a, r) => a + r.lamports + REFUND_TX_FEE, 0);
  let bal = Number(await chain.solBalance(env, cfg.payout));
  if (bal - cfg.solReserve < need) { // short: pull the fees sitting in the pool, then look again
    await claim(env, cfg).catch((e) => console.error("claim for refunds", e.message));
    bal = Number(await chain.solBalance(env, cfg.payout));
  }
  const bh = await chain.latestBlockhash(env);
  let n = 0, waiting = 0;
  for (const r of pending) {
    if (bal - cfg.solReserve < r.lamports + REFUND_TX_FEE) { waiting++; continue; } // paid as soon as fees come in
    const tx = buildRefundTx(kp, bh.blockhash, r);
    const sig = chain.sigOf(tx);
    await db.prepare("UPDATE refunds SET status = 'sent', tx = ?, lvbh = ? WHERE sig = ? AND wallet = ?").bind(sig, bh.lastValidBlockHeight, r.sig, r.wallet).run();
    try { await chain.sendTx(env, tx); } catch (e) { console.error("send refund", r.sig, e.message); } // checked next pass
    bal -= r.lamports + REFUND_TX_FEE; n++;
  }
  return { sent: n, confirmed, waiting };
}

/* ---------------- the watcher ---------------- */

// Every pool we watch: the curve from wrangler.jsonc, plus the DAMM v2 pool once the coin graduates.
export async function pools(env, cfg) {
  const out = [...cfg.vaults];
  const g = (await kvGet(env.DB, "graduated"))?.v;
  if (g?.vaults) for (const v of g.vaults) if (!out.some((o) => o.quote === v.quote)) out.push(v);
  return out;
}
export async function liveCfg(env, cfg) {
  const vaults = await pools(env, cfg);
  const g = (await kvGet(env.DB, "graduated"))?.v;
  return { ...cfg, vaults, dammPool: g?.pool || cfg.dammPool };
}

async function poolSignatures(env, address, until) {
  const r = await chain.rpc(env, "getSignaturesForAddress", [address, { limit: 100, ...(until ? { until } : {}) }]);
  return (r || []).filter((s) => !s.err).reverse(); // oldest first
}

// One pass: new swaps through each pool -> recorded -> refunds paid.
export async function watchOnce(env, cfg, solUsd) {
  const c = await liveCfg(env, cfg);
  const addrs = [cfg.pool, c.dammPool].filter(Boolean);
  let seen = 0;
  for (const a of addrs) {
    const cur = (await kvGet(env.DB, "watch:" + a))?.v;
    const sigs = await poolSignatures(env, a, cur);
    if (!cur && sigs.length >= 100) { await kvSet(env.DB, "watch:" + a, sigs[sigs.length - 1].signature); continue; } // first run: start from now, the poller backfills
    for (const s of sigs) {
      const tx = await chain.rpc(env, "getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      await recordSwaps(env, c, parseSwaps(s.signature, tx, c), solUsd);
      seen++;
    }
    if (sigs.length) await kvSet(env.DB, "watch:" + a, sigs[sigs.length - 1].signature);
  }
  const paid = cfg.refunds ? await payRefunds(env, c) : { sent: 0 };
  return { seen, ...paid };
}

// Runs for `ms` (cron gives us a minute), a pass every `every` ms. Only one watcher at a time.
export async function watch(env, cfg, { ms = 55_000, every = 3_000, solUsd = 0 } = {}) {
  if (!cfg.vaults.length || !cfg.pool) return { skipped: "no Meteora pool configured" };
  const db = env.DB, token = crypto.randomUUID(), start = Date.now();
  const got = await db.prepare("INSERT INTO kv (k, v, at) VALUES ('watch_lock', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at WHERE kv.at < ?")
    .bind(JSON.stringify(token), start + ms + 10_000, start).run();
  if (!got.meta.changes) return { skipped: "another watcher is running" };
  const totals = { passes: 0, seen: 0, sent: 0 };
  try {
    while (Date.now() - start < ms) {
      const t = Date.now();
      try { const r = await watchOnce(env, cfg, solUsd); totals.seen += r.seen; totals.sent += r.sent; }
      catch (e) { console.error("watch", e.message); }
      totals.passes++;
      const wait = every - (Date.now() - t);
      if (Date.now() - start + wait >= ms) break;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  } finally { await db.prepare("DELETE FROM kv WHERE k = 'watch_lock' AND v = ?").bind(JSON.stringify(token)).run(); }
  return totals;
}

/* ---------------- fees and graduation (Meteora SDKs, loaded only when needed) ---------------- */

const sdk = async () => {
  const [dbc, amm] = await Promise.all([import("@meteora-ag/dynamic-bonding-curve-sdk"), import("@meteora-ag/cp-amm-sdk")]);
  return { dbc, amm };
};
const connection = (env) => new Connection(chain.rpcUrl(env), "confirmed");

// Claims the treasury's fees into the payout wallet (as plain SOL): the curve's partner fees, and after
// graduation the locked DAMM v2 position's fees. Returns the signatures sent.
export async function claimFees(env, cfg) {
  if (cfg.dryRun) return [];
  const kp = chain.payoutKeypair(env, cfg);
  const { dbc, amm } = await sdk();
  const conn = connection(env);
  const sigs = [];
  const send = async (tx) => {
    tx.feePayer = kp.publicKey;
    const bh = await chain.latestBlockhash(env);
    tx.recentBlockhash = bh.blockhash;
    tx.sign(kp);
    sigs.push(await chain.rpc(env, "sendTransaction", [Buffer.from(tx.serialize()).toString("base64"), { encoding: "base64", maxRetries: 3 }]));
  };
  const client = new dbc.DynamicBondingCurveClient(conn, "confirmed");
  const pool = new PublicKey(cfg.pool);
  const got = await client.state.getPool(pool);
  const st = got?.poolState || got;
  const BN = st.partnerQuoteFee.constructor;
  if (st.partnerQuoteFee && st.partnerQuoteFee.gtn(0)) {
    await send(await client.partner.claimPartnerTradingFee({ feeClaimer: kp.publicKey, payer: kp.publicKey, pool, maxBaseAmount: new BN(0), maxQuoteAmount: st.partnerQuoteFee }));
  }
  const c = await liveCfg(env, cfg);
  if (c.dammPool) {
    const cp = new amm.CpAmm(conn);
    const dpool = new PublicKey(c.dammPool);
    const ps = await cp.fetchPoolState(dpool);
    for (const p of await cp.getUserPositionByPool(dpool, kp.publicKey)) {
      await send(await cp.claimPositionFee2({
        receiver: kp.publicKey, feePayer: kp.publicKey, owner: kp.publicKey, pool: dpool, position: p.position, positionNftAccount: p.positionNftAccount,
        tokenAMint: ps.tokenAMint, tokenBMint: ps.tokenBMint, tokenAVault: ps.tokenAVault, tokenBVault: ps.tokenBVault,
        tokenAProgram: amm.getTokenProgram(ps.tokenAFlag), tokenBProgram: amm.getTokenProgram(ps.tokenBFlag),
      }));
    }
  }
  if (sigs.length) { // wait for them so the balance reflects the claim
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const s = await chain.sigStatuses(env, sigs);
      if (sigs.every((x) => s[x])) break;
    }
  }
  return sigs;
}

// Once the curve fills, Meteora moves the coin to a DAMM v2 pool. Find it and start watching it too.
export async function checkGraduation(env, cfg) {
  if ((await kvGet(env.DB, "graduated"))?.v?.pool) return null;
  const { dbc, amm } = await sdk();
  const conn = connection(env);
  const got = await new dbc.DynamicBondingCurveClient(conn, "confirmed").state.getPool(new PublicKey(cfg.pool));
  const st = got?.poolState || got;
  if (!st?.isMigrated) return null;
  const cp = new amm.CpAmm(conn);
  const found = (await cp.fetchPoolStatesByTokenAMint(new PublicKey(cfg.mint))).find((p) => p.account.tokenBMint.toBase58() === SOL_MINT);
  if (!found) return null;
  const g = { pool: found.publicKey.toBase58(), vaults: [{ base: found.account.tokenAVault.toBase58(), quote: found.account.tokenBVault.toBase58() }], at: Date.now() };
  await kvSet(env.DB, "graduated", g);
  return g;
}
