// The refund and sweep engine: what happens to the tokens the mint withholds on every transfer.
//   refund  a person's wallet received tokens (a buy, or a send): the withheld part goes back into the SAME account,
//           fee-free, so a buy nets 0%. Signed by the withdraw-withheld authority (the payout key); the holder signs nothing.
//   sweep   a program-owned account (a pool vault) received tokens (a sell): the withheld part goes to the treasury,
//           the payout wallet's own token account. That is the sell tax. Withheld tokens sitting in the mint go too.
//
// Money rules, same as the payout batches:
//   - every account is CLAIMED by a conditional UPDATE (queued -> claimed) before anything is read or built, so two
//     runs (the webhook path and the cron, or two webhooks) can never act on one account at once;
//   - the account is read FRESH from the chain right before acting and classified from what was read (token22.js);
//     an account with nothing withheld is done, not an error, so the same withheld amount is never acted on twice;
//   - the batch row (signature, last valid height, the accounts) is saved in the same D1 transaction that moves the
//     accounts to `sent`, BEFORE the transaction is sent; a batch whose claim was lost is never inserted and nothing
//     is sent;
//   - an unknown outcome is settled only from the signature's status (chain.settleSent: searched with history, a margin
//     past the blockhash, then getTransaction), never by sending again and never from a balance. Only then do the
//     accounts go back to `queued`, to be read and classified again;
//   - dry runs read and plan but claim and send nothing;
//   - only refunds have a daily brake (REFUND_TX_PER_DAY): a sweep moves the sell tax, so nothing may stop it but the chain, and
//     a program-owned account or the mint is never given up on (sweeps are idempotent, cooled down, and one bad source can't
//     fail a sweep). A wallet account that keeps failing is given up after MAX_TRIES and revived an hour later (skipped_at).
// `deps` is the narrow seam tests fake: { getAccounts, blockhash, send, settle, now, uuid, priority? }.
import * as chain from "./chain.js";
import { parseTokenAccount, parseMint, classify, buildFeeTx, treasuryAta, onCurve } from "./token22.js";

const MAX_TRIES = 5;
const REVIVE_MS = 3_600_000;      // a refund account given up on is tried again by its next touch this long after it was given up
const STALE_CLAIM_MS = 120_000;  // a run that claimed and died before saving its batch: its accounts are released after this
const SWEEP_COOLDOWN_MS = 300_000; // vaults are touched by every trade; sweeping them more often than this only burns fees
const RUN_ROWS = 300;             // accounts one run takes
const RUN_TXS = 12;               // transactions one run sends

export const realDeps = (env) => ({
  getAccounts: (a) => chain.getAccounts(env, a),
  blockhash: () => chain.latestBlockhash(env),
  send: (tx) => chain.sendTx(env, tx),
  settle: (items) => chain.settleSent(env, items),
  now: () => Date.now(),
  uuid: () => crypto.randomUUID(),
  priority: (accounts, floor, cap) => chain.priorityFee(env, accounts, floor, cap),
});

/* ---------------- the queue ---------------- */

// Put accounts in the queue. entries: [{ address, owner? }]. A row that is already queued stays as it is; one being
// claimed or sent is marked `again` (the run that has it re-reads, and the settle puts it back); a finished one is
// queued again; one given up on is revived by the first touch an hour after it was GIVEN UP (not after it was last touched:
// a busy account is touched every few seconds, so that hour of silence never came).
export async function enqueue(db, entries, now = Date.now()) {
  const seen = new Map(entries.filter((e) => e?.address).map((e) => [e.address, e.owner || null]));
  const list = [...seen].map(([address, owner]) => ({ a: address, o: owner }));
  for (let i = 0; i < list.length; i += 500) {
    await db.prepare(`INSERT INTO fee_accounts (address, owner, state, next_at, updated)
      SELECT json_extract(value, '$.a'), json_extract(value, '$.o'), 'queued', 0, ?2 FROM json_each(?1) WHERE true
      ON CONFLICT(address) DO UPDATE SET
        owner = COALESCE(excluded.owner, fee_accounts.owner),
        again = CASE WHEN fee_accounts.state IN ('claimed', 'sent') THEN 1 ELSE fee_accounts.again END,
        tries = CASE WHEN fee_accounts.state = 'skip' AND COALESCE(fee_accounts.skipped_at, 0) < ?2 - ?3 THEN 0 ELSE fee_accounts.tries END,
        state = CASE WHEN fee_accounts.state = 'done' OR (fee_accounts.state = 'skip' AND COALESCE(fee_accounts.skipped_at, 0) < ?2 - ?3) THEN 'queued' ELSE fee_accounts.state END,
        updated = ?2`).bind(JSON.stringify(list.slice(i, i + 500)), now, REVIVE_MS).run();
  }
  return list.length;
}

