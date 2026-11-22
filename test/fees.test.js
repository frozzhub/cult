// The refund and sweep engine (src/fees.js) against a local D1 and a fake chain that EXECUTES the transactions it is sent
// (Token-2022 withdraw-withheld in the real instruction layout, checked against mainnet simulation).
// The chain counts every instruction that acts on an account with nothing withheld: that is the signal of a double action, and
// the invariants below say it stays 0 under overlapping runs and under a process killed at every write and every send.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { rmSync, readFileSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { runFees, enqueue, scanWithheld, realDeps } from "../src/fees.js";
import { config } from "../src/config.js";
import { sigOf } from "../src/chain.js";
import { treasuryAta, parseTokenAccount, parseMint } from "../src/token22.js";
import { tokenAccount, mintAccount, addr, pda } from "./fakes.js";

const PERSIST = ".wrangler/fees-test";
const kp = Keypair.generate(), PAYOUT = kp.publicKey.toBase58(), MINT = addr(), TREASURY = treasuryAta(MINT, PAYOUT).toBase58();
const T22 = TOKEN_2022_PROGRAM_ID.toBase58();
let proxy, env, C;

/* ---------- the fake chain ---------- */

function chainFake() {
  const c = {
    now: 1_800_000_000_000, height: 1000, accounts: new Map(), mintWithheld: 0n, authority: PAYOUT,
    sent: [], landed: new Set(), acts: [], emptyActs: 0, dropNext: 0, reads: 0, failSigs: new Set(),
  };
  c.set = (a, over = {}) => { c.accounts.set(a, tokenAccount({ mint: MINT, owner: addr(), amount: 1_000n, withheld: 0n, ...over })); return a; };
  c.view = (a) => parseTokenAccount(c.accounts.get(a));
  c.mintBytes = () => mintAccount({ withdraw: c.authority, withheld: c.mintWithheld });
  const get = (a) => (a === MINT ? c.mintBytes() : c.accounts.get(a)?.slice() || null); // a read is a snapshot: a stalled run keeps what it saw
  const setWithheld = (a, v) => new DataView(c.accounts.get(a).buffer).setBigUint64(174, v, true);
  c.addWithheld = (a, v) => setWithheld(a, (c.view(a)?.withheld ?? 0n) + v);
  const addAmount = (a, v) => { const dv = new DataView(c.accounts.get(a).buffer); dv.setBigUint64(64, dv.getBigUint64(64, true) + v, true); };
  // Execute a transaction the way Token-2022 would (only the pieces we send).
  c.execute = (tx) => {
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58()), sigd = tx.signatures[0].some((b) => b !== 0);
    if (!sigd) throw new Error("unsigned");
    for (const ix of tx.message.compiledInstructions) {
      const prog = keys[ix.programIdIndex], k = ix.accountKeyIndexes.map((i) => keys[i]), d = ix.data;
      if (prog === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL") { if (!c.accounts.has(k[1])) c.accounts.set(k[1], tokenAccount({ mint: MINT, owner: PAYOUT })); continue; }
      if (prog !== T22 || d[0] !== 26) continue;
      if (k[2] !== c.authority) throw new Error("wrong authority");
      if (d[1] === 2) { // from the mint
        if (c.mintWithheld === 0n) c.emptyActs++;
        c.acts.push({ kind: "mint", address: MINT, w: c.mintWithheld }); addAmount(k[1], c.mintWithheld); c.mintWithheld = 0n; continue;
      }
      const [, dest, , ...sources] = k;
      for (const s of sources) {
        const w = c.view(s)?.withheld ?? 0n;
        if (w === 0n) c.emptyActs++;
        c.acts.push({ kind: s === dest ? "refund" : "sweep", address: s, w, owner: c.view(s)?.owner });
        setWithheld(s, 0n); addAmount(dest, w);
      }
    }
  };
  c.deps = () => ({
    getAccounts: async (addrs) => { c.reads++; return new Map(addrs.map((a) => [a, get(a)])); },
    blockhash: async () => ({ blockhash: addr(), lastValidBlockHeight: c.height + 150 }),
    send: async (tx) => {
      const sig = sigOf(tx); c.sent.push({ sig, tx, lvbh: null });
      if (c.dropNext > 0) { c.dropNext--; return sig; } // sent but never reaches a block
      if (c.failSigs.has(sig)) return sig;
      c.execute(tx); c.landed.add(sig); return sig;
    },
    settle: async (items) => Object.fromEntries(items.map((i) => [i.sig, c.landed.has(i.sig) ? "confirmed" : c.failSigs.has(i.sig) ? "failed" : c.height > i.lvbh + 150 ? "lost" : "wait"])),
    now: () => c.now,
    uuid: () => crypto.randomUUID(),
  });
  return c;
}

const rows = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then((r) => r.results);
const first = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const cfgOf = (over = {}) => config({ MINT, PAYOUT_WALLET: PAYOUT, DRY_RUN: "0", ...over });
const run = (opts, over, deps) => runFees(env, cfgOf(over), deps || C.deps(), opts);
const wallet = (over = {}) => { const o = addr(); return { owner: o, address: C.set(addr(), { owner: o, withheld: 1_000_000n, ...over }) }; };
const queue = (...ws) => enqueue(env.DB, ws.map((w) => ({ address: w.address, owner: w.owner })), C.now);
const state = async (a) => (await first("SELECT state FROM fee_accounts WHERE address = ?", a))?.state;
const withheldOf = (a) => C.view(a).withheld;
const settleAll = async (over) => { C.height += 500; C.now += 200_000; return run({}, over); };

