// Second money review (curve design), the refund and sweep engine.
// Each test here FAILS on the code as reviewed and should pass once its finding is fixed. Same local-D1 + executing fake chain
// as test/fees.test.js (copied, trimmed: that file does not export it).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import { Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { runFees, enqueue, scanWithheld } from "../src/fees.js";
import { config } from "../src/config.js";
import { sigOf } from "../src/chain.js";
import { treasuryAta, parseTokenAccount } from "../src/token22.js";
import { tokenAccount, mintAccount, addr, pda } from "./fakes.js";

const PERSIST = ".wrangler/review2-fees-test";
const kp = Keypair.generate(), PAYOUT = kp.publicKey.toBase58(), MINT = addr(), TREASURY = treasuryAta(MINT, PAYOUT).toBase58();
const T22 = TOKEN_2022_PROGRAM_ID.toBase58();
const MIN = 60_000, HOUR = 3_600_000;
let proxy, env, C;

function chainFake() {
  const c = { now: 1_800_000_000_000, height: 1000, accounts: new Map(), mintWithheld: 0n, sent: [], landed: new Set(), failing: false, acts: [] };
  c.set = (a, over = {}) => { c.accounts.set(a, tokenAccount({ mint: MINT, owner: addr(), amount: 1_000n, withheld: 0n, ...over })); return a; };
  c.view = (a) => parseTokenAccount(c.accounts.get(a));
  const get = (a) => (a === MINT ? mintAccount({ withdraw: PAYOUT, withheld: c.mintWithheld }) : c.accounts.get(a)?.slice() || null);
  const setWithheld = (a, v) => new DataView(c.accounts.get(a).buffer).setBigUint64(174, v, true);
  c.addWithheld = (a, v) => setWithheld(a, (c.view(a)?.withheld ?? 0n) + v);
  const addAmount = (a, v) => { const dv = new DataView(c.accounts.get(a).buffer); dv.setBigUint64(64, dv.getBigUint64(64, true) + v, true); };
  c.execute = (tx) => {
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    for (const ix of tx.message.compiledInstructions) {
      const prog = keys[ix.programIdIndex], k = ix.accountKeyIndexes.map((i) => keys[i]), d = ix.data;
      if (prog === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL") { if (!c.accounts.has(k[1])) c.accounts.set(k[1], tokenAccount({ mint: MINT, owner: PAYOUT })); continue; }
      if (prog !== T22 || d[0] !== 26) continue;
      if (d[1] === 2) { addAmount(k[1], c.mintWithheld); c.mintWithheld = 0n; continue; }
      const [, dest, , ...sources] = k;
      for (const s of sources) { const w = c.view(s)?.withheld ?? 0n; c.acts.push({ kind: s === dest ? "refund" : "sweep", address: s, w }); setWithheld(s, 0n); addAmount(dest, w); }
    }
  };
  // `failing`: the payout wallet has run out of SOL (or the network drops our low-priority transactions): every send is
  // accepted by the RPC (skipPreflight) and never lands, so it settles as "lost" once its blockhash is long gone.
  c.deps = () => ({
    getAccounts: async (addrs) => new Map(addrs.map((a) => [a, get(a)])),
    blockhash: async () => ({ blockhash: addr(), lastValidBlockHeight: c.height + 150 }),
    send: async (tx) => { const sig = sigOf(tx); c.sent.push({ sig, tx }); if (!c.failing) { c.execute(tx); c.landed.add(sig); } return sig; },
    settle: async (items) => Object.fromEntries(items.map((i) => [i.sig, c.landed.has(i.sig) ? "confirmed" : c.height > i.lvbh + 150 ? "lost" : "wait"])),
    now: () => c.now,
    uuid: () => crypto.randomUUID(),
  });
  // One minute of real time: the clock and the chain both move.
  c.minute = (n = 1) => { c.now += n * MIN; c.height += n * 150; };
  return c;
}

const first = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const cfgOf = (over = {}) => config({ MINT, PAYOUT_WALLET: PAYOUT, DRY_RUN: "0", ...over });
const run = (opts = {}, over = {}) => runFees(env, cfgOf(over), C.deps(), opts);
const state = async (a) => (await first("SELECT state FROM fee_accounts WHERE address = ?", a))?.state;
const scanRpc = () => async () => [...C.accounts.keys()].map((a) => ({ pubkey: a, account: { data: [Buffer.from(C.accounts.get(a)).toString("base64"), "base64"] } }));

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

// The cron as deployed: a run every minute, the round's forced sweep every 10 minutes, the backstop scan every 30 minutes.
async function cronFor(minutes, { onMinute } = {}) {
  for (let m = 1; m <= minutes; m++) {
    C.minute();
    if (onMinute) await onMinute(m);
    if (m % 30 === 0) await scanWithheld(env, cfgOf(), C.deps(), scanRpc());
    await run();
    if (m % 10 === 0) await run({ kinds: ["sweep", "mint"], force: true });
  }
}

/* ---------- N1: a given-up account never comes back while anything keeps touching it ---------- */

test("N1a: the pool vault, given up after five lost sweeps, is never swept again while trades keep touching it (the sell tax stops for good)", async () => {
  const vault = C.set(addr(), { owner: pda(), amount: 500_000_000_000n, withheld: 0n });
  // 20 minutes in which nothing we send lands (payout wallet out of SOL, or congestion dropping 100k-microlamport transactions).
  // Sells keep arriving: each one withholds tax in the vault and the webhook queues the vault.
  C.failing = true;
  const sell = async () => { C.addWithheld(vault, 5_000_000_000n); await enqueue(env.DB, [{ address: vault, owner: C.view(vault).owner }], C.now); };
  await cronFor(40, { onMinute: (m) => (m % 2 === 0 ? sell() : null) });
  // Changed with the N1 fix (the brief: a program-owned vault is never given up on). The review's setup asserted "skip" here; the
  // rest of the test (the vault is swept once the cause is gone, however busy it is) is unchanged.
  assert.notEqual(await state(vault), "skip", "setup: five lost sweeps do not give the vault up");
  assert.ok((await first("SELECT tries FROM fee_accounts WHERE address = ?", vault)).tries >= 5, "setup: it has failed at least five times and keeps being retried");

  // The cause is gone (SOL topped up, congestion over). Trading carries on every couple of minutes for three hours.
  C.failing = false;
  await cronFor(180, { onMinute: (m) => (m % 2 === 0 ? sell() : null) });
  assert.equal(C.view(vault).withheld, 0n,
    `three hours after the outage the vault still holds ${C.view(vault).withheld} raw withheld (state ${await state(vault)}): every touch refreshes 'updated', so the hour of silence that revives a skipped row never comes`);
});

test("N1b: a buyer whose refund was lost five times is never refunded while the 30-minute scan keeps seeing the account", async () => {
  const owner = addr(), acct = C.set(addr(), { owner, amount: 9_000_000n, withheld: 1_000_000n });
  await enqueue(env.DB, [{ address: acct, owner }], C.now);
  C.failing = true;
  await cronFor(40);
  assert.equal(await state(acct), "skip", "setup: five lost refunds give the account up");

  C.failing = false;
  await cronFor(240); // four hours: eight scans, each re-queues an account that holds withheld tokens
  assert.equal(C.view(acct).withheld, 0n, `four hours later the buyer still has ${C.view(acct).withheld} raw withheld (state ${await state(acct)})`);
});

/* ---------- N2: refunds and sweeps share one day brake, and the dust floor is worth nothing ---------- */

test("N2: dust refunds an attacker triggers use up the day brake the sweeps share; the round's sweep then moves none of the sell tax", async () => {
  // Scaled: FEE_TX_PER_DAY 6 here stands for the real 5000 (the code path is the same: one counter for refunds, sweeps and mint
  // sweeps). At the real cap an attacker needs about 2,000 transactions of ~20 one-token transfers to accounts it owns (the tokens
  // come straight back to it as refunds): about 0.01 SOL a day in base fees, against about 0.07 SOL a day of our fees.
  const over = { FEE_TX_PER_DAY: "6" };
  const dust = Array.from({ length: 6 * 18 }, () => { const o = addr(); return { owner: o, address: C.set(addr(), { owner: o, withheld: 100_000n }) }; }); // 0.1 token withheld: a 1-token transfer
  for (let i = 0; i < dust.length; i += 18) {
    const batch = dust.slice(i, i + 18);
    await enqueue(env.DB, batch, C.now);
    await run({ only: batch.map((d) => d.address), kinds: ["refund"] }, over); // the webhook path, one run per attacker transaction
  }
  assert.equal(C.acts.filter((a) => a.kind === "refund").length, dust.length, "setup: every 0.1-token withheld amount is refunded at our cost, none is treated as dust");

  // A real sell: 50,000 tokens of tax in the vault. The round's sweep step runs with force.
  const vault = C.set(addr(), { owner: pda(), amount: 500_000_000_000n, withheld: 50_000_000_000n });
  await enqueue(env.DB, [{ address: vault, owner: C.view(vault).owner }], C.now);
  C.minute();
  const r = await run({ kinds: ["sweep", "mint"], force: true }, over);
  assert.equal(C.view(vault).withheld, 0n, `the sell tax stays in the vault until the next UTC day (sweep run: ${JSON.stringify({ sweeps: r.sweeps, braked: r.braked })})`);
});

test("N2b: no attacker needed: the webhook sends one refund transaction per buy, so a busy launch day reaches FEE_TX_PER_DAY and then buys are taxed 10% and no sell tax is swept until midnight UTC", async () => {
  // Scaled: 20 stands for 5000. A coin that trades well sees more than 5000 buy transactions on its first day.
  const over = { FEE_TX_PER_DAY: "20" };
  const buy = async () => {
    const o = addr(), a = C.set(addr(), { owner: o, amount: 90_000_000_000n, withheld: 10_000_000_000n }); // a 100,000-token buy
    await enqueue(env.DB, [{ address: a, owner: o }], C.now);
    await run({ only: [a], kinds: ["refund"] }, over); // handleWebhook -> refundNow: one run, one transaction, for this buy alone
    return a;
  };
  for (let i = 0; i < 20; i++) { C.now += 4_000; await buy(); }
  const late = await buy();
  const vault = C.set(addr(), { owner: pda(), amount: 500_000_000_000n, withheld: 50_000_000_000n });
  await enqueue(env.DB, [{ address: vault, owner: C.view(vault).owner }], C.now);
  C.minute();
  await run({ kinds: ["sweep", "mint"], force: true }, over); // the round's sweep step
  assert.deepEqual({ lateBuyerWithheld: C.view(late).withheld, vaultWithheld: C.view(vault).withheld }, { lateBuyerWithheld: 0n, vaultWithheld: 0n });
});

/* ---------- N3: withheld tokens in the treasury account are never released ---------- */

test("N3: tokens withheld in the treasury's own account (a leftover withdrawal, a donation) are never released, so they are never sold", async () => {
  C.addWithheld(TREASURY, 2_000_000_000n); // e.g. withdraw_leftover pays the leftover receiver (the fee wallet's ATA) with the 10% fee
  await enqueue(env.DB, [{ address: TREASURY, owner: PAYOUT }], C.now);
  await cronFor(30);
  assert.equal(C.view(TREASURY).withheld, 0n, `the treasury still has ${C.view(TREASURY).withheld} raw withheld in it (classified "${(await first("SELECT note FROM fee_accounts WHERE address = ?", TREASURY))?.note}")`);
});