/* ---------------- one run ---------------- */

const day = (now) => new Date(now).toISOString().slice(0, 10);
const kvGet = async (db, k) => { const r = await db.prepare("SELECT v FROM kv WHERE k = ?").bind(k).first(); return r ? JSON.parse(r.v) : null; };
// One atomic statement, not read-modify-write: webhook runs overlap, and a lost update would let the brake undercount.
const bumpRefunds = (db, d, at) => db.prepare(`INSERT INTO kv (k, v, at) VALUES ('refund_day', json_object('d', ?1, 'n', 1), ?2)
  ON CONFLICT(k) DO UPDATE SET at = ?2, v = CASE WHEN json_extract(kv.v, '$.d') = ?1 THEN json_object('d', ?1, 'n', json_extract(kv.v, '$.n') + 1) ELSE json_object('d', ?1, 'n', 1) END`).bind(d, at).run();

// The refund floor in raw units: withheld worth less than REFUND_MIN_USD at the cached price is swept, not refunded (a refund costs
// us a fee per account, and a raw floor is worth nothing at a price like 0.000004 a token). The price is the tick's own (kv "price");
// an old or missing one gives the fixed raw floor.
async function minRefundFor(db, cfg, decimals, now) {
  const row = await db.prepare("SELECT v, at FROM kv WHERE k = 'price'").first();
  const px = row && now - row.at < 3_600_000 ? Number(JSON.parse(row.v).token) : 0;
  const raw = Math.ceil((cfg.refundMinUsd / px) * 10 ** decimals); // rounded up: toward the house
  return px > 0 && Number.isFinite(raw) ? BigInt(raw) : cfg.refundMinTokens;
}

