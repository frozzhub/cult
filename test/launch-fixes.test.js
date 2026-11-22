// Launch fixes: what the review tests (review-money.test.js) don't reach.
// Same local-D1 + fake-chain harness (test/engine-fakes.js). The fake RPC records every call so a test can check how it was made.
// Ported to the curve design: the pool checks became the mint's withdraw-authority check, the pool-price tests are gone with the
// pool (parseTrade, pool_params, the join fee, BUY_FEE_BPS), and the poller now records trades from jsonParsed balances.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, TransactionMessage } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import worker from "../src/index.js";
import { tick, pollMint, allocate, weigh, rentMicro } from "../src/indexer.js";
import { usdcAta, cronEnv, rpcUrls } from "../src/chain.js";
import { config } from "../src/config.js";
import { feeOn } from "../src/token22.js";
import { addr, mintAccount } from "./fakes.js";
import { TOK, RpcError, makeVault, CLEAR, boot, freshS, isSwap, touches, enhancedSell, enhancedBuy, postHook, installFakes, fastTimers } from "./engine-fakes.js";

const PERSIST = ".wrangler/launch-fixes";
const realSetTimeout = globalThis.setTimeout;
const kp = Keypair.generate();
const MINT = addr(), PAYOUT = kp.publicKey.toBase58(), VAULT = makeVault();
const DAY = 86_400_000, PERIOD = 10 * 60_000; // DROP_MINUTES=10; 6 decimals; $0.001/token; SOL $200
const T0 = Math.floor(Date.now() / PERIOD) * PERIOD + 30_000;