before(async () => {
  rmSync(PERSIST, { recursive: true, force: true });
  execSync(`node node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --local --persist-to ${PERSIST}`, { stdio: "ignore", env: { ...process.env, CI: "1" } });
  proxy = await getPlatformProxy({ configPath: "wrangler.jsonc", persist: { path: PERSIST + "/v3" } });
  env = { ...proxy.env, PAYOUT_SECRET_KEY: JSON.stringify([...kp.secretKey]), MINT, PAYOUT_WALLET: PAYOUT };
});
after(async () => { await proxy?.dispose(); rmSync(PERSIST, { recursive: true, force: true }); });
beforeEach(async () => {
  C = chainFake();
  C.set(TREASURY, { owner: PAYOUT, amount: 0n });
  await env.DB.batch(["fee_accounts", "fee_batches", "kv", "token_accounts"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

/* ---------- refunds ---------- */

test("a buyer's withheld tokens go back into the same account, in one transaction, and the batch is saved BEFORE it is sent", async () => {
  const ws = [wallet(), wallet(), wallet()];
  await queue(...ws);
  const deps = C.deps(), send = deps.send;
  let seen;
  deps.send = async (tx) => { seen = await first("SELECT * FROM fee_batches WHERE sig = ?", sigOf(tx)); return send(tx); };
  const r = await run({ kinds: ["refund"] }, {}, deps);
  assert.equal(r.txs, 1);
  assert.equal(r.refunds, 3);
  assert.ok(seen && seen.status === "sent" && seen.kind === "refund", "the signature and the accounts were in D1 when the send happened");
  assert.deepEqual(JSON.parse(seen.items).map((i) => i.a).sort(), ws.map((w) => w.address).sort());
  for (const w of ws) { assert.equal(withheldOf(w.address), 0n); assert.equal(C.view(w.address).amount, 1_001_000n, "balance 1,000 + the 1,000,000 that was withheld"); }
  assert.deepEqual(C.acts.map((a) => a.kind), ["refund", "refund", "refund"]);
  assert.equal(C.emptyActs, 0);
  await settleAll();
  assert.deepEqual(await Promise.all(ws.map((w) => state(w.address))), ["done", "done", "done"]);
  assert.equal((await first("SELECT status FROM fee_batches")).status, "confirmed");
});

test("every refund gives the account back exactly what it had withheld", async () => {
  const ws = [wallet({ withheld: 7_777_777n, amount: 5n }), wallet({ withheld: 123_456n, amount: 9n })];
  await queue(...ws);
  await run({ kinds: ["refund"] });
  assert.deepEqual(ws.map((w) => C.view(w.address).amount), [7_777_782n, 123_465n]);
});

test("more accounts than one transaction holds are split into transactions of FEE_BATCH", async () => {
  const ws = Array.from({ length: 40 }, () => wallet());
  await queue(...ws);
  const r = await run({ kinds: ["refund"] });
  assert.equal(r.txs, 3, "40 accounts at 18 per transaction");
  assert.deepEqual((await rows("SELECT items FROM fee_batches")).map((b) => JSON.parse(b.items).length).sort((a, b) => a - b), [4, 18, 18]);
  assert.equal(ws.filter((w) => withheldOf(w.address) !== 0n).length, 0);
  assert.equal(C.sent.every((s) => s.tx.serialize().length <= 1232), true);
});

test("the webhook path (only + refund) leaves pool vaults for the cron; the cron sweeps them to the treasury", async () => {
  const w = wallet(), vault = C.set(addr(), { owner: pda(), withheld: 5_000_000n });
  await enqueue(env.DB, [{ address: w.address, owner: w.owner }, { address: vault, owner: C.view(vault).owner }], C.now);
  const r1 = await run({ only: [w.address, vault], kinds: ["refund"] });
  assert.equal(r1.refunds, 1);
  assert.equal(withheldOf(vault), 5_000_000n, "a vault is not touched by the refund path");
  const r2 = await run({}); // the cron: all kinds
  assert.equal(r2.sweeps, 1);
  assert.equal(withheldOf(vault), 0n);
  assert.equal(C.view(TREASURY).amount, 5_000_000n, "the sell tax is in the treasury");
  assert.equal(C.emptyActs, 0);
});

test("a run given a list of accounts (`only`) takes wallet-owned ones and never a vault or the mint, even with every kind live", async () => {
  const w = wallet(), vault = C.set(addr(), { owner: pda(), withheld: 5_000_000n });
  C.mintWithheld = 7_000n;
  await enqueue(env.DB, [{ address: w.address, owner: w.owner }, { address: vault, owner: C.view(vault).owner }, { address: MINT }], C.now);
  const r = await run({ only: [w.address, vault, MINT] });
  assert.equal(r.refunds, 1);
  assert.equal(r.sweeps + r.mint, 0);
  assert.equal(withheldOf(vault), 5_000_000n);
  assert.equal(C.mintWithheld, 7_000n);
  assert.deepEqual(await Promise.all([state(vault), state(MINT)]), ["queued", "queued"], "left for the cron");
});

test("who is refunded and who pays: delegate, close authority, program-owned, denied and dust all go to the treasury", async () => {
  const denied = addr();
  const refundW = wallet(), delegated = wallet({ delegate: addr() }), closable = wallet({ closeAuthority: addr() }), program = { address: C.set(addr(), { owner: pda(), withheld: 1_000_000n }) };
  const dust = wallet({ withheld: 99_999n }), deniedW = wallet({ owner: denied, withheld: 1_000_000n }), zero = wallet({ withheld: 0n });
  const treasuryAcct = { address: TREASURY };
  C.accounts.set(TREASURY, tokenAccount({ mint: MINT, owner: PAYOUT, amount: 0n, withheld: 3_000_000n })); // the treasury's own withheld: released into itself (review N3)
  await queue(refundW, delegated, closable, program, dust, deniedW, zero, treasuryAcct);
  await run({}, { REFUND_DENY: denied });
  const kinds = Object.fromEntries(C.acts.map((a) => [a.address, a.kind]));
  assert.equal(kinds[refundW.address], "refund");
  for (const w of [delegated, closable, program, dust, deniedW]) assert.equal(kinds[w.address], "sweep", `${w.address} pays the tax`);
  assert.equal(kinds[zero.address], undefined);
  assert.equal(kinds[TREASURY], "refund", "the treasury's own withheld is harvested into itself (the fake calls a source that is its own destination a refund)");
  assert.equal(C.view(TREASURY).withheld, 0n);
  assert.equal(C.emptyActs, 0);
  assert.equal(C.view(TREASURY).amount, 1_000_000n * 3n + 99_999n + 1_000_000n + 3_000_000n, "delegate + close authority + program + dust + denied (4 x 1,000,000 + 99,999) + its own 3,000,000");
  assert.equal(await state(zero.address), "done");
  await settleAll();
  assert.equal(await state(TREASURY), "done");
});

test("a delegate set AFTER a refund changes nothing already refunded; the next withheld tokens are swept", async () => {
  const w = wallet();
  await queue(w); await run({});
  assert.equal(C.acts.at(-1).kind, "refund");
  await settleAll();
  C.accounts.set(w.address, tokenAccount({ mint: MINT, owner: w.owner, amount: 5_000n, withheld: 800_000n, delegate: addr() }));
  await queue(w); C.now += 20_000;
  await run({});
  assert.equal(C.acts.at(-1).kind, "sweep");
});

test("someone harvested the buyer's withheld tokens into the mint first: the buyer gets nothing more (accepted), the mint's tokens go to the treasury once", async () => {
  const w = wallet({ withheld: 0n }); // already harvested away by a third party
  C.mintWithheld = 4_000_000n;
  await enqueue(env.DB, [{ address: w.address, owner: w.owner }, { address: MINT }], C.now);
  const r = await run({});
  assert.equal(r.refunds, 0);
  assert.equal(r.mint, 1);
  assert.equal(C.mintWithheld, 0n);
  assert.equal(C.view(TREASURY).amount, 4_000_000n);
  assert.equal(await state(w.address), "done");
  assert.equal(C.emptyActs, 0);
  await enqueue(env.DB, [{ address: MINT }], C.now + 1); await settleAll();
  assert.equal(C.acts.filter((a) => a.kind === "mint").length, 1, "the empty mint is read, found empty and left alone");
});

test("nothing is acted on twice: an already empty account is done, not an error, and re-queueing it sends nothing", async () => {
  const w = wallet();
  await queue(w); await run({}); await settleAll();
  const sent = C.sent.length;
  await queue(w); await settleAll(); await settleAll();
  assert.equal(C.sent.length, sent);
  assert.equal(await state(w.address), "done");
});

/* ---------- dry runs and guards ---------- */

test("DRY_RUN reads and plans but claims nothing and sends nothing; refunds can go live alone with REFUNDS_DRY_RUN=0", async () => {
  const w = wallet(), vault = C.set(addr(), { owner: pda(), withheld: 1_000_000n });
  await enqueue(env.DB, [{ address: w.address, owner: w.owner }, { address: vault, owner: C.view(vault).owner }], C.now);
  const dry = await run({}, { DRY_RUN: "1" });
  assert.deepEqual(dry.plan, { refund: 1, sweep: 1, mint: 0 });
  assert.equal(C.sent.length, 0);
  assert.equal((await first("SELECT COUNT(*) AS c FROM fee_accounts WHERE state = 'claimed'")).c, 0, "a dry run claims nothing");
  assert.equal((await first("SELECT COUNT(*) AS c FROM fee_batches")).c, 0);
  C.now += 400_000;
  const live = await run({}, { DRY_RUN: "1", REFUNDS_DRY_RUN: "0" });
  assert.equal(live.refunds, 1);
  assert.equal(live.sweeps, 0, "the sweep stays dry while payouts are dry");
  assert.equal(withheldOf(w.address), 0n);
  assert.equal(withheldOf(vault), 1_000_000n);
  assert.equal(await state(vault), "queued", "and waits for its own pass");
  C.now += 400_000;
  assert.equal((await run({}, { DRY_RUN: "0", REFUNDS_DRY_RUN: "1" })).refunds, 0, "refunds can be held back while sweeps run");
});

test("PAYOUT_WALLET must be the mint's withdraw-withheld authority: otherwise nothing is built or sent", async () => {
  const w = wallet();
  await queue(w);
  C.authority = addr();
  const r = await run({});
  assert.match(r.blocked, /withdraw-withheld authority/);
  assert.equal(C.sent.length, 0);
  assert.equal(await state(w.address), "queued");
  C.authority = PAYOUT; C.now += 400_000;
  assert.equal((await run({})).refunds, 1, "and it works the moment the authority matches");
});

test("an unreadable mint or an RPC that fails stops the run with the accounts given back", async () => {
  const w = wallet();
  await queue(w);
  const deps = C.deps();
  deps.getAccounts = async () => { throw new Error("rpc down"); };
  await assert.rejects(run({}, {}, deps), /rpc down/);
  assert.equal(await state(w.address), "queued", "released, not stuck in 'claimed'");
  assert.equal(C.sent.length, 0);
});

test("a runaway brake: REFUND_TX_PER_DAY refund transactions a day, the rest wait for tomorrow", async () => {
  const ws = Array.from({ length: 40 }, () => wallet());
  await queue(...ws);
  const r = await run({}, { REFUND_TX_PER_DAY: "2" });
  assert.equal(r.txs, 2);
  assert.equal(r.braked, true);
  assert.equal(ws.filter((w) => withheldOf(w.address) !== 0n).length, 4, "the last 4 are still queued");
  C.now += 86_400_000 + 10_000;
  assert.equal((await run({}, { REFUND_TX_PER_DAY: "2" })).txs, 1);
  assert.equal(ws.filter((w) => withheldOf(w.address) !== 0n).length, 0);
});

test("dust: a thousand tiny accounts are swept in batches, never refunded, and one run sends at most 12 transactions", async () => {
  const ws = Array.from({ length: 300 }, () => wallet({ withheld: 5n }));
  await queue(...ws);
  const r = await run({});
  assert.equal(r.refunds, 0);
  assert.ok(r.txs <= 12);
  assert.ok(C.acts.every((a) => a.kind === "sweep"));
  assert.ok(C.sent.every((s) => s.tx.serialize().length <= 1232));
});

/* ---------- settle ---------- */

test("a transaction that fails on chain puts its accounts back (with a backoff), and they are read fresh before the next try", async () => {
  const w = wallet();
  await queue(w);
  const deps = C.deps(), send = deps.send;
  deps.send = async (tx) => { C.failSigs.add(sigOf(tx)); return send(tx); };
  await run({}, {}, deps);
  assert.equal(withheldOf(w.address), 1_000_000n, "it failed, nothing moved");
  C.now += 1000; await run({});
  const a = await first("SELECT * FROM fee_accounts WHERE address = ?", w.address);
  assert.equal(a.state, "queued");
  assert.equal(a.tries, 1);
  assert.ok(a.next_at > C.now, "backed off");
  C.now += 120_000; const r = await run({});
  assert.equal(r.refunds, 1);
  assert.equal(withheldOf(w.address), 0n);
});

test("a sent transaction that is unseen waits until its blockhash is long gone, then is read again (and acts once)", async () => {
  const w = wallet();
  await queue(w);
  C.dropNext = 1;
  await run({});
  assert.equal(C.sent.length, 1);
  C.now += 60_000; await run({});
  assert.equal(C.sent.length, 1, "still inside the blockhash window: not sent again");
  assert.equal(await state(w.address), "sent");
  C.height += 500; C.now += 400_000;
  await run({});
  assert.equal(await state(w.address), "queued", "lost: given back, with a backoff");
  C.now += 60_000; await run({});
  assert.equal(C.sent.length, 2, "then read fresh and sent once more");
  assert.equal(C.emptyActs, 0);
  assert.equal(withheldOf(w.address), 0n);
});

test("touched again while its refund is in flight: marked, and read again after it settles (no second send while it is in flight)", async () => {
  const w = wallet();
  await queue(w);
  C.dropNext = 1; await run({});
  await queue(w); // a second buy lands in the same account
  assert.equal((await first("SELECT again FROM fee_accounts WHERE address = ?", w.address)).again, 1);
  assert.equal(C.sent.length, 1);
  C.height += 500; C.now += 400_000; await run({});
  C.now += 60_000; await run({});
  assert.equal(withheldOf(w.address), 0n);
  assert.equal(C.emptyActs, 0);
});

test("touched again while a LANDED refund waits to be settled: it is looked at again after the settle and the second buy is refunded too", async () => {
  const w = wallet();
  await queue(w);
  await run({}); // sent and landed at once in the fake; settled by the next run
  C.addWithheld(w.address, 800_000n); // a second buy before that settle
  await queue(w);
  assert.equal((await first("SELECT again FROM fee_accounts WHERE address = ?", w.address)).again, 1);
  C.now += 60_000; await run({}); // settles: back to queued (cooldown 10 s)
  assert.equal(await state(w.address), "queued");
  C.now += 60_000; await run({});
  assert.equal(withheldOf(w.address), 0n);
  assert.equal(C.acts.filter((a) => a.address === w.address).length, 2);
  assert.equal(C.emptyActs, 0);
});

test("touched while it is being read and found empty: queued again (the touch may have come after the read), not done", async () => {
  const w = wallet({ withheld: 0n });
  await queue(w);
  let release; const gate = new Promise((r) => (release = r)); let stalled = false;
  const slow = C.deps(), read = slow.getAccounts;
  slow.getAccounts = async (x) => { const out = await read(x); if (!stalled) { stalled = true; await gate; } return out; };
  const a = run({}, {}, slow);
  while (!stalled) await new Promise((r) => setTimeout(r, 5));
  await queue(w);
  release(); await a;
  const row = await first("SELECT state, again FROM fee_accounts WHERE address = ?", w.address);
  assert.deepEqual([row.state, row.again], ["queued", 0]);
});

test("a refund-only pass does not look at vaults or the mint: no reads, the rows stay queued and due", async () => {
  const vault = C.set(addr(), { owner: pda(), withheld: 5_000_000n });
  C.mintWithheld = 9_000n;
  await enqueue(env.DB, [{ address: vault, owner: C.view(vault).owner }, { address: MINT }], C.now);
  await run({ kinds: ["refund"] });
  assert.equal(C.reads, 0);
  assert.equal(C.sent.length, 0);
  assert.deepEqual((await rows("SELECT state, next_at FROM fee_accounts")).map((r) => [r.state, r.next_at]), [["queued", 0], ["queued", 0]]);
});

test("an account that needs a kind that is not live in this pass is put back for a minute, not read again at once", async () => {
  const w = wallet({ delegate: addr() }); // a delegate: it will be swept, not refunded
  await queue(w);
  await run({ kinds: ["refund"] });
  assert.equal(C.sent.length, 0);
  const row = await first("SELECT state, next_at FROM fee_accounts WHERE address = ?", w.address);
  assert.equal(row.state, "queued");
  assert.equal(row.next_at, C.now + 60_000);
  const reads = C.reads;
  await run({ kinds: ["refund"] });
  assert.equal(C.reads, reads, "inside the minute: not read again");
});

test("a vault is swept at most every 5 minutes (the round's `force` ignores that)", async () => {
  const vault = C.set(addr(), { owner: pda(), withheld: 5_000_000n });
  await enqueue(env.DB, [{ address: vault, owner: C.view(vault).owner }], C.now);
  assert.equal((await run({})).sweeps, 1);
  C.now += 1_000; await run({}); // settles the landed sweep: done, next look in 5 minutes
  C.addWithheld(vault, 3_000_000n); // another sell
  await enqueue(env.DB, [{ address: vault, owner: C.view(vault).owner }], C.now);
  C.now += 10_000;
  assert.equal((await run({})).sweeps, 0, "within the cooldown");
  assert.equal(withheldOf(vault), 3_000_000n);
  assert.equal((await run({ force: true })).sweeps, 1, "the round's sweep step does not wait");
  assert.equal(withheldOf(vault), 0n);
  assert.equal(C.emptyActs, 0);
  // and without force, once the cooldown has passed
  C.now += 1_000; await run({}); // settle the forced one (done, another 5 minutes)
  C.addWithheld(vault, 2_000_000n);
  await enqueue(env.DB, [{ address: vault, owner: C.view(vault).owner }], C.now);
  C.now += 299_000;
  assert.equal((await run({})).sweeps, 0);
  C.now += 2_000;
  assert.equal((await run({})).sweeps, 1);
  assert.equal(withheldOf(vault), 0n);
});

test("five failures give an account up; a touch an hour later revives it", async () => {
  const w = wallet();
  await queue(w);
  const deps = C.deps(), send = deps.send;
  deps.send = async (tx) => { C.failSigs.add(sigOf(tx)); return send(tx); };
  for (let i = 0; i < 12; i++) { C.now += 1_000_000; await run({}, {}, deps); }
  assert.equal(await state(w.address), "skip");
  const n = C.sent.length;
  await queue(w);
  assert.equal(await state(w.address), "skip", "a touch right away does not revive it");
  C.now += 3_700_000; await queue(w);
  assert.equal(await state(w.address), "queued");
  assert.equal(C.sent.length, n);
});

/* ---------- overlapping runs ---------- */

test("two runs at once: every account is acted on by exactly one of them", async () => {
  const ws = Array.from({ length: 30 }, () => wallet());
  await queue(...ws);
  const [a, b] = await Promise.all([run({}), run({})]);
  assert.equal(a.refunds + b.refunds, 30);
  assert.equal(C.emptyActs, 0);
  assert.equal(C.acts.length, 30);
  assert.equal(new Set(C.acts.map((x) => x.address)).size, 30);
});

test("a run whose list of due rows went stale (another run claimed and sent them meanwhile) claims nothing, reads nothing and sends nothing", async () => {
  const ws = [wallet(), wallet()];
  await queue(...ws);
  C.dropNext = 1; // the first run's transaction is sent but has not landed: its rows are `sent`
  const real = env.DB;
  let injected = false;
  const staleEnv = { ...env, DB: { batch: (s) => real.batch(s), prepare: (sql) => {
    const st = real.prepare(sql);
    if (!/FROM fee_accounts WHERE state = 'queued' AND next_at <= \? ORDER BY next_at LIMIT \?/.test(sql)) return st;
    return { bind: (...a) => ({ all: async () => { const r = await st.bind(...a).all(); if (!injected) { injected = true; await run({}); } return r; } }) };
  } } };
  const b = await runFees(staleEnv, cfgOf(), C.deps(), {});
  assert.ok(injected, "the other run happened between this run's list and its claim");
  assert.equal(C.sent.length, 1, "one transaction in flight, and the stale run did not add another for the same accounts");
  assert.equal(C.reads, 1, "the stale run read nothing (it lost every claim)");
  assert.equal(b.txs, 0);
  assert.deepEqual(await Promise.all(ws.map((w) => state(w.address))), ["sent", "sent"]);
});

test("two runs settling the same landed batch at once: it is settled once", async () => {
  const ws = [wallet(), wallet()];
  await queue(...ws);
  await run({ kinds: ["refund"] });
  assert.equal(C.sent.length, 1);
  C.now += 60_000;
  const [a, b] = await Promise.all([run({}), run({})]);
  assert.equal((a.settled ?? 0) + (b.settled ?? 0), 1);
  assert.equal((await first("SELECT COUNT(*) AS c FROM fee_batches WHERE status = 'confirmed'")).c, 1);
  assert.deepEqual(await Promise.all(ws.map((w) => state(w.address))), ["done", "done"]);
});

test("a claim that is not stale yet is left alone by another run; the owner sends once", async () => {
  const ws = Array.from({ length: 4 }, () => wallet());
  await queue(...ws);
  let release; const gate = new Promise((r) => (release = r)); let stalled = false;
  const slow = C.deps(), read = slow.getAccounts;
  slow.getAccounts = async (x) => { const out = await read(x); if (!stalled) { stalled = true; await gate; } return out; };
  const a = run({}, {}, slow);
  while (!stalled) await new Promise((r) => setTimeout(r, 5));
  C.now += 60_000; // 60 s: well inside the 120 s a claim is kept
  const b = await run({});
  assert.equal(b.refunds, 0, "the claimed accounts are not B's to take");
  assert.equal(C.sent.length, 0);
  release();
  const ra = await a;
  assert.equal(ra.refunds, 4);
  assert.equal(C.sent.length, 1);
  assert.equal(C.emptyActs, 0);
});

test("a run that lost only SOME of its claims saves nothing, sends nothing and puts the rest back (never a batch row without its transaction, never accounts left `sent` with no batch)", async () => {
  for (const taken of ["claimed by another run", "released and queued again"]) {
    await env.DB.batch(["fee_accounts", "fee_batches"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    C = chainFake(); C.set(TREASURY, { owner: PAYOUT, amount: 0n });
    const ws = Array.from({ length: 6 }, () => wallet());
    await queue(...ws);
    let release; const gate = new Promise((r) => (release = r)); let stalled = false;
    const slow = C.deps(), read = slow.getAccounts;
    slow.getAccounts = async (x) => { const out = await read(x); if (!stalled) { stalled = true; await gate; } return out; };
    const a = run({}, {}, slow);
    while (!stalled) await new Promise((r) => setTimeout(r, 5));
    // One of A's six accounts goes to somebody else while A is still reading.
    const victim = ws[0].address;
    if (taken === "claimed by another run") await env.DB.prepare("UPDATE fee_accounts SET claim = 'someone-else', claimed_at = ? WHERE address = ?").bind(C.now, victim).run();
    else await env.DB.prepare("UPDATE fee_accounts SET state = 'queued', claim = NULL WHERE address = ?").bind(victim).run();
    release();
    const ra = await a;
    assert.equal(ra.txs, 0, taken);
    assert.equal(C.sent.length, 0, taken);
    assert.equal((await first("SELECT COUNT(*) AS c FROM fee_batches")).c, 0, `${taken}: no batch row`);
    assert.equal((await first("SELECT COUNT(*) AS c FROM fee_accounts WHERE state = 'sent'")).c, 0, `${taken}: nothing stuck in sent`);
    for (const w of ws.slice(1)) assert.equal(await state(w.address), "queued", `${taken}: the accounts A still held go back to the queue`);
    assert.equal(await state(victim), taken === "claimed by another run" ? "claimed" : "queued");
  }
});

test("a run stalled after its claim loses the accounts to a later run; when it wakes it sends nothing", async () => {
  const ws = Array.from({ length: 6 }, () => wallet());
  await queue(...ws);
  let release; const gate = new Promise((r) => (release = r)); let stalled = false;
  const slow = C.deps(), read = slow.getAccounts;
  slow.getAccounts = async (x) => { const out = await read(x); if (!stalled) { stalled = true; await gate; } return out; };
  const a = run({}, {}, slow);
  while (!stalled) await new Promise((r) => setTimeout(r, 5));
  C.now += 200_000; // the stale-claim release: A's accounts are given back
  const b = await run({});
  assert.equal(b.refunds, 6);
  release();
  const ra = await a;
  assert.equal(ra.txs ?? 0, 0, "A's claim was gone, so its batch was never saved and never sent");
  assert.equal(C.sent.length, 1);
  assert.equal(C.emptyActs, 0);
});

/* ---------- the queue ---------- */

test("enqueue: new rows queue, finished rows queue again, in-flight rows are marked", async () => {
  const a = addr();
  await enqueue(env.DB, [{ address: a }, { address: a, owner: "o1" }], C.now);
  assert.equal((await first("SELECT COUNT(*) AS c FROM fee_accounts")).c, 1);
  assert.equal((await first("SELECT owner FROM fee_accounts WHERE address = ?", a)).owner, "o1", "the owner is kept once it is known");
  await env.DB.prepare("UPDATE fee_accounts SET state = 'done'").run();
  await enqueue(env.DB, [{ address: a }], C.now);
  assert.equal(await state(a), "queued");
  await env.DB.prepare("UPDATE fee_accounts SET state = 'claimed'").run();
  await enqueue(env.DB, [{ address: a }], C.now);
  assert.deepEqual([await state(a), (await first("SELECT again FROM fee_accounts")).again], ["claimed", 1]);
});

/* ---------- the backstop scan ---------- */

test("scan: getProgramAccounts by mint queues only accounts with withheld tokens, and the mint if it holds some", async () => {
  const w1 = wallet(), w2 = wallet({ withheld: 0n }), v = C.set(addr(), { owner: pda(), withheld: 9n });
  C.mintWithheld = 5n;
  const b64 = (a) => Buffer.from(C.accounts.get(a)).toString("base64");
  const rpc = async (m, p) => { assert.equal(m, "getProgramAccounts"); assert.deepEqual(p[1].filters, [{ memcmp: { offset: 0, bytes: MINT } }]); return [w1.address, w2.address, v, TREASURY].map((a) => ({ pubkey: a, account: { data: [b64(a), "base64"] } })); };
  const r = await scanWithheld(env, cfgOf(), C.deps(), rpc);
  assert.equal(r.source, "getProgramAccounts");
  assert.deepEqual([r.accounts, r.withheld, r.mintWithheld], [4, 2, "5"]);
  const q = (await rows("SELECT address FROM fee_accounts")).map((x) => x.address).sort();
  assert.deepEqual(q, [w1.address, v, MINT].sort());
});

test("scan falls back to the accounts our own poller indexed when the RPC refuses getProgramAccounts", async () => {
  const w1 = wallet(), w2 = wallet({ withheld: 0n });
  await env.DB.batch([w1, w2].map((w) => env.DB.prepare("INSERT INTO token_accounts (address, owner, amount, slot) VALUES (?, ?, '1', 1)").bind(w.address, w.owner)));
  const r = await scanWithheld(env, cfgOf(), C.deps(), async () => { throw new Error("too many results"); });
  assert.equal(r.source, "token_accounts index");
  assert.deepEqual((await rows("SELECT address FROM fee_accounts")).map((x) => x.address), [w1.address]);
});

test("scan fallback: an indexed account of another mint is not queued", async () => {
  const other = C.set(addr(), { mint: addr(), withheld: 5_000n }), mine = wallet();
  await env.DB.batch([[other, addr()], [mine.address, mine.owner]].map(([x, o]) => env.DB.prepare("INSERT INTO token_accounts (address, owner, amount, slot) VALUES (?, ?, '1', 1)").bind(x, o)));
  await scanWithheld(env, cfgOf(), C.deps(), async () => { throw new Error("refused"); });
  assert.deepEqual((await rows("SELECT address FROM fee_accounts")).map((x) => x.address), [mine.address]);
});

test("a queued account that no longer exists, and a mint with nothing withheld, are done: nothing is built or sent for them", async () => {
  const gone = addr();
  await enqueue(env.DB, [{ address: gone, owner: addr() }, { address: MINT }], C.now);
  const r = await run({});
  assert.equal(r.txs, 0);
  assert.equal(C.sent.length, 0);
  assert.deepEqual(await Promise.all([state(gone), state(MINT)]), ["done", "done"]);
  assert.equal(r.none, 2);
});

/* ---------- killed at every write and every send ---------- */

// A database and chain that die at point `n`: the process stops mid-run, nothing after that point happens, and "restart" is a
// fresh run on whatever was saved. Points are numbered over every D1 write (before it, or right after it) and every send
// (before it reaches the chain, or after it landed).
function dying(db, point) {
  const st = { n: 0, dead: false, at: point.n, when: point.when };
  const tick = (phase) => { if (st.dead) throw new Error("dead"); if (phase === st.when && ++st.n === st.at) { st.dead = true; if (phase === "before") throw new Error("killed"); return true; } return false; };
  const wrapStmt = (stmt, write) => new Proxy(stmt, { get: (t, k) => {
    if (k === "bind") return (...a) => wrapStmt(t.bind(...a), write);
    if (["run", "first", "all"].includes(k)) return async () => { if (st.dead) throw new Error("dead"); if (write) tick("before"); const r = await t[k](); if (write && tick("after")) throw new Error("killed"); return r; };
    return t[k]; } });
  return { st, db: { prepare: (sql) => wrapStmt(db.prepare(sql), /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)),
    batch: async (stmts) => { if (st.dead) throw new Error("dead"); tick("before"); const r = await db.batch(stmts.map((s) => s)); if (tick("after")) throw new Error("killed"); return r; } } };
}

test("killed at every write and every send: nothing is acted on twice, and after a restart every account is refunded or swept exactly once", async () => {
  const points = [];
  // First count the points in an uninterrupted run.
  const scenario = async () => {
    C = chainFake(); C.set(TREASURY, { owner: PAYOUT, amount: 0n });
    await env.DB.batch(["fee_accounts", "fee_batches", "kv"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    const ws = [wallet(), wallet(), wallet({ delegate: addr() })];
    const vault = C.set(addr(), { owner: pda(), withheld: 2_000_000n });
    await enqueue(env.DB, [...ws, { address: vault, owner: C.view(vault).owner }].map((w) => ({ address: w.address, owner: w.owner })), C.now);
    return { ws, vault, total: 3_000_000n + 2_000_000n };
  };
  const writes = async () => { const d = dying(env.DB, { n: 1e9, when: "before" }); await scenario(); await runFees({ ...env, DB: d.db }, cfgOf(), C.deps(), {}); return d.st.n; };
  const nWrites = await writes();
  assert.ok(nWrites >= 6, `expected several writes, saw ${nWrites}`);
  for (const when of ["before", "after"]) for (let n = 1; n <= nWrites; n++) points.push({ kind: "write", when, n });
  for (const when of ["before", "after"]) for (let n = 1; n <= 4; n++) points.push({ kind: "send", when, n });

  let ran = 0;
  for (const p of points) {
    const s = await scenario();
    const real = C.deps(), deps = { ...real };
    let sends = 0, dead = false;
    if (p.kind === "send") deps.send = async (tx) => {
      if (dead) throw new Error("dead");
      if (++sends !== p.n) return real.send(tx);
      dead = true;
      if (p.when === "after") await real.send(tx);   // it reached the chain; the process dies before it hears
      throw new Error("killed");
    };
    const d = p.kind === "write" ? dying(env.DB, { n: p.n, when: p.when }) : { db: env.DB, st: { dead: false } };
    try { await runFees({ ...env, DB: d.db }, cfgOf(), deps, {}); } catch { /* the process died here */ }
    // Restart: fresh process, fresh deps, time passes (stale claims, blockhash windows), until everything has settled.
    for (let i = 0; i < 8; i++) { C.height += 500; C.now += 400_000; await runFees(env, cfgOf(), C.deps(), {}); } // each pass: stale claims, blockhash windows and backoffs are over
    ran++;
    assert.equal(C.emptyActs, 0, `acted on an account with nothing withheld (a double action) after ${JSON.stringify(p)}`);
    for (const w of s.ws.slice(0, 2)) assert.equal(withheldOf(w.address), 0n, `buyer not refunded after ${JSON.stringify(p)}`);
    assert.equal(withheldOf(s.ws[2].address), 0n); assert.equal(withheldOf(s.vault), 0n, `vault not swept after ${JSON.stringify(p)}`);
    const byAddr = Object.groupBy(C.acts, (a) => a.address);
    for (const [a, list] of Object.entries(byAddr)) assert.equal(list.length, 1, `${a} was acted on ${list.length} times after ${JSON.stringify(p)}`);
    assert.deepEqual(C.acts.filter((a) => a.kind === "refund").map((a) => a.address).sort(), [s.ws[0].address, s.ws[1].address].sort(), "only wallet accounts are refunded");
    assert.equal(C.view(TREASURY).amount, 1_000_000n + 2_000_000n, `the treasury got exactly the tax after ${JSON.stringify(p)}`);
  }
  assert.ok(ran > 12);
});

test("realDeps is wired to the chain module (smoke)", () => {
  const d = realDeps({ SOLANA_RPC_URL: "https://x.test" });
  assert.deepEqual(Object.keys(d).sort(), ["blockhash", "getAccounts", "now", "priority", "send", "settle", "uuid"]);
  void VersionedTransaction; void parseMint;
});

/* ---------- review 2: N1 retries, N2 brake and dust floor, dynamic priority ---------- */

const sendFailing = (deps, bad) => { const send = deps.send; deps.send = async (tx) => { if (bad(tx)) C.failSigs.add(sigOf(tx)); return send(tx); }; return deps; };
const touchesKey = (k) => (tx) => tx.message.staticAccountKeys.some((x) => x.toBase58() === k);
const nextPass = async (deps, opts = { kinds: ["refund"] }, over = {}) => { C.now += 400_000; C.height += 500; return run(opts, over, deps); };
// The compute-unit price a transaction pays (ComputeBudget SetComputeUnitPrice: discriminator 3 then a u64).
const priceOf = (tx) => { const keys = tx.message.staticAccountKeys.map((k) => k.toBase58()); const ix = tx.message.compiledInstructions.find((i) => keys[i.programIdIndex] === "ComputeBudget111111111111111111111111111111" && i.data[0] === 3); return Buffer.from(ix.data).readBigUInt64LE(1); };

test("N1: a refund batch that fails whole (one closed destination) goes again one account per transaction; only the account that fails alone is counted, and it alone is given up", async () => {
  const ws = Array.from({ length: 5 }, () => wallet()), bad = ws[2];
  await queue(...ws);
  const deps = sendFailing(C.deps(), touchesKey(bad.address));
  await run({ kinds: ["refund"] }, {}, deps); // one batch of five: fails
  assert.equal(C.acts.length, 0);
  await nextPass(deps); // settles it: failed whole, so every account is marked to go alone and none is counted
  const afterBatch = await rows("SELECT address, tries, solo, state FROM fee_accounts");
  assert.equal(afterBatch.length, 5);
  assert.ok(afterBatch.every((r) => r.tries === 0), "a failure of the whole batch counts against nobody");
  for (let i = 0; i < 14; i++) await nextPass(deps);
  for (const w of ws.filter((x) => x !== bad)) assert.equal(withheldOf(w.address), 0n, "the four good accounts were refunded");
  assert.equal(withheldOf(bad.address), 1_000_000n);
  const a = await first("SELECT state, tries, solo FROM fee_accounts WHERE address = ?", bad.address);
  assert.deepEqual(a, { state: "skip", tries: 5, solo: 1 }, "only the account that failed alone, five times, is given up");
  const given = (await first("SELECT skipped_at FROM fee_accounts WHERE address = ?", bad.address)).skipped_at;
  assert.ok(given > C.now - 3_600_000 && given <= C.now, "the moment it was given up is recorded");
  for (const w of ws.filter((x) => x !== bad)) assert.deepEqual(await first("SELECT state, tries, solo FROM fee_accounts WHERE address = ?", w.address), { state: "done", tries: 0, solo: 0 }, "solo is cleared once refunded");
  const sizes = (await rows("SELECT items FROM fee_batches ORDER BY created")).map((b) => JSON.parse(b.items).length);
  assert.equal(sizes[0], 5);
  assert.ok(sizes.slice(1).every((n) => n === 1), "every retry is a transaction of one account");
  assert.equal(C.emptyActs, 0);
});

test("N1: a vault and the mint are never given up on: failed sweeps keep being retried, the backoff stops at 15 minutes, and the first send that lands clears it", async () => {
  const vault = C.set(addr(), { owner: pda(), withheld: 9_000_000n });
  C.mintWithheld = 5_000n;
  await enqueue(env.DB, [{ address: vault, owner: C.view(vault).owner }, { address: MINT }], C.now);
  const deps = sendFailing(C.deps(), () => true);
  await run({ kinds: ["sweep", "mint"], force: true }, {}, deps);
  for (let i = 0; i < 14; i++) await nextPass(deps, { kinds: ["sweep", "mint"], force: true });
  for (const a of [vault, MINT]) {
    const r = await first("SELECT state, tries, next_at, skipped_at FROM fee_accounts WHERE address = ?", a);
    assert.ok(["queued", "sent"].includes(r.state), `${a} is still being tried after 14 failures (state ${r.state})`);
    assert.ok(r.tries >= 10 && r.skipped_at === null);
    assert.ok(r.next_at - C.now <= 900_000, "the backoff is capped at 15 minutes");
  }
  const ok = C.deps();
  await nextPass(ok, { kinds: ["sweep", "mint"], force: true });
  assert.equal(withheldOf(vault), 0n);
  assert.equal(C.mintWithheld, 0n);
});

test("N1: a given-up refund account comes back an hour after it was GIVEN UP, however often it is touched meanwhile (and a row from before the column reads as long ago)", async () => {
  const w = wallet();
  await queue(w);
  const T = C.now;
  await env.DB.prepare("UPDATE fee_accounts SET state = 'skip', tries = 5, skipped_at = ?, updated = ? WHERE address = ?").bind(T, T, w.address).run();
  for (let m = 1; m <= 59; m += 2) { await enqueue(env.DB, [{ address: w.address, owner: w.owner }], T + m * 60_000); assert.equal(await state(w.address), "skip", `still given up ${m} minutes in, however often it is touched`); }
  await enqueue(env.DB, [{ address: w.address, owner: w.owner }], T + 3_600_000 - 1);
  assert.equal(await state(w.address), "skip", "one millisecond before the hour");
  await enqueue(env.DB, [{ address: w.address, owner: w.owner }], T + 3_600_001);
  assert.deepEqual(await first("SELECT state, tries FROM fee_accounts WHERE address = ?", w.address), { state: "queued", tries: 0 });
  await env.DB.prepare("UPDATE fee_accounts SET state = 'skip', tries = 5, skipped_at = NULL, updated = ? WHERE address = ?").bind(T + 4_000_000, w.address).run();
  await enqueue(env.DB, [{ address: w.address, owner: w.owner }], T + 4_000_001);
  assert.equal(await state(w.address), "queued", "no skipped_at (given up before migration 0007): the next touch revives it");
});

test("migration 0007 adds its columns to a fee_accounts table made by 0006: old rows keep their values and read the defaults", async () => {
  const text = (f) => readFileSync(`migrations/${f}`, "utf8").replace(/\r/g, "").replace(/--.*$/gm, "");
  const old = (sql) => sql.replace(/\bfee_accounts\b/g, "fee_accounts_old");
  const oneLine = (sql) => sql.replace(/\s+/g, " ").trim();
  try {
    await env.DB.exec(oneLine(old(/CREATE TABLE fee_accounts \([\s\S]*?\n\);/.exec(text("0006_curve_fees.sql"))[0])));
    await env.DB.prepare("INSERT INTO fee_accounts_old (address, state, tries, updated) VALUES ('a', 'skip', 5, 7)").run();
    const stmts = text("0007_fee_retry.sql").split(";").map((s) => s.trim()).filter((s) => /^ALTER TABLE/.test(s)).map(old);
    assert.equal(stmts.length, 2);
    for (const s of stmts) await env.DB.exec(oneLine(s));
    assert.deepEqual(await first("SELECT state, tries, updated, skipped_at, solo FROM fee_accounts_old WHERE address = 'a'"), { state: "skip", tries: 5, updated: 7, skipped_at: null, solo: 0 });
  } finally { await env.DB.exec("DROP TABLE IF EXISTS fee_accounts_old"); }
});

test("N2: sweeps and the mint are never braked: REFUND_TX_PER_DAY stops refunds only, and a spent refund day leaves the sell tax moving", async () => {
  const ws = Array.from({ length: 40 }, () => wallet());
  const vault = C.set(addr(), { owner: pda(), withheld: 50_000_000_000n });
  C.mintWithheld = 1_000n;
  await queue(...ws);
  await enqueue(env.DB, [{ address: vault, owner: C.view(vault).owner }, { address: MINT }], C.now);
  const over = { REFUND_TX_PER_DAY: "1" };
  const r = await run({}, over);
  assert.equal(r.refunds, 18, "one refund transaction of 18, then the brake");
  assert.equal(r.braked, true);
  assert.equal(withheldOf(vault), 0n, "the vault was swept in the same run");
  assert.equal(C.mintWithheld, 0n);
  assert.deepEqual(await first("SELECT json_extract(v, '$.n') AS n FROM kv WHERE k = 'refund_day'"), { n: 1 }, "only the refund transaction is counted");
  // The day's refund brake is spent. More tax arrives: it is swept, and no refund goes out.
  await settleAll(over); C.now += 400_000; // the first sweep is confirmed and its cooldown has passed
  C.addWithheld(vault, 7_000_000n);
  await enqueue(env.DB, [{ address: vault, owner: C.view(vault).owner }], C.now);
  const swept = await run({}, over);
  assert.equal(swept.refunds, 0);
  assert.equal(swept.sweeps, 1);
  assert.equal(withheldOf(vault), 0n);
});

test("N2: the refund count is one atomic statement: overlapping webhook runs cannot lose an update and undercount the brake", async () => {
  const ws = Array.from({ length: 8 }, () => wallet());
  await queue(...ws);
  await Promise.all(ws.map((w) => run({ only: [w.address], kinds: ["refund"] })));
  assert.equal(ws.filter((w) => withheldOf(w.address) !== 0n).length, 0);
  assert.deepEqual(await first("SELECT json_extract(v, '$.n') AS n, json_extract(v, '$.d') AS d FROM kv WHERE k = 'refund_day'"), { n: 8, d: new Date(C.now).toISOString().slice(0, 10) });
  C.now += 86_400_000;
  const w = wallet(); await queue(w);
  await run({ kinds: ["refund"] });
  assert.equal((await first("SELECT json_extract(v, '$.n') AS n FROM kv WHERE k = 'refund_day'")).n, 1, "a new UTC day starts again at 1");
});

test("N2: the dust floor is a value: REFUND_MIN_USD at the cached price (rounded up), the raw floor while there is no fresh price", async () => {
  const price = (token, at) => env.DB.prepare("INSERT INTO kv (k, v, at) VALUES ('price', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at").bind(JSON.stringify({ sol: 150, token }), at).run();
  const kindOf = (w) => C.acts.find((a) => a.address === w.address)?.kind;
  // $0.000004 a token: $0.01 is 2,500 tokens = 2,500,000,000 raw. The raw floor (100,000 = 0.1 token) would refund all of these.
  await price(0.000004, C.now);
  const below = wallet({ withheld: 2_499_999_999n }), at = wallet({ withheld: 2_500_000_000n }), above = wallet({ withheld: 3_000_000_000n });
  await queue(below, at, above);
  await run({});
  assert.deepEqual([kindOf(below), kindOf(at), kindOf(above)], ["sweep", "refund", "refund"], "worth less than a cent is swept; a cent or more is refunded");
  // Rounded up, toward the house: $0.01 at $0.000003 a token is 3,333.33 tokens, so 3,333,333,334 raw.
  C.acts.length = 0; C.now += 400_000;
  await price(0.000003, C.now);
  const justBelow = wallet({ withheld: 3_333_333_333n }), justAt = wallet({ withheld: 3_333_333_334n });
  await queue(justBelow, justAt);
  await run({});
  assert.deepEqual([kindOf(justBelow), kindOf(justAt)], ["sweep", "refund"]);
  // The floor follows the price: at $0.01 a token, 1 token is a cent, and 0.5 token is not.
  C.acts.length = 0; C.now += 400_000;
  await price(0.01, C.now);
  const half = wallet({ withheld: 500_000n }), one = wallet({ withheld: 1_000_000n });
  await queue(half, one);
  await run({});
  assert.deepEqual([kindOf(half), kindOf(one)], ["sweep", "refund"]);
  // No price (never seen, or older than an hour): REFUND_MIN_TOKENS.
  for (const stale of [null, C.now - 3_600_001]) {
    await env.DB.prepare("DELETE FROM kv WHERE k = 'price'").run();
    if (stale !== null) await price(0.000004, stale);
    C.acts.length = 0; C.now += 400_000;
    const dust = wallet({ withheld: 99_999n }), floor = wallet({ withheld: 100_000n });
    await queue(dust, floor);
    await run({});
    assert.deepEqual([kindOf(dust), kindOf(floor)], ["sweep", "refund"], stale === null ? "no price row" : "a price older than an hour is not used");
  }
  C.acts.length = 0; C.now += 400_000;
  await price(0.000004, C.now);
  const tiny = wallet({ withheld: 100_000n });
  await queue(tiny);
  await run({}, { REFUND_MIN_USD: "0" });
  assert.equal(kindOf(tiny), "refund", "REFUND_MIN_USD 0 turns the value floor off");
});

test("N1: a vault sweep bids what recently landed on the vault, between the floor and the cap; refunds and the mint pay the floor", async () => {
  const vault = C.set(addr(), { owner: pda(), withheld: 5_000_000n });
  const w = wallet();
  C.mintWithheld = 1_000n;
  await enqueue(env.DB, [{ address: vault, owner: C.view(vault).owner }, { address: w.address, owner: w.owner }, { address: MINT }], C.now);
  const deps = C.deps(), asked = [];
  deps.priority = async (accounts, floor, cap) => { asked.push({ accounts, floor, cap }); return 2_500_000; };
  await run({}, {}, deps);
  assert.deepEqual(asked, [{ accounts: [vault], floor: 100_000, cap: 10_000_000 }], "asked once, for the vault, with the settings' floor and cap");
  const byKind = Object.fromEntries((await rows("SELECT kind, sig FROM fee_batches")).map((b) => [b.kind, C.sent.find((s) => s.sig === b.sig).tx]));
  assert.equal(priceOf(byKind.sweep), 2_500_000n);
  assert.equal(priceOf(byKind.refund), 100_000n);
  assert.equal(priceOf(byKind.mint), 100_000n);
  // FEE_PRIORITY_MICROLAMPORTS and the cap come from the settings.
  await settleAll(); C.now += 400_000; // the first sweep is confirmed and its cooldown has passed
  asked.length = 0; C.addWithheld(vault, 1n); await enqueue(env.DB, [{ address: vault, owner: C.view(vault).owner }], C.now);
  await run({}, { FEE_PRIORITY_MICROLAMPORTS: "7", FEE_PRIORITY_MAX_MICROLAMPORTS: "9" }, deps);
  assert.deepEqual(asked.map((a) => [a.floor, a.cap]), [[7, 9]]);
});

test("N1: the sell tax goes first: a backlog of refund batches filling the run's 12 transactions never holds the vault back", async () => {
  const ws = Array.from({ length: 250 }, () => wallet()); // 14 refund batches of 18
  const vault = C.set(addr(), { owner: pda(), withheld: 50_000_000_000n });
  await queue(...ws);
  await enqueue(env.DB, [{ address: vault, owner: C.view(vault).owner }], C.now);
  const r = await run({});
  assert.equal(r.txs, 12, "the run is full");
  assert.equal(withheldOf(vault), 0n, "and the vault was swept in it");
  assert.equal(r.sweeps, 1);
  assert.equal(r.refunds, 11 * 18, "the refunds took the rest");
});