// opts: { only?: addresses to look at (the webhook path), kinds?: ["refund", "sweep", "mint"], force?: ignore the
// sweep cooldown (the round's sweep step) }. Returns a summary; never throws for a chain problem it can describe.
export async function runFees(env, cfg, deps = realDeps(env), opts = {}) {
  const db = env.DB, now = deps.now();
  const kinds = new Set(opts.kinds || ["refund", "sweep", "mint"]);
  if (!cfg.mint || !cfg.payout) return { skipped: "MINT and PAYOUT_WALLET must be set" };
  const live = { refund: kinds.has("refund") && !cfg.refundsDryRun, sweep: kinds.has("sweep") && !cfg.dryRun, mint: kinds.has("mint") && !cfg.dryRun };
  const out = { settled: 0, refunds: 0, sweeps: 0, mint: 0, txs: 0, none: 0, released: 0 };

  if (Object.values(live).some(Boolean)) Object.assign(out, await settleBatches(db, cfg, deps, now));
  await db.prepare("UPDATE fee_accounts SET state = 'queued', claim = NULL WHERE state = 'claimed' AND claimed_at < ?").bind(now - STALE_CLAIM_MS).run();

  // Which rows are due. `force` (the round's sweep step) ignores the cooldown. The webhook path names its accounts and only
  // takes wallet-owned ones (vaults are swept by the cron, in batches). A kind that isn't live leaves its rows alone.
  const dueAt = opts.force ? Number.MAX_SAFE_INTEGER : now;
  const dry = !live.refund && !live.sweep && !live.mint;
  const relevant = (r) => {
    if (dry) return true;
    if (r.address === cfg.mint) return live.mint;
    const wallet = r.owner ? onCurve(r.owner) : null; // null: not seen yet
    return wallet === false ? live.sweep : live.refund || live.sweep;
  };
  let due;
  if (opts.only) {
    const only = [...new Set(opts.only)].slice(0, RUN_ROWS);
    due = (await db.prepare("SELECT address, owner, solo FROM fee_accounts WHERE state = 'queued' AND next_at <= ?2 AND address IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(only), dueAt).all()).results;
    due = due.filter((r) => r.address !== cfg.mint && (!r.owner || onCurve(r.owner)));
  } else {
    due = (await db.prepare("SELECT address, owner, solo FROM fee_accounts WHERE state = 'queued' AND next_at <= ? ORDER BY next_at LIMIT ?").bind(dueAt, RUN_ROWS).all()).results;
  }
  due = due.filter(relevant);
  if (!due.length) return out;

  const treasury = treasuryAta(cfg.mint, cfg.payout).toBase58();
  const ctx = { mint: cfg.mint, payout: cfg.payout, treasury, deny: new Set(cfg.refundDeny), minRefund: cfg.refundMinTokens }; // minRefund by value once the mint is read
  const solo = new Set(due.filter((r) => r.solo).map((r) => r.address)); // refund batches that failed whole: these go one transaction each
  const day0 = day(now);

  // Claim before reading. A dry run claims nothing: it reads and reports.
  const token = deps.uuid();
  let claimed = due.map((r) => r.address);
  if (!dry) {
    const res = await runAll(db, claimed.map((a) => db.prepare("UPDATE fee_accounts SET state = 'claimed', claim = ?, claimed_at = ? WHERE address = ? AND state = 'queued' AND next_at <= ?").bind(token, now, a, dueAt)));
    claimed = claimed.filter((_, i) => res[i].meta.changes === 1);
    if (!claimed.length) return out;
  }
  const release = (addrs, why, delay = 60_000) => runAll(db, addrs.map((a) =>
    db.prepare("UPDATE fee_accounts SET state = 'queued', claim = NULL, next_at = ?, note = ? WHERE address = ? AND claim = ? AND state = 'claimed'").bind(now + delay, why, a, token)));

  try {
    // Read the mint with them: the signer must be its withdraw authority, or no instruction we build could work.
    const read = await deps.getAccounts([cfg.mint, ...claimed.filter((a) => a !== cfg.mint)]);
    const mint = parseMint(read.get(cfg.mint));
    if (!mint) throw new Error("The mint couldn't be read.");
    ctx.minRefund = await minRefundFor(db, cfg, mint.decimals, now);
    if (mint.withdrawAuthority !== cfg.payout) {
      console.error("fees blocked: PAYOUT_WALLET is not the mint's withdraw-withheld authority");
      if (!dry) await release(claimed, "blocked: not the withdraw authority", 300_000);
      return { ...out, blocked: "PAYOUT_WALLET is not the mint's withdraw-withheld authority." };
    }

    const plan = { refund: [], sweep: [], mint: [], none: [] };
    for (const a of claimed) {
      if (a === cfg.mint) { (mint.withheld > 0n ? plan.mint : plan.none).push({ a, w: mint.withheld, o: null, why: "mint" }); continue; }
      const acct = parseTokenAccount(read.get(a));
      const c = classify(acct, { ...ctx, address: a });
      (plan[c.action] || plan.none).push({ a, w: acct?.withheld ?? 0n, o: acct?.owner ?? null, why: c.why, solo: solo.has(a) });
    }
    out.none = plan.none.length;
    out.plan = { refund: plan.refund.length, sweep: plan.sweep.length, mint: plan.mint.length };
    if (dry) {
      // Report only; push the look-again out so a dry run doesn't re-read the same rows every tick.
      await runAll(db, claimed.map((a) => db.prepare("UPDATE fee_accounts SET next_at = ? WHERE address = ? AND state = 'queued'").bind(now + 300_000, a)));
      return out;
    }

    // Nothing to do: done (or queued again when it was touched while we read).
    await runAll(db, plan.none.map((p) => db.prepare(`UPDATE fee_accounts SET state = CASE WHEN again = 1 THEN 'queued' ELSE 'done' END, again = 0, claim = NULL, tries = 0, solo = 0, note = ?, owner = COALESCE(?, owner), updated = ?
      WHERE address = ? AND claim = ? AND state = 'claimed'`).bind(p.why, p.o, now, p.a, token)));

    // Kinds that are dry, or not asked for here, wait for their own pass. The sweep cooldown applies unless forced.
    const waiting = [...(live.refund ? [] : plan.refund), ...(live.sweep ? [] : plan.sweep), ...(live.mint ? [] : plan.mint)];
    await release(waiting.map((p) => p.a), "waiting for its pass", live.refund || live.sweep ? 60_000 : 300_000);
    // The tax first (mint, then vaults), then refunds: a backlog of buyers never holds the sell tax back. Refunds that failed
    // whole go one transaction per account, so a closed destination can only fail its own.
    const todo = [
      ...(live.mint ? plan.mint.map((p) => ({ kind: "mint", items: [p] })) : []),
      ...(live.sweep ? chunks(plan.sweep, cfg.feeBatch).map((items) => ({ kind: "sweep", items })) : []),
      ...(live.refund ? [
        ...chunks(plan.refund.filter((p) => !p.solo), cfg.feeBatch).map((items) => ({ kind: "refund", items })),
        ...plan.refund.filter((p) => p.solo).map((p) => ({ kind: "refund", items: [p] })),
      ] : []),
    ];

    // The day brake counts refund transactions only. Sweeps and mint sweeps are never braked.
    const spent = (await kvGet(db, "refund_day")) || { d: day0, n: 0 };
    let room = spent.d === day0 ? cfg.refundTxPerDay - spent.n : cfg.refundTxPerDay;
    const left = [];
    for (const t of todo) {
      if (left.length >= RUN_TXS) break;
      if (t.kind === "refund") { if (room <= 0) { out.braked = true; continue; } room--; }
      left.push(t);
    }
    const over = todo.filter((t) => !left.includes(t)).flatMap((t) => t.items.map((p) => p.a));
    if (over.length) await release(over, "run or day limit", 60_000);
    if (!left.length) return out;

    const kp = chain.payoutKeypair(env, cfg);
    const bh = await deps.blockhash();
    for (const t of left) {
      const accounts = t.items.map((p) => p.a);
      // A hot vault is write-locked by every trade: a sweep bids what recently landed on it (floor and cap from the settings).
      const priority = t.kind === "sweep" && deps.priority ? await deps.priority(accounts, cfg.feePriority, cfg.feePriorityMax) : cfg.feePriority;
      const tx = buildFeeTx(kp, bh.blockhash, { kind: t.kind, mint: cfg.mint, accounts, priority });
      const sig = chain.sigOf(tx), id = deps.uuid();
      const addrs = JSON.stringify(t.items.map((p) => p.a));
      const total = t.items.reduce((s, p) => s + p.w, 0n);
      // One transaction in D1: the batch row exists only if every account is still ours; then they become `sent`.
      await db.batch([
        db.prepare(`INSERT INTO fee_batches (id, kind, status, sig, lvbh, items, total, created)
          SELECT ?1, ?2, 'sent', ?3, ?4, ?5, ?6, ?7 WHERE (SELECT COUNT(*) FROM fee_accounts WHERE claim = ?8 AND state = 'claimed' AND address IN (SELECT value FROM json_each(?9))) = ?10`)
          .bind(id, t.kind, sig, bh.lastValidBlockHeight, JSON.stringify(t.items.map((p) => ({ a: p.a, o: p.o, w: p.w.toString() }))), Number(total), now, token, addrs, t.items.length),
        db.prepare("UPDATE fee_accounts SET state = 'sent', batch = ?1 WHERE claim = ?2 AND state = 'claimed' AND address IN (SELECT value FROM json_each(?3)) AND EXISTS (SELECT 1 FROM fee_batches WHERE id = ?1)")
          .bind(id, token, addrs),
      ]);
      if (!(await db.prepare("SELECT 1 AS x FROM fee_batches WHERE id = ?").bind(id).first())) continue; // the claim was lost: send nothing
      if (t.kind === "refund") await bumpRefunds(db, day0, now);
      try { await deps.send(tx); } catch (e) { console.error("send fee batch", t.kind, e.message); } // settled from its signature next run
      out.txs++; out[t.kind === "refund" ? "refunds" : t.kind === "sweep" ? "sweeps" : "mint"] += t.items.length;
    }
    return out;
  } finally {
    // Anything still claimed by this run was never saved in a batch: give it back. (A killed run never gets here; the
    // stale-claim release above does it.)
    await db.prepare("UPDATE fee_accounts SET state = 'queued', claim = NULL WHERE claim = ? AND state = 'claimed'").bind(token).run().catch(() => {});
  }
}

// D1 batches are one transaction; keep each one modest.
const runAll = async (db, stmts) => { const out = []; for (let i = 0; i < stmts.length; i += 100) out.push(...(await db.batch(stmts.slice(i, i + 100)))); return out; };
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));