let proxy, env, S, cfg, restoreFetch, restoreTimers;
before(async () => {
  restoreTimers = fastTimers(); // the swap waits 2.5 s a look: don't
  ({ proxy, env } = await boot(PERSIST, { MINT, PAYOUT, kp }));
  cfg = config(env);
  restoreFetch = installFakes({ S: () => S, MINT, PAYOUT, env: () => env });
});
after(async () => { await proxy?.dispose(); restoreFetch?.(); restoreTimers?.(); });
beforeEach(async () => {
  S = freshS({ PAYOUT, vault: VAULT });
  await env.DB.batch(CLEAR.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

const ata = (w) => usdcAta(w, env).toBase58();
const holder = (tokens, { hasAta = true } = {}) => {
  const w = addr();
  S.balances.set(w, BigInt(tokens) * TOK);
  if (hasAta) S.atas.add(ata(w));
  return w;
};
const paidTo = (w) => S.sent.filter((x) => !isSwap(x) && touches(x, ata(w)));
const untilDone = async (now) => { for (let i = 0; i < 14; i++) { const r = await tick(env, now + i * 1000); if (r.status === "done" || r.idle) return r; } };
const rows = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then((r) => r.results);
const first = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const nine = () => Array.from({ length: 9 }, (_, i) => holder(100_000 * (i + 1))); // 8 + 1: two payout batches

/* ---------------- the lock: lost for real, and the claim on its own ---------------- */

// A tick stalls inside its first send. Its lock runs out (the real clock passes 15 minutes), a second tick takes over
// and carries on. When A wakes it must stop at its next step and send nothing: every holder is paid once.
test("a tick that really loses its lock stops, and nobody is paid twice", async () => {
  const ws = Array.from({ length: 20 }, (_, i) => holder(100_000 * (i + 1)));
  let release, stalled = false, lockAt = 0;
  const gate = new Promise((r) => (release = r));
  S.onSend = async (tx) => {
    if (!isSwap({ tx }) && !stalled) { lockAt = (await first("SELECT at FROM kv WHERE k = 'lock'")).at; stalled = true; await gate; }
  };
  const a = tick(env, T0);
  while (!stalled) await new Promise((r) => realSetTimeout(r, 20));
  assert.ok(lockAt >= Date.now() + 14 * 60_000, "the lock was pushed out to 15 minutes before the send");
  const b = await tick(env, Date.now() + 16 * 60_000); // the lock has run out by then
  assert.ok(b.status === "paying" || b.status === "done", JSON.stringify(b));
  release();
  const ra = await a;
  assert.match(ra.skipped, /lost the tick lock/, JSON.stringify(ra));
  await untilDone(Date.now() + 20 * 60_000);
  assert.equal(ws.filter((w) => paidTo(w).length !== 1).length, 0, "every holder was sent exactly one payout");
});

// Same race with the lock check defeated (A's lock row put back), so only the conditional claim stands between A and a
// second send of a batch B already sent.
test("a batch another run already claimed is not sent again, even by a run that still holds the lock", async () => {
  const ws = Array.from({ length: 20 }, (_, i) => holder(100_000 * (i + 1)));
  const realUUID = crypto.randomUUID;
  let n = 0;
  Object.defineProperty(crypto, "randomUUID", { value: () => `tok-${++n}`, configurable: true, writable: true });
  try {
    let release, stalled = false;
    const gate = new Promise((r) => (release = r));
    S.onSend = async (tx) => { if (!isSwap({ tx }) && !stalled) { stalled = true; await gate; } };
    const a = tick(env, T0); // takes the lock as "tok-1"
    while (!stalled) await new Promise((r) => realSetTimeout(r, 20));
    await env.DB.prepare("DELETE FROM kv WHERE k = 'lock'").run();
    await tick(env, T0 + 1000); // "tok-2": sends the batches A hasn't reached
    await env.DB.prepare("INSERT INTO kv (k, v, at) VALUES ('lock', ?, ?)").bind(JSON.stringify("tok-1"), Date.now() + 15 * 60_000).run();
    release();
    await a;
  } finally { Object.defineProperty(crypto, "randomUUID", { value: realUUID, configurable: true, writable: true }); }
  const twice = ws.filter((w) => paidTo(w).length > 1);
  assert.equal(twice.length, 0, `${twice.length} holders were sent a payout twice`);
  assert.equal(S.sent.filter((x) => !isSwap(x)).length, 3, "20 holders = 3 batches, each sent once");
});

// Two runs build a swap at the same time (the lock check defeated as above). Only the one that saves its signature first
// may send: the other finds the drop already holds a swap and sends nothing.
test("a swap another run already claimed is not sent a second time", async () => {
  holder(100_000); holder(200_000);
  const realUUID = crypto.randomUUID;
  let n = 0;
  Object.defineProperty(crypto, "randomUUID", { value: () => `tok-${++n}`, configurable: true, writable: true });
  try {
    let release, stalled = false;
    const gate = new Promise((r) => (release = r));
    S.onSwap = async () => { if (!stalled) { stalled = true; await gate; } };
    const a = tick(env, T0); // "tok-1": stalls while building its swap
    while (!stalled) await new Promise((r) => realSetTimeout(r, 20));
    await env.DB.prepare("DELETE FROM kv WHERE k = 'lock'").run();
    await tick(env, T0 + 1000); // "tok-2": builds, claims and sends its own swap
    assert.equal(S.sent.filter(isSwap).length, 1);
    await env.DB.prepare("INSERT INTO kv (k, v, at) VALUES ('lock', ?, ?)").bind(JSON.stringify("tok-1"), Date.now() + 15 * 60_000).run();
    release();
    await a;
  } finally { Object.defineProperty(crypto, "randomUUID", { value: realUUID, configurable: true, writable: true }); }
  assert.equal(S.sent.filter(isSwap).length, 1, "the second swap was built but never sent");
});

/* ---------------- a sent transaction is only sent again when it is surely gone ---------------- */

async function sentNine() {
  nine();
  await tick(env, T0);
  const b = await rows("SELECT * FROM batches ORDER BY i");
  assert.equal(b.length, 2);
  assert.ok(b.every((x) => x.status === "sent" && x.sig && x.lvbh === 1150), JSON.stringify(b));
  return b;
}

test("a transaction in a block ('processed') is never sent again, however far the height has moved", async () => {
  const b = await sentNine();
  const n = S.sent.length;
  S.status = () => ({ confirmationStatus: "processed", err: null });
  S.getTx = () => null; // not at "confirmed" yet, so getTransaction can't see it: the status alone must hold the batch
  S.height = b[0].lvbh + 5000;
  await tick(env, T0 + 60_000);
  assert.equal(S.sent.length, n);
  assert.deepEqual((await rows("SELECT status FROM batches ORDER BY i")).map((x) => x.status), ["sent", "sent"]);
});

test("a sent batch with no last-valid height is never treated as expired (no bound means wait, not a clock)", async () => {
  await sentNine();
  const n = S.sent.length;
  await env.DB.prepare("UPDATE batches SET lvbh = NULL").run();
  S.status = () => null;
  S.getTx = () => { throw new Error("must not be asked"); };
  S.height = 10_000_000;
  await tick(env, T0 + 60_000);
  assert.equal(S.sent.length, n);
  assert.ok(!S.calls.some((c) => c.method === "getTransaction"));
});

test("an unseen transaction waits out a margin past its blockhash, and is not asked about before then", async () => {
  const b = await sentNine();
  const n = S.sent.length;
  S.status = () => null;
  S.getTx = () => { throw new Error("getTransaction must not be asked inside the margin"); };
  S.height = b[0].lvbh + 150; // at the edge of the margin, not past it
  await tick(env, T0 + 60_000);
  assert.equal(S.sent.length, n);
  assert.ok(!S.calls.some((c) => c.method === "getTransaction"));
});

test("an unseen transaction past the margin that getTransaction finds is confirmed, not sent again", async () => {
  const b = await sentNine();
  const n = S.sent.length;
  S.status = () => null;
  S.getTx = (sig, opts) => { assert.equal(opts.maxSupportedTransactionVersion, 1); return { meta: { err: null } }; };
  S.height = b[0].lvbh + 151;
  const r = await tick(env, T0 + 60_000);
  assert.equal(r.status, "done", JSON.stringify(r));
  assert.equal(S.sent.length, n);
});

test("an unseen transaction past the margin that getTransaction can't find is sent again, once", async () => {
  const b = await sentNine();
  const n = S.sent.length;
  S.status = () => null;
  S.getTx = () => null;
  S.height = b[0].lvbh + 151;
  await tick(env, T0 + 60_000);
  assert.equal(S.sent.length, n + 2, "both batches sent a second time");
  const after = await rows("SELECT * FROM batches ORDER BY i");
  assert.ok(after.every((x) => x.tries === 1 && x.status === "sent" && x.sig !== b[x.i].sig));
});

test("if getTransaction can't answer, nothing is sent again", async () => {
  const b = await sentNine();
  const n = S.sent.length;
  S.status = () => null;
  S.getTx = () => { throw new RpcError(-32000, "node is behind"); };
  S.height = b[0].lvbh + 500;
  const r = await tick(env, T0 + 60_000);
  assert.ok(r.error, JSON.stringify(r));
  assert.equal(S.sent.length, n);
});

test("a swap in a block is not swapped again; one that is gone for good is", async () => {
  holder(100_000); holder(200_000);
  S.status = () => ({ confirmationStatus: "processed", err: null });
  await tick(env, T0);
  const d = await first("SELECT * FROM drops");
  assert.equal(d.status, "swap");
  S.height = d.swap_lvbh + 5000;
  S.getTx = () => null;
  await tick(env, T0 + 60_000);
  assert.equal(S.sent.filter(isSwap).length, 1, "still the one swap");
  S.status = () => null;
  await tick(env, T0 + 120_000); // sees it is gone and clears it
  assert.equal(S.sent.filter(isSwap).length, 1);
  await tick(env, T0 + 180_000); // and the next tick swaps again
  assert.equal(S.sent.filter(isSwap).length, 2, "the lost swap was retried");
});

/* ---------------- the payout wallet must be the mint's withdraw-withheld authority ---------------- */

test("the tick refuses to run when PAYOUT_WALLET isn't the mint's withdraw-withheld authority", async () => {
  holder(100_000);
  S.authority = addr();
  const r = await tick(env, T0);
  assert.match(r.skipped, /PAYOUT_WALLET/);
  assert.equal((await first("SELECT COUNT(*) AS c FROM drops")).c, 0, "no round was opened");
  assert.equal(S.sent.length, 0);
  assert.equal(await first("SELECT * FROM kv WHERE k = 'payout_check'"), null, "a failed check isn't remembered");
});

test("the tick refuses when the mint can't be read or isn't a Token-2022 mint, or MINT isn't set", async () => {
  holder(100_000);
  S.mintFails = true;
  assert.match((await tick(env, T0)).skipped, /Couldn't read the mint/);
  S.mintFails = false;
  S.mintBytes = null; // the account isn't there
  assert.match((await tick(env, T0)).skipped, /isn't a Token-2022 mint/);
  S.mintBytes = new Uint8Array(165); // a plain token account's size, not a mint
  assert.match((await tick(env, T0)).skipped, /isn't a Token-2022 mint/);
  assert.match((await tick({ ...env, MINT: "" }, T0)).skipped, /MINT and PAYOUT_WALLET/);
  assert.equal(S.sent.length, 0);
  assert.equal((await first("SELECT COUNT(*) AS c FROM drops")).c, 0);
});

test("a passed check is remembered (the mint can't change its authority), and rechecked if the wallet setting changes", async () => {
  holder(100_000);
  await tick(env, T0);
  assert.deepEqual(JSON.parse((await first("SELECT v FROM kv WHERE k = 'payout_check'")).v), { mint: MINT, payout: PAYOUT, tax: 1000, config: "", creator: "" }, "the settings the check depends on are part of what is remembered");
  // A second read of the mint would now refuse the tick, so a tick that carries on proves there was none.
  S.authority = addr();
  const again = await tick(env, T0 + 1000);
  assert.ok(!again.skipped, JSON.stringify(again));
  // another payout wallet in the settings: asked again, and refused because the mint still lets the first withdraw
  S.authority = PAYOUT;
  const other = Keypair.generate();
  const r = await tick({ ...env, PAYOUT_WALLET: other.publicKey.toBase58(), PAYOUT_SECRET_KEY: JSON.stringify([...other.secretKey]) }, T0 + 2000);
  assert.match(r.skipped, /PAYOUT_WALLET/);
});

/* ---------------- review 2, N4: more than the withdraw authority is checked on the mint ---------------- */

test("the tick also refuses a mint whose fee isn't SELL_TAX_BPS, or that can still be minted or frozen; nothing is remembered, nothing is sent", async () => {
  holder(100_000);
  S.mintBytes = mintAccount({ withdraw: PAYOUT, feeBps: 500 });
  assert.match((await tick(env, T0)).skipped, /transfer fee is 500 bps but SELL_TAX_BPS is 1000/);
  S.mintBytes = mintAccount({ withdraw: PAYOUT });
  assert.match((await tick({ ...env, SELL_TAX_BPS: "500" }, T0)).skipped, /transfer fee is 1000 bps but SELL_TAX_BPS is 500/);
  S.mintBytes = mintAccount({ withdraw: PAYOUT, mintAuthority: addr() });
  assert.match((await tick(env, T0)).skipped, /minted or frozen/);
  S.mintBytes = mintAccount({ withdraw: PAYOUT, freezeAuthority: addr() });
  assert.match((await tick(env, T0)).skipped, /minted or frozen/);
  assert.equal(S.sent.length, 0);
  assert.equal((await first("SELECT COUNT(*) AS c FROM drops")).c, 0, "no round was opened");
  assert.equal(await first("SELECT * FROM kv WHERE k = 'payout_check'"), null, "a failed check isn't remembered");
  S.mintBytes = mintAccount({ withdraw: PAYOUT }); // the same mint with neither authority, fee 10%: runs
  assert.ok(!(await tick(env, T0)).skipped);
});

test("with CREATOR (or DBC_CONFIG) set, a pool that can't be read or isn't there refuses the tick; the setting is part of what a remembered pass depends on", async () => {
  holder(100_000);
  const r = await tick({ ...env, CREATOR: addr() }, T0);
  assert.match(r.skipped, /curve pool/, JSON.stringify(r));
  assert.equal((await first("SELECT COUNT(*) AS c FROM drops")).c, 0);
  assert.equal(await first("SELECT * FROM kv WHERE k = 'payout_check'"), null);
  // A pass made without the setting is not a pass for it.
  assert.ok(!(await tick(env, T0)).skipped);
  assert.equal(JSON.parse((await first("SELECT v FROM kv WHERE k = 'payout_check'")).v).creator, "");
  assert.match((await tick({ ...env, DBC_CONFIG: addr() }, T0 + 1000)).skipped, /curve pool/, "the remembered pass had no DBC_CONFIG: asked again");
});

/* ---------------- review 2, N10 ---------------- */

test("N10: batches a practice run marked confirmed (dry-run signatures) are not counted as USDC paid or holders paid when DRY_RUN went off mid-round", async () => {
  const n = Math.floor(T0 / PERIOD);
  await env.DB.prepare("INSERT INTO drops (n, at, status, updated, usdc_micro, swap_sig) VALUES (?, ?, 'paying', ?, 10000000, 'real-swap')").bind(n, n * PERIOD, T0).run();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO payouts (drop_n, wallet, weight, micro, batch) VALUES (?, ?, 1, 4000000, 0)").bind(n, addr()),
    env.DB.prepare("INSERT INTO payouts (drop_n, wallet, weight, micro, batch) VALUES (?, ?, 1, 6000000, 1)").bind(n, addr()),
    env.DB.prepare("INSERT INTO batches (drop_n, i, sig, status) VALUES (?, 0, ?, 'confirmed')").bind(n, `dry-run-${n}-0`),
    env.DB.prepare("INSERT INTO batches (drop_n, i, sig, status) VALUES (?, 1, 'RealSignature111', 'confirmed')").bind(n),
  ]);
  assert.equal((await tick(env, T0)).status, "done");
  assert.deepEqual(await first("SELECT status, usdc_micro, holders FROM drops WHERE n = ?", n), { status: "done", usdc_micro: 6_000_000, holders: 1 });
});

/* ---------------- a separate RPC for the cron ---------------- */

test("CRON_RPC_URL is the cron's only endpoint (the shared Helius key is dropped); without it nothing changes", async () => {
  const k = "a".repeat(36);
  const shared = { SOLANA_RPC_URL: "https://rpc.test", HELIUS_KEY: k };
  assert.deepEqual(rpcUrls(cronEnv({ ...shared, CRON_RPC_URL: "https://cron.test" })), ["https://cron.test"]);
  assert.deepEqual(rpcUrls(cronEnv({ ...shared, CRON_RPC_URL: "  " })), rpcUrls(shared));
  assert.deepEqual(rpcUrls(cronEnv(shared)), rpcUrls(shared));
  holder(100_000);
  await tick({ ...env, CRON_RPC_URL: "https://cron.test" }, T0);
  assert.ok(S.calls.length > 5);
  assert.ok(S.calls.every((c) => c.url.startsWith("https://cron.test")), "every RPC call of the tick went to the cron's endpoint");
  S.calls.length = 0;
  await tick(env, T0 + PERIOD);
  assert.ok(S.calls.every((c) => c.url.startsWith("https://rpc.test")), "falls back to SOLANA_RPC_URL");
});

/* ---------------- reads at confirmed, version 1 ---------------- */

test("balances are read at 'confirmed' and getTransaction asks for version 1", async () => {
  nine();
  S.sigs = [{ signature: "s1", err: null }];
  S.getTx = (sig, opts) => { assert.equal(opts.maxSupportedTransactionVersion, 1); return { slot: 1, blockTime: 1, meta: { err: null, preTokenBalances: [], postTokenBalances: [], preBalances: [], postBalances: [] }, transaction: { message: { accountKeys: [] } } }; };
  await untilDone(T0);
  const reads = S.calls.filter((c) => c.method === "getBalance" || c.method === "getTokenAccountBalance");
  assert.ok(reads.length >= 3, "the SOL balance, the USDC balance and the treasury's CULT");
  assert.ok(reads.every((c) => c.params[1]?.commitment === "confirmed"), JSON.stringify(reads.map((c) => c.params)));
  const accounts = S.calls.filter((c) => c.method === "getMultipleAccounts" && !c.params[1]?.dataSlice);
  assert.ok(accounts.length >= 1 && accounts.every((c) => c.params[1]?.commitment === "confirmed"), "mint and token account reads are at confirmed too");
  assert.ok(S.calls.some((c) => c.method === "getTransaction"));
});

/* ---------------- paying: every payee gets an idempotent account create; a bad batch is split ---------------- */

test("every payee gets a 'create account if missing' first, whether or not they had an account at the snapshot", async () => {
  const ws = [holder(100_000), holder(200_000), holder(300_000, { hasAta: false })];
  await tick(env, T0);
  const pay = S.sent.find((x) => !isSwap(x));
  const ixs = TransactionMessage.decompile(pay.tx.message).instructions;
  const creates = ixs.filter((i) => i.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
  assert.equal(creates.length, ws.length);
  assert.equal(creates[0].data.length, 1);
  assert.equal(creates[0].data[0], 1, "the idempotent variant");
});

test("a batch that fails twice is split: one transaction per holder, only the bad account fails", async () => {
  const ws = Array.from({ length: 9 }, (_, i) => holder(1_000_000 * (i + 1)));
  const bad = ata(ws[8]);
  S.status = (sig) => ({ confirmationStatus: "confirmed", err: S.sent.find((x) => x.sig === sig).tx.message.staticAccountKeys.some((k) => k.toBase58() === bad) ? { InstructionError: [3, "InvalidAccountData"] } : null });
  const r = await untilDone(T0);
  assert.equal(r.status, "done", JSON.stringify(r));
  const count = Object.fromEntries((await rows("SELECT status, COUNT(*) AS c FROM batches GROUP BY status")).map((x) => [x.status, x.c]));
  assert.deepEqual(count, { split: 1, confirmed: 8, failed: 1 }, "the batch of 8 split into 8; 7 + the other batch confirmed; the bad one gave up");
  const d = await first("SELECT * FROM drops");
  const confirmed = await first("SELECT COALESCE(SUM(p.micro), 0) AS m, COUNT(*) AS c FROM payouts p JOIN batches b ON b.drop_n = p.drop_n AND b.i = p.batch WHERE b.status = 'confirmed'");
  assert.equal(d.usdc_micro, confirmed.m, "the drop records exactly what was paid");
  assert.equal(d.holders, 8);
  assert.ok(d.usdc_micro <= 30_000_000, "never more than the USDC the swap bought");
  const badRow = await first("SELECT b.status FROM payouts p JOIN batches b ON b.drop_n = p.drop_n AND b.i = p.batch WHERE p.wallet = ?", ws[8]);
  assert.equal(badRow.status, "failed");
  assert.equal(paidTo(ws[0]).filter((x) => !S.status(x.sig).err).length, 1, "a good holder landed once");
});

/* ---------------- who is counted and what they get ---------------- */

test("allocate: a holder opening a USDC account pays the rent out of their own share; sums stay inside the pot", () => {
  const rent = 407_856; // 2,039,280 lamports at $200 per SOL
  const r = [{ wallet: "old", weight: 100, needs_ata: 0 }, { wallet: "new", weight: 100, needs_ata: 1 }, { wallet: "tiny", weight: 1, needs_ata: 1 }];
  const { paid, total } = allocate(r, 1_000_000_000, 10_000, 8, rent);
  const by = Object.fromEntries(paid.map((p) => [p.wallet, p.micro]));
  assert.equal(by.old, Math.floor((1_000_000_000 * 100) / 201), "the holder with an account is not charged");
  assert.equal(by.new, Math.floor((1_000_000_000 * 100) / 201) - rent);
  assert.equal(by.tiny, Math.floor(1_000_000_000 / 201) - rent);
  assert.ok(total < 1_000_000_000);
  // a new wallet whose share doesn't cover the rent plus the minimum gets nothing (and stays in the pot)
  const small = allocate([{ wallet: "a", weight: 1, needs_ata: 1 }, { wallet: "b", weight: 99, needs_ata: 0 }], 1_000_000, 10_000, 8, rent);
  assert.deepEqual(small.paid.map((p) => p.wallet), ["b"]);
});

test("rent in micro-USDC rounds up at any SOL price", () => {
  assert.equal(rentMicro(200), 407_856);
  assert.equal(rentMicro(200.001), 407_859, "407,858.04 rounds up, not down");
});

test("a new holder's payout in a real round is their share less the rent, and the swap keeps nothing back for it", async () => {
  const old = holder(100_000), fresh = holder(100_000, { hasAta: false });
  await tick(env, T0);
  const d = await first("SELECT * FROM drops");
  assert.equal(d.rent_lamports, 0, "nothing held back from the swap");
  const bal = 2_000_000_000, txFees = 15_000;
  assert.equal(d.swap_lamports, bal - 50_000_000 - txFees);
  const pot = 30_000_000; // the fake swap's USDC
  const p = Object.fromEntries((await rows("SELECT wallet, micro, needs_ata FROM payouts")).map((r) => [r.wallet, r]));
  assert.equal(p[old].micro, pot / 2);
  assert.equal(p[old].needs_ata, 0);
  assert.equal(p[fresh].micro, pot / 2 - 407_856, "pays their own rent");
  assert.equal(p[fresh].needs_ata, 1);
  assert.equal(d.usdc_micro, pot - 407_856, "what's left of the rent stays in the wallet for the next round");
});

test("allocate: over 300 random rounds nobody is paid below the minimum or below zero, and the total never beats the pot", () => {
  let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let k = 0; k < 300; k++) {
    const rs = Array.from({ length: 1 + Math.floor(rnd() * 40) }, (_, i) => ({ wallet: "w" + i, weight: 1 + Math.floor(rnd() * 1e6), needs_ata: rnd() < 0.5 ? 1 : 0 }));
    const pot = Math.floor(rnd() * 5e8), min = 10_000, rent = Math.floor(rnd() * 600_000);
    const { paid, total } = allocate(rs, pot, min, 8, rent);
    assert.ok(total <= pot, `total ${total} > pot ${pot}`);
    assert.ok(paid.every((p) => p.micro >= min && Number.isInteger(p.micro)));
    assert.equal(total, paid.reduce((a, p) => a + p.micro, 0));
  }
});

test("weigh: an address with no key (a pool vault's owner, a program account) is never paid, whatever the settings say", () => {
  const w = addr();
  const holders = new Map([[VAULT.owner, 900_000_000_000n], [w, 100_000_000_000n]]);
  const out = weigh(config({ MINT, PAYOUT_WALLET: PAYOUT }), { holders, since: new Map(), lastSell: new Map(), decimals: 6, price: 0.001, now: T0 });
  assert.deepEqual(out.map((r) => r.wallet), [w]);
});

/* ---------------- the holder snapshot fails closed ---------------- */

const seedHolders = async (n) => {
  const ws = Array.from({ length: n }, () => addr());
  await env.DB.batch(ws.map((w) => env.DB.prepare("INSERT INTO holders (wallet, balance, since, seen) VALUES (?, ?, ?, 0)").bind(w, String(1_000_000n * TOK), T0 - 40 * DAY)));
  return ws;
};

test("an empty holder list stops the round and keeps every holder row", async () => {
  const ws = await seedHolders(3);
  S.das = () => ({ token_accounts: [], cursor: null });
  const r = await tick(env, T0);
  assert.match(r.error, /came back empty/);
  assert.equal((await first("SELECT COUNT(*) AS c FROM holders")).c, ws.length);
  const d = await first("SELECT * FROM drops");
  assert.equal(d.status, "snapshot");
  assert.match(d.error, /empty/);
  assert.equal((await first("SELECT COUNT(*) AS c FROM payouts")).c, 0);
});

test("a holder list that lost more than half the holders stops the round, unless ALLOW_HOLDER_DROP says it's real", async () => {
  const ws = await seedHolders(30);
  const keep = ws.slice(0, 10);
  S.balances = new Map([[VAULT.owner, 500_000_000n * TOK], ...keep.map((w) => [w, 1_000_000n * TOK])]);
  const r = await tick(env, T0);
  assert.match(r.error, /fell from 30 to 11/);
  assert.equal((await first("SELECT COUNT(*) AS c FROM holders")).c, 30, "no holder row was deleted");
  const ok = await tick({ ...env, ALLOW_HOLDER_DROP: "1" }, T0 + 1000);
  assert.ok(!ok.error, JSON.stringify(ok));
  assert.equal((await first("SELECT COUNT(*) AS c FROM holders")).c, 11);
});

test("a normal fall in holders (under half) is fine", async () => {
  const ws = await seedHolders(30);
  S.balances = new Map([[VAULT.owner, 500_000_000n * TOK], ...ws.slice(0, 20).map((w) => [w, 1_000_000n * TOK])]);
  const r = await tick(env, T0);
  assert.ok(!r.error, JSON.stringify(r));
});

test("when the live snapshot fails, the fallback index is used only if the poller has caught up", async () => {
  const w = holder(500_000);
  S.das = () => { throw new RpcError(-32000, "node is behind"); };
  S.sigsFail = true; // the poll fails, so the index is not known to be current
  const r1 = await tick(env, T0);
  assert.equal(r1.status, "snapshot");
  assert.match((await first("SELECT error FROM drops")).error, /Waiting for the holder index/);
  assert.equal((await first("SELECT COUNT(*) AS c FROM holders")).c, 0, "the stale index wasn't used");
  S.sigsFail = false;
  await env.DB.prepare("INSERT INTO token_accounts (address, owner, amount, slot) VALUES (?, ?, ?, 1)").bind(addr(), w, String(500_000n * TOK)).run();
  const r2 = await tick(env, T0 + 1000);
  assert.ok(r2.status && r2.status !== "snapshot", JSON.stringify(r2));
  assert.equal((await first("SELECT COUNT(*) AS c FROM payouts WHERE wallet = ?", w)).c, 1);
});

/* ---------------- trades: the poller and the webhook record the same sell once, and need a price ---------------- */

// A getTransaction (jsonParsed) of a sell: the wallet's token account loses `gross` raw, the vault gains it less the 10% withheld.
function rpcSell({ wallet, gross, at = T0 }) {
  const g = BigInt(gross), net = g - feeOn(g, 1000), account = addr();
  const tb = (accountIndex, owner, amount) => ({ accountIndex, mint: MINT, owner, uiTokenAmount: { amount: String(amount), decimals: 6 } });
  return { account, tx: { slot: 9, blockTime: Math.floor(at / 1000), meta: { err: null,
    preTokenBalances: [tb(1, wallet, g), tb(2, VAULT.owner, 5_000_000n * TOK)], postTokenBalances: [tb(1, wallet, 0n), tb(2, VAULT.owner, 5_000_000n * TOK + net)] },
    transaction: { signatures: ["x"], message: { accountKeys: [wallet, account, VAULT.account] } } } };
}

test("pollMint records a sell from the chain (trade, Wall row, tax in USD), indexes the balances and queues both accounts for refunds", async () => {
  const seller = addr(), { tx, account } = rpcSell({ wallet: seller, gross: 1_000n * TOK });
  S.sigs = [{ signature: "sell1", err: null }];
  S.getTx = (sig, opts) => { assert.equal(opts.maxSupportedTransactionVersion, 1); return tx; };
  const r = await pollMint(env, cfg, T0);
  assert.deepEqual([r.polled, r.added], [1, 1]);
  const t = await first("SELECT * FROM trades WHERE sig = 'sell1'");
  assert.deepEqual([t.side, t.wallet, t.tokens, t.withheld], ["sell", seller, 1_000_000_000, 100_000_000]);
  assert.ok(Math.abs(t.usd - 1) < 1e-9 && t.price_usd === 0.001, "a 1,000 CULT sale at $0.001");
  const s = await first("SELECT * FROM sells WHERE sig = 'sell1'");
  assert.deepEqual([s.wallet, s.tokens, s.fee_tokens], [seller, 1000, 100_000_000]);
  assert.ok(Math.abs(s.fee_usd - 0.1) < 1e-9 && Math.abs(s.usd - 1) < 1e-9, "the tax is 100 CULT = $0.10");
  assert.equal((await first("SELECT sells FROM sellers WHERE wallet = ?", seller)).sells, 1);
  const idx = Object.fromEntries((await rows("SELECT address, owner, amount FROM token_accounts")).map((x) => [x.address, x]));
  assert.equal(idx[account].amount, "0");
  assert.equal(idx[VAULT.account].owner, VAULT.owner);
  const q = Object.fromEntries((await rows("SELECT address, owner, state FROM fee_accounts")).map((x) => [x.address, x]));
  assert.deepEqual([q[account]?.owner, q[account]?.state, q[VAULT.account]?.owner, q[VAULT.account]?.state], [seller, "queued", VAULT.owner, "queued"]);
  assert.equal(JSON.parse((await first("SELECT v FROM kv WHERE k = 'poll_cursor'")).v), "sell1");
});

test("the same sell seen by the webhook and by the poller is recorded once", async () => {
  const seller = addr(), { tx } = rpcSell({ wallet: seller, gross: 1_000n * TOK });
  S.sigs = [{ signature: "sell1", err: null }];
  S.getTx = () => tx;
  await pollMint(env, cfg, T0);
  const hook = await (await postHook(worker, env, [enhancedSell({ sig: "sell1", wallet: seller, at: T0, gross: 1_000n * TOK, MINT, vault: VAULT })])).json();
  assert.equal(hook.added, 0);
  assert.equal((await first("SELECT COUNT(*) AS c FROM sells")).c, 1);
  assert.equal((await first("SELECT COUNT(*) AS c FROM trades")).c, 1);
  assert.equal((await first("SELECT sells FROM sellers WHERE wallet = ?", seller)).sells, 1, "the Wall counts it once");
});

test("without a CULT price nothing is recorded: the poller keeps its cursor (but still queues the accounts), the webhook asks Helius to retry", async () => {
  const seller = addr(), { tx } = rpcSell({ wallet: seller, gross: 1_000n * TOK });
  S.tokenUsd = 0;
  S.sigs = [{ signature: "sell1", err: null }];
  S.getTx = () => tx;
  const r = await pollMint(env, cfg, T0);
  assert.equal(r.noPrice, true);
  assert.equal((await first("SELECT COUNT(*) AS c FROM trades")).c, 0);
  assert.equal(await first("SELECT * FROM kv WHERE k = 'poll_cursor'"), null, "the same transaction is read again next time");
  assert.ok((await first("SELECT COUNT(*) AS c FROM fee_accounts")).c >= 2, "refunds need no price, so the accounts are queued anyway");
  const hook = await postHook(worker, env, [enhancedSell({ sig: "sell1", wallet: seller, at: T0, gross: 1_000n * TOK, MINT, vault: VAULT })]);
  assert.equal(hook.status, 503);
  assert.equal((await first("SELECT COUNT(*) AS c FROM trades")).c, 0);
  // the price comes back: Helius's retry and the poller's next look both record it, once
  await env.DB.prepare("DELETE FROM kv WHERE k = 'price'").run();
  S.tokenUsd = 0.001;
  const retry = await (await postHook(worker, env, [enhancedSell({ sig: "sell1", wallet: seller, at: T0, gross: 1_000n * TOK, MINT, vault: VAULT })])).json();
  assert.equal(retry.added, 1);
  const r2 = await pollMint(env, cfg, T0 + 61_000);
  assert.equal(r2.added, 0);
  assert.equal((await first("SELECT COUNT(*) AS c FROM sells")).c, 1);
  assert.equal(JSON.parse((await first("SELECT v FROM kv WHERE k = 'poll_cursor'")).v), "sell1");
});

/* ---------------- what the site shows ---------------- */

const api = async (p, e = env) => (await worker.fetch(new Request("http://x" + p), e)).json();

test("/api/state before launch (no MINT, DEMO off): a plain not-live state, no trading, nothing to read from D1", async () => {
  const s = await api("/api/state", { ...env, MINT: "", DEMO: "0" });
  assert.equal(s.live, false);
  assert.equal(s.trade, false);
  assert.equal(s.mint, "");
  assert.ok(s.nextDropAt && s.dropMinutes > 0 && s.minHoldUsd >= 0 && Array.isArray(s.streaks));
  assert.equal(s.totals, undefined);
});

test("the pot shown is the tax of sells not paid out yet; the Wall shows sells only, and volume counts buys and sells", async () => {
  const seller = addr(), buyer = addr(), now = Date.now();
  await postHook(worker, env, [
    enhancedSell({ sig: "sell1", wallet: seller, at: now, gross: 200_000n * TOK, MINT, vault: VAULT }), // 20,000 CULT of tax = $20
    enhancedBuy({ sig: "buy1", wallet: buyer, at: now, gross: 100_000n * TOK, MINT, vault: VAULT }),     // a buy: $100 of volume, no tax
  ]);
  const s = await api("/api/state");
  assert.ok(Math.abs(s.pending - 20) < 1e-9, "$20 from the sell; a buy adds nothing to the pot");
  assert.equal(s.totals.trades, 2);
  assert.ok(Math.abs(s.totals.volumeUsd - 300) < 1e-9, "volume counts what was traded, before the tax: $200 sold + $100 bought");
  assert.equal(s.wall.top.length, 1);
  assert.equal(Math.round(s.wall.top[0].paidUsdc), 20, "what the seller paid is the sell's tax only");
  assert.equal(s.wall.latest.length, 1);
  assert.equal(s.wall.latest[0].wallet, seller);
});

test("a practice round (DRY_RUN) is kept out of every paid figure and listed apart for the operator", async () => {
  const ws = [holder(100_000), holder(200_000)];
  await postHook(worker, env, [enhancedSell({ sig: "dry-sell", wallet: ws[0], at: T0 - PERIOD, gross: 100_000n * TOK, MINT, vault: VAULT })]); // $10 of tax
  assert.equal((await tick({ ...env, DRY_RUN: "1" }, T0)).status, "done");
  const s = await api("/api/state");
  assert.equal(s.totals.paidUsdc, 0);
  assert.equal(s.totals.drops, 0);
  assert.deepEqual(s.drops, []);
  assert.deepEqual(s.members, []);
  assert.equal(s.avgDrop24, 0);
  assert.equal(s.dryRuns.length, 1);
  assert.ok(s.dryRuns[0].usdc > 0, "the practice round's numbers can be read here");
  const w = await api("/api/wallet/" + ws[1]);
  assert.equal(w.receivedUsdc, 0);
});

/* ---------------- rate limits ---------------- */

test("rate limits: trade and read endpoints answer 429 once the binding says so; no binding means no limit", async () => {
  let n = 0; const keys = [];
  const limited = { limit: async ({ key }) => { keys.push(key); return { success: ++n <= 2 }; } };
  const lenv = { ...env, RL_TRADE: limited, RL_READ: limited };
  const get = (p, body, e = lenv) => worker.fetch(new Request("http://x" + p, body ? { method: "POST", body: JSON.stringify(body) } : { headers: { "cf-connecting-ip": "1.2.3.4" } }), e);
  // The first two reach the handler (it answers 400 "Pick buy or sell." to a quote with no side): only the limiter says 429.
  assert.equal((await get("/api/quote")).status, 400);
  assert.equal((await get("/api/quote")).status, 400);
  const r = await get("/api/quote");
  assert.equal(r.status, 429);
  assert.match((await r.json()).error, /Too many requests/);
  assert.equal(keys[0], "1.2.3.4quote", "counted per caller and per endpoint");
  n = 5;
  assert.equal((await get("/api/tx/" + "1".repeat(64))).status, 429, "status reads share the read limit");
  for (const p of ["/api/trade", "/api/refund/hint"]) assert.equal((await get(p, {})).status, 429, p);
  assert.equal((await get("/api/state")).status, 200, "other routes aren't limited");
  assert.equal((await get("/api/quote", null, env)).status, 400, "no binding: no limit");
  const broken = { limit: async () => { throw new Error("down"); } };
  assert.equal((await get("/api/quote", null, { ...env, RL_READ: broken })).status, 400, "a failing limiter lets the request through");
});

/* ---------------- the migrations on tables made before them ---------------- */

test("migrations 0005 and 0006 add their columns to existing sells, trades and drops tables; old rows keep their values and read the defaults", async () => {
  const text = (f) => readFileSync(`migrations/${f}`, "utf8").replace(/\r/g, "").replace(/--.*$/gm, "");
  const old = (sql) => sql.replace(/\b(sells|trades|drops)\b/g, "$1_old");
  const oneLine = (sql) => sql.replace(/\s+/g, " ").trim();
  const creates = (f, names) => [...text(f).matchAll(/CREATE TABLE (\w+) \([\s\S]*?\n\);/g)].filter((m) => names.includes(m[1])).map((m) => old(m[0]));
  const alters = (f) => text(f).split(";").map((s) => s.trim()).filter((s) => /^ALTER TABLE/.test(s)).map(old);
  try {
    for (const sql of [...creates("0001_init.sql", ["sells", "drops"]), ...creates("0003_trades.sql", ["trades"])]) await env.DB.exec(oneLine(sql));
    await env.DB.prepare("INSERT INTO sells_old (sig, wallet, tokens, sol_out, fee_lamports, sol_usd, at) VALUES ('old', 'w', 5, 1, 150000000, 200, 1)").run();
    await env.DB.prepare("INSERT INTO trades_old (sig, at, side, wallet, sol_lamports, price_sol, sol_usd) VALUES ('old', 1, 'buy', 'w', 5, 1, 1)").run();
    await env.DB.prepare("INSERT INTO drops_old (n, at, status, fee_lamports, updated) VALUES (1, 1, 'done', 300000000, 1)").run();
    const stmts = [...alters("0005_trade_fees.sql"), ...alters("0006_curve_fees.sql")];
    assert.ok(stmts.length >= 12, `${stmts.length} ALTER statements found`);
    for (const sql of stmts) await env.DB.exec(oneLine(sql));
    assert.deepEqual(await first("SELECT fee_lamports, sol_lamports, tokens, withheld, usd, price_usd FROM trades_old WHERE sig = 'old'"), { fee_lamports: 0, sol_lamports: 5, tokens: 0, withheld: 0, usd: 0, price_usd: 0 });
    assert.deepEqual(await first("SELECT fee_lamports, tokens, fee_tokens, usd, fee_usd FROM sells_old WHERE sig = 'old'"), { fee_lamports: 150_000_000, tokens: 5, fee_tokens: 0, usd: 0, fee_usd: 0 });
    assert.deepEqual(await first("SELECT status, fee_lamports, fee_usd, cult_sig, cult_lvbh, cult_amount, cult_out FROM drops_old WHERE n = 1"), { status: "done", fee_lamports: 300_000_000, fee_usd: 0, cult_sig: null, cult_lvbh: null, cult_amount: null, cult_out: null });
  } finally {
    for (const t of ["sells_old", "trades_old", "drops_old"]) await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
});