// Settle every batch that is `sent`. Each change names the status it expects, so only one run acts on a batch.
async function settleBatches(db, cfg, deps, now) {
  const open = (await db.prepare("SELECT id, kind, sig, lvbh, items FROM fee_batches WHERE status = 'sent' ORDER BY created LIMIT 50").all()).results;
  if (!open.length) return { settled: 0 };
  const st = await deps.settle(open.map((b) => ({ sig: b.sig, lvbh: b.lvbh })));
  let settled = 0;
  for (const b of open) {
    const s = st[b.sig];
    if (!s || s === "wait") continue;
    const status = s === "confirmed" ? "confirmed" : s === "failed" ? "failed" : "lost";
    const won = await db.prepare("UPDATE fee_batches SET status = ?, settled = ? WHERE id = ? AND status = 'sent'").bind(status, now, b.id).run();
    if (!won.meta.changes) continue;
    settled++;
    const cool = now + (b.kind === "refund" ? cfg.feeCooldownMs : SWEEP_COOLDOWN_MS);
    if (status === "confirmed") {
      await db.prepare(`UPDATE fee_accounts SET state = CASE WHEN again = 1 THEN 'queued' ELSE 'done' END, again = 0, next_at = ?, tries = 0, solo = 0, claim = NULL, batch = NULL, note = ?, updated = ?
        WHERE batch = ? AND state = 'sent'`).bind(cool, b.kind, now, b.id).run();
    } else if (b.kind === "refund" && JSON.parse(b.items).length > 1) {
      // One closed destination fails a whole refund transaction (Token-2022 checks every destination), so the batch says nothing
      // about any one account: each goes again alone, uncounted, and only an account that fails alone counts towards giving up.
      await db.prepare(`UPDATE fee_accounts SET solo = 1, again = 0, claim = NULL, batch = NULL, note = ?, state = 'queued', next_at = ?, updated = ?
        WHERE batch = ? AND state = 'sent'`).bind(`refund ${status}, one by one`, now, now, b.id).run();
    } else {
      // It will never land (failed on chain, or unseen past its blockhash): read and classify again, with a backoff (the
      // doubling stops at 15 minutes). A refund account is given up after MAX_TRIES (revived by enqueue an hour later); a vault
      // or the mint never is: ?2 is 0 for them.
      await db.prepare(`UPDATE fee_accounts SET tries = tries + 1, again = 0, claim = NULL, batch = NULL, note = ?1,
        state = CASE WHEN ?2 = 1 AND tries + 1 >= ?3 THEN 'skip' ELSE 'queued' END,
        skipped_at = CASE WHEN ?2 = 1 AND tries + 1 >= ?3 THEN ?4 ELSE skipped_at END,
        next_at = ?4 + MIN(900000, 30000 * (1 << MIN(tries, 6))), updated = ?4
        WHERE batch = ?5 AND state = 'sent'`).bind(`${b.kind} ${status}`, b.kind === "refund" ? 1 : 0, MAX_TRIES, now, b.id).run();
    }
  }
  return { settled };
}

/* ---------------- the backstop scan ---------------- */

// Every token account of the mint with withheld tokens goes in the queue, however it was missed (a dropped webhook, an
// account touched by someone else's harvest, a restart). getProgramAccounts filtered by mint, which works on Helius
// and on the public RPC (tested on mainnet); if the RPC refuses it, the accounts our own poller indexed are read
// instead. Also queues the mint itself when it holds withheld tokens.
export async function scanWithheld(env, cfg, deps = realDeps(env), rpc = (m, p) => chain.rpc(env, m, p)) {
  const found = [];
  let source = "getProgramAccounts";
  try {
    const r = await rpc("getProgramAccounts", ["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", { encoding: "base64", commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: cfg.mint } }] }]);
    if (!Array.isArray(r)) throw new Error("not a list");
    for (const a of r) { const t = parseTokenAccount(Uint8Array.from(atob(a.account.data[0]), (c) => c.charCodeAt(0))); if (t) found.push({ address: a.pubkey, owner: t.owner, w: t.withheld }); }
  } catch (e) {
    source = "token_accounts index";
    console.error("scan: getProgramAccounts failed, using the index:", e.message);
    const addrs = (await env.DB.prepare("SELECT address FROM token_accounts").all()).results.map((x) => x.address);
    const read = await deps.getAccounts(addrs);
    for (const [address, bytes] of read) { const t = parseTokenAccount(bytes); if (t && t.mint === cfg.mint) found.push({ address, owner: t.owner, w: t.withheld }); }
  }
  const mint = parseMint((await deps.getAccounts([cfg.mint])).get(cfg.mint));
  const withheld = found.filter((x) => x.w > 0n);
  const queue = withheld.map((x) => ({ address: x.address, owner: x.owner }));
  if (mint?.withheld > 0n) queue.push({ address: cfg.mint });
  await enqueue(env.DB, queue, deps.now());
  return { source, accounts: found.length, withheld: withheld.length, mintWithheld: String(mint?.withheld ?? 0n) };
}
