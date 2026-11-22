// The round's new steps under the curve design: the sweep step, the CULT leg of the swap (price-impact cap, minimum, saved
// before sent), what a hostile Jupiter answer or simulation can and can't get signed, and crashes between claiming a swap and
// sending it. Same local-D1 + fake-chain harness as the other round tests (test/engine-fakes.js).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { createTransferInstruction } from "@solana/spl-token";
import { tick } from "../src/indexer.js";
import { usdcAta } from "../src/chain.js";
import { treasuryAta } from "../src/token22.js";
import { impactBps } from "../src/jupiter.js";
import * as fees from "../src/fees.js";
import { config } from "../src/config.js";
import { addr, SOL } from "./fakes.js";
import { TOK, makeVault, CLEAR, boot, freshS, isSwap, touches, installFakes, fastTimers } from "./engine-fakes.js";

const PERSIST = ".wrangler/round-test";
const realSetTimeout = globalThis.setTimeout;
const kp = Keypair.generate();
const MINT = addr(), PAYOUT = kp.publicKey.toBase58(), VAULT = makeVault();
const TREASURY = treasuryAta(MINT, PAYOUT).toBase58();
const PERIOD = 10 * 60_000; // DROP_MINUTES=10; 6 decimals; $0.001/token; SOL $200
const T0 = Math.floor(Date.now() / PERIOD) * PERIOD + 30_000;

let proxy, env, S, restoreFetch, restoreTimers;
before(async () => {
  restoreTimers = fastTimers();
  ({ proxy, env } = await boot(PERSIST, { MINT, PAYOUT, kp, MAX_SWAP_IMPACT_BPS: "300", MIN_SWAP_USD: "1" }));
  restoreFetch = installFakes({ S: () => S, MINT, PAYOUT, env: () => env });
});
after(async () => { await proxy?.dispose(); restoreFetch?.(); restoreTimers?.(); });
beforeEach(async () => {
  S = freshS({ PAYOUT, vault: VAULT });
  await env.DB.batch(CLEAR.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

const holder = (tokens) => {
  const w = addr();
  S.balances.set(w, BigInt(tokens) * TOK);
  S.atas.add(usdcAta(w, env).toBase58());
  return w;
};
const first = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const rows = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then((r) => r.results);
const drop = () => first("SELECT * FROM drops");
const cultSwap = (x) => isSwap(x) && touches(x, TREASURY); // the swap whose input is the treasury's CULT account
const solSwap = (x) => isSwap(x) && !touches(x, TREASURY);
const cultQuotes = () => S.quotes.filter((q) => q.inputMint === MINT);
const jsonIx = (ix) => ({ programId: ix.programId.toBase58(), accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data).toString("base64") });
const threeHolders = () => [holder(100_000), holder(200_000), holder(300_000)];

/* ---------------- (1) the sweep step ---------------- */

test("the sweep step waits while a sweep batch is 'sent' and goes on once it is settled", async () => {
  threeHolders();
  S.vaultWithheld = 10_000n * TOK; // $10 of tax in the pool vault, queued as a sell would have queued it
  await fees.enqueue(env.DB, [{ address: VAULT.account, owner: VAULT.owner }]);
  S.status = () => ({ confirmationStatus: "processed", err: null }); // in a block, not confirmed
  const r1 = await tick(env, T0);
  assert.equal(r1.status, "sweep", JSON.stringify(r1));
  const b = await rows("SELECT kind, status FROM fee_batches");
  assert.deepEqual(b.map((x) => [x.kind, x.status]), [["sweep", "sent"]]);
  assert.equal(S.sent.length, 1, "the sweep and nothing else");
  assert.equal((await tick(env, T0 + 1000)).status, "sweep", "still held");
  assert.equal(S.sent.length, 1, "and nothing more is sent while it waits");
  assert.equal(cultQuotes().length, 0, "no swap is priced before the tax is in the treasury");

  S.status = () => ({ confirmationStatus: "confirmed", err: null });
  const r3 = await tick(env, T0 + 2000);
  assert.notEqual(r3.status, "sweep", JSON.stringify(r3));
  assert.deepEqual((await rows("SELECT status FROM fee_batches")).map((x) => x.status), ["confirmed"]);
  assert.equal(S.sent.filter(cultSwap).length, 1, "the swept CULT is sold once the sweep settled");
  assert.equal((await drop()).cult_amount, String(10_000n * TOK));
});

test("in DRY_RUN the sweep step goes on without sending anything", async () => {
  threeHolders();
  S.vaultWithheld = 10_000n * TOK;
  await fees.enqueue(env.DB, [{ address: VAULT.account, owner: VAULT.owner }]);
  const r = await tick({ ...env, DRY_RUN: "1" }, T0);
  assert.equal(r.status, "done", JSON.stringify(r));
  assert.equal(S.sent.length, 0);
  assert.equal((await first("SELECT COUNT(*) AS c FROM fee_batches")).c, 0);
  assert.equal(S.vaultWithheld, 10_000n * TOK, "the vault's tax is untouched");
  const d = await drop();
  assert.deepEqual([d.cult_sig, d.swap_sig], ["dry-run", "dry-run"]);
});

test("the sweep step does not wait for a vault's 5-minute cooldown: tax that arrived after the cron's last sweep is in this round", async () => {
  threeHolders();
  const cfg = config(env);
  S.vaultWithheld = 4_000n * TOK;
  await fees.enqueue(env.DB, [{ address: VAULT.account, owner: VAULT.owner }]);
  await fees.runFees(env, cfg); // the cron sweeps it...
  await fees.runFees(env, cfg); // ...and settles that, which starts the vault's 5-minute cooldown
  assert.equal(S.cult, 4_000n * TOK);
  S.vaultWithheld = 3_000n * TOK; // another sell since
  await fees.enqueue(env.DB, [{ address: VAULT.account, owner: VAULT.owner }]);
  S.swapOut = () => 7_000_000n;
  const r = await tick(env, T0);
  assert.equal(r.status, "sweep", JSON.stringify(r)); // its sweep batch is in flight until the next tick settles it
  assert.equal(S.vaultWithheld, 0n, "the round's sweep took it although the cron could not yet");
  assert.equal((await tick(env, T0 + 1000)).status, "paying");
  assert.equal((await drop()).cult_amount, String(7_000n * TOK), "and sold it with the rest");
});

/* ---------------- (2) the CULT leg ---------------- */

test("CULT in the treasury worth the minimum or more: one swap whose input is the treasury account, its quote saved before it is sent, then the SOL leg, then allocate", async () => {
  threeHolders();
  S.cult = 5_000n * TOK; // $5
  S.swapOut = (amount, input) => (input === MINT ? 5_000_000n : 20_000_000n);
  let atSend = null;
  S.onSend = async (tx, sig) => { if (isSwap({ tx }) && touches({ tx }, TREASURY)) { const d = await drop(); atSend = { sig, saved: d.cult_sig, out: d.cult_out, amount: d.cult_amount, lvbh: d.cult_lvbh, status: d.status }; } };
  const r = await tick(env, T0);
  assert.equal(r.status, "paying", JSON.stringify(r));
  assert.deepEqual(atSend && [atSend.saved === atSend.sig, atSend.out, atSend.amount, atSend.lvbh, atSend.status], [true, 5_000_000, String(5_000n * TOK), 1150, "swap"], "signature, quoted USDC and amount were in D1 when the transaction left");
  const swaps = S.sent.filter(isSwap);
  assert.equal(swaps.length, 2);
  assert.ok(cultSwap(swaps[0]) && solSwap(swaps[1]), "the CULT leg first, then the SOL leg");
  assert.deepEqual(S.quotes.map((q) => [q.inputMint, q.amount]), [[MINT, String(5_000n * TOK)], [SOL, String(2_000_000_000 - 50_000_000 - 15_000)]]);
  const d = await drop();
  assert.equal(d.cult_out, 5_000_000);
  assert.equal(d.swap_lamports, 2_000_000_000 - 50_000_000 - 15_000);
  assert.equal(S.cult, 0n, "all of it was sold");
  assert.equal(S.usdc, 25_000_000n, "$5 from the CULT and $20 from the SOL");
  assert.ok(d.usdc_micro > 24_999_000 && d.usdc_micro <= 25_000_000, `the round pays what both legs bought: ${d.usdc_micro}`);
});

test("CULT worth less than MIN_SWAP_USD (or none at all) is left in the treasury: the leg is 'none' and the SOL leg still runs", async () => {
  threeHolders();
  S.cult = 500n * TOK; // $0.50
  const r = await tick(env, T0);
  assert.equal(r.status, "paying", JSON.stringify(r));
  const d = await drop();
  assert.equal(d.cult_sig, "none");
  assert.equal(cultQuotes().length, 0);
  assert.equal(S.cult, 500n * TOK, "still there for a later round");
  assert.ok(d.swap_sig && d.swap_sig !== "none", "the SOL leg ran");

  await env.DB.batch(CLEAR.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  S.cult = 0n;
  await tick(env, T0);
  assert.equal((await drop()).cult_sig, "none", "an empty treasury too");
  assert.equal(cultQuotes().length, 0);
});

test("SWAP=off sells nothing at all: both legs are 'none' and the pot is the USDC already in the wallet", async () => {
  threeHolders();
  S.cult = 5_000n * TOK;
  S.usdc = 12_000_000n;
  const r = await tick({ ...env, SWAP: "off" }, T0);
  assert.equal(r.status, "paying", JSON.stringify(r));
  const d = await drop();
  assert.deepEqual([d.cult_sig, d.swap_sig], ["none", "none"]);
  assert.equal(S.quotes.length, 0);
  assert.equal(S.sent.filter(isSwap).length, 0);
  assert.ok(d.usdc_micro > 11_999_000 && d.usdc_micro <= 12_000_000, String(d.usdc_micro));
});

// Jupiter's priceImpactPct counts the coin's own 10% tax as impact: a quote of 0.1049 on a 10% coin is 0.54% real impact.
test("the impact cap ignores the tax: a quote showing 10.49% on a 10% coin is 54 bps and sells everything", async () => {
  assert.equal(impactBps({ priceImpactPct: "0.1049" }, 1000), 54);
  threeHolders();
  S.cult = 100_000n * TOK; // $100
  S.impact = () => "0.1049";
  await tick(env, T0);
  assert.deepEqual(cultQuotes().map((q) => q.amount), [String(100_000n * TOK)], "one quote, for the whole balance");
  assert.equal((await drop()).cult_amount, String(100_000n * TOK));
  assert.equal(S.cult, 0n);
});

test("over the cap the leg re-quotes a smaller amount (cap / impact x 0.9 of the first) and sells only that; the rest waits", async () => {
  threeHolders();
  const full = 100_000n * TOK;
  S.cult = full;
  S.impact = (amount) => (amount >= full ? "0.15" : "0.1049"); // the full amount moves the price 15% (555 bps without the tax), a smaller one 54
  await tick(env, T0);
  const over = impactBps({ priceImpactPct: "0.15" }, 1000);
  assert.ok(over > 300, `the full amount is over the 300 bps cap (${over})`);
  const smaller = BigInt(Math.floor(Number(full) * (300 / over) * 0.9));
  assert.deepEqual(cultQuotes().map((q) => q.amount), [String(full), String(smaller)]);
  const d = await drop();
  assert.equal(d.cult_amount, String(smaller), "only what fits was sold");
  assert.equal(S.cult, full - smaller, "the rest stays in the treasury for the next round");
  assert.equal(S.sent.filter(cultSwap).length, 1);
});

test("when no size fits the cap the leg is 'none', the CULT stays, and the round goes on", async () => {
  threeHolders();
  S.cult = 100_000n * TOK;
  S.impact = () => "0.15"; // however much is asked, over the cap
  const r = await tick(env, T0);
  assert.equal(r.status, "paying", JSON.stringify(r));
  const d = await drop();
  assert.equal(d.cult_sig, "none");
  assert.ok(cultQuotes().length >= 2 && cultQuotes().length <= 5, `${cultQuotes().length} quotes, each smaller`);
  assert.ok(cultQuotes().every((q, i, a) => i === 0 || BigInt(q.amount) < BigInt(a[i - 1].amount)));
  assert.equal(S.cult, 100_000n * TOK);
  assert.equal(S.sent.filter(cultSwap).length, 0);
  assert.ok(d.swap_sig && d.swap_sig !== "none", "the SOL leg ran");
});

/* ---------------- (3) a hostile Jupiter answer or simulation is refused before anything is signed ---------------- */

const stolen = addr();
const hostileAnswers = [
  ["an extra System transfer to another wallet", (a) => a.setupInstructions.push(jsonIx(SystemProgram.transfer({ fromPubkey: new PublicKey(PAYOUT), toPubkey: new PublicKey(stolen), lamports: 1_000_000 }))), /refused \(system transfer\)/],
  ["a Token program transfer out of the wallet", (a) => a.setupInstructions.push(jsonIx(createTransferInstruction(new PublicKey(TREASURY), new PublicKey(stolen), new PublicKey(PAYOUT), 1n))), /refused \(token instruction\)/],
  ["an instruction of a program nobody expected", (a) => a.setupInstructions.push({ programId: addr(), accounts: [], data: "" }), /refused \(unexpected program\)/],
  ["a second signer on the swap instruction", (a) => a.swapInstruction.accounts.push({ pubkey: addr(), isSigner: true, isWritable: false }), /refused \(another signer\)/],
  ["a token ledger instruction", (a) => { a.tokenLedgerInstruction = a.swapInstruction; }, /instructions we don't accept/],
  ["other instructions", (a) => { a.otherInstructions = [a.swapInstruction]; }, /instructions we don't accept/],
];

async function refused({ leg, setup, match, cult = 5_000n * TOK }) {
  threeHolders();
  if (leg === "cult") S.cult = cult;
  setup();
  const r = await tick(env, T0);
  assert.match(r.error, match, JSON.stringify(r));
  assert.equal(S.sent.length, 0, "nothing was sent");
  const d = await drop();
  assert.equal(d.status, "swap", "the round stops at the swap");
  assert.match(d.error, match, "and says why");
  assert.equal(d.swap_sig, null);
  assert.equal(d.cult_sig, leg === "cult" ? null : "none", "no signature was saved for the refused leg");
  assert.equal(S.cult, leg === "cult" ? cult : 0n, "the CULT is still there");
}

for (const [name, hook, match] of hostileAnswers) {
  test(`CULT leg: Jupiter's swap with ${name} is refused and nothing is sent`, () => refused({ leg: "cult", setup: () => { S.instructionsHook = hook; }, match }));
}
test("SOL leg: Jupiter's swap with an extra System transfer to another wallet is refused and nothing is sent", () => refused({ leg: "sol", setup: () => { S.instructionsHook = hostileAnswers[0][1]; }, match: hostileAnswers[0][2] }));
test("SOL leg: a swap that wraps more SOL than it sells is refused", () => refused({
  leg: "sol", match: /refused \(system transfer\)/,
  setup: () => { S.instructionsHook = (a) => { a.setupInstructions[1] = jsonIx(SystemProgram.transfer({ fromPubkey: new PublicKey(PAYOUT), toPubkey: new PublicKey(a.setupInstructions[1].accounts[1].pubkey), lamports: 2_000_000_000 })); }; },
}));

test("CULT leg: a simulation that pays out less than the quote is refused", () => refused({ leg: "cult", setup: () => { S.simShort = 2_000_000n; }, match: /refused \(the swap would pay out less than its quote\)/ }));
test("CULT leg: a simulation that fails is refused", () => refused({ leg: "cult", setup: () => { S.simErr = { InstructionError: [2, "Custom"] }; }, match: /refused \(the swap fails in simulation\)/ }));
// Only part of the balance is sold here (over the cap), so the account can lose more than that without going below zero.
test("CULT leg: a simulation that takes more CULT than was sold is refused", () => refused({
  leg: "cult", cult: 100_000n * TOK, match: /refused \(the swap would take more than it should\)/,
  setup: () => { S.simTake = 1n; S.impact = (amount) => (amount >= 100_000n * TOK ? "0.15" : "0.1049"); },
}));
test("SOL leg: a simulation that pays out less than the quote is refused", () => refused({ leg: "sol", setup: () => { S.simShort = 2_000_000n; }, match: /refused \(the swap would pay out less than its quote\)/ }));
test("SOL leg: a simulation that takes more SOL than was sold (beyond fees and rent) is refused", () => refused({ leg: "sol", setup: () => { S.simTake = 7_000_000n; }, match: /refused \(the swap would take more SOL than it should\)/ }));

test("the sweep step queues the mint itself: tokens anyone harvested into the mint reach the treasury in this round, with no scan needed", async () => {
  threeHolders();
  S.mintWithheld = 4_000n * TOK;
  S.swapOut = () => 4_000_000n;
  await env.DB.prepare("INSERT INTO kv (k, v, at) VALUES ('fee_scan', '{}', ?)").bind(T0).run(); // the backstop scan ran a moment ago
  const r = await tick(env, T0);
  assert.equal(S.mintWithheld, 0n, JSON.stringify(r));
  assert.equal(S.cult, 4_000n * TOK, "in the treasury");
  assert.equal((await rows("SELECT kind FROM fee_batches")).map((x) => x.kind)[0], "mint");
});

/* ---------------- (2b) the CULT leg's refusals ---------------- */

test("an empty treasury with MIN_SWAP_USD 0: nothing is priced and nothing is sold", async () => {
  threeHolders();
  const r = await tick({ ...env, MIN_SWAP_USD: "0" }, T0);
  assert.notEqual(r.status, "swap", JSON.stringify(r));
  assert.equal(cultQuotes().length, 0);
  assert.equal(S.sent.filter(cultSwap).length, 0);
  assert.equal((await drop()).cult_sig, "none");
});

test("a CULT price that is unknown at the swap step stops the round with a plain message instead of skipping the sale", async () => {
  threeHolders();
  S.cult = 5_000n * TOK;
  S.tokenUsd = 0; // Jupiter has no price for the coin and the curve was never read
  const n = Math.floor(T0 / PERIOD);
  await env.DB.prepare("INSERT INTO drops (n, at, status, updated) VALUES (?, ?, 'swap', ?)").bind(n, n * PERIOD, T0).run();
  const r = await tick(env, T0);
  assert.match(r.error, /No \$CULT price yet/);
  const d = await drop();
  assert.equal(d.status, "swap");
  assert.equal(d.cult_sig, null, "not marked 'none': the sale is only postponed");
  assert.equal(S.sent.length, 0);
});

test("a sale whose size, cut to fit the price-impact cap, is worth less than the minimum is skipped after ONE quote", async () => {
  threeHolders();
  S.cult = 5_000n * TOK; // $5
  S.impact = "0.5";      // 50% impact however much is sold
  const r = await tick(env, T0);
  assert.notEqual(r.status, "swap", JSON.stringify(r));
  assert.equal(cultQuotes().length, 1, "priced once, cut to about $0.30, under the $1 minimum: no point in asking again");
  assert.equal((await drop()).cult_sig, "none");
  assert.equal(S.cult, 5_000n * TOK, "kept for a calmer round");
});

/* ---------------- (4) a crash between claiming a leg and sending it never makes it go twice ---------------- */

// A run that stalls while building its CULT swap (the lock check defeated, as in launch-fixes): only the run that saved its
// signature first may send; the other finds the claim taken and sends nothing.
test("a CULT swap another run already claimed is not sent a second time", async () => {
  threeHolders();
  S.cult = 5_000n * TOK;
  S.sol = 0; // no SOL leg: one swap in the whole round
  const realUUID = crypto.randomUUID;
  let n = 0;
  Object.defineProperty(crypto, "randomUUID", { value: () => `tok-${++n}`, configurable: true, writable: true });
  try {
    let release, stalled = false;
    const gate = new Promise((r) => (release = r));
    S.onSwap = async () => { if (!stalled) { stalled = true; await gate; } };
    const a = tick(env, T0); // "tok-1": stalls while building its CULT swap
    while (!stalled) await new Promise((r) => realSetTimeout(r, 20));
    await env.DB.prepare("DELETE FROM kv WHERE k = 'lock'").run();
    await tick(env, T0 + 1000); // "tok-2": builds, claims and sends the CULT swap
    assert.equal(S.sent.filter(cultSwap).length, 1);
    await env.DB.prepare("INSERT INTO kv (k, v, at) VALUES ('lock', ?, ?)").bind(JSON.stringify("tok-1"), Date.now() + 15 * 60_000).run();
    release();
    await a;
  } finally { Object.defineProperty(crypto, "randomUUID", { value: realUUID, configurable: true, writable: true }); }
  assert.equal(S.sent.filter(isSwap).length, 1, "the second swap was built but never sent");
  assert.equal(S.quotes.length, 2, "both runs priced it");
  assert.equal(S.cult, 0n, "sold once");
});

test("a run that built its CULT swap after another had saved its signature (and died before sending) neither overwrites that signature nor sends", async () => {
  threeHolders();
  S.cult = 5_000n * TOK;
  S.sol = 0;
  const realUUID = crypto.randomUUID;
  let n = 0;
  Object.defineProperty(crypto, "randomUUID", { value: () => `tok-${++n}`, configurable: true, writable: true });
  try {
    let release, stalled = false;
    const gate = new Promise((r) => (release = r));
    S.onSwap = async () => { if (!stalled) { stalled = true; await gate; } };
    const a = tick(env, T0); // "tok-1": stalls while building its CULT swap
    while (!stalled) await new Promise((r) => realSetTimeout(r, 20));
    await env.DB.prepare("DELETE FROM kv WHERE k = 'lock'").run();
    S.onSend = (tx) => { if (cultSwap({ tx })) throw new Error("the process died before the send"); };
    const b = await tick(env, T0 + 1000); // "tok-2": claims the swap (signature saved) and dies at the send
    assert.ok(b.error, JSON.stringify(b));
    const saved = (await drop()).cult_sig;
    assert.ok(saved && saved !== "none");
    S.onSend = null;
    await env.DB.prepare("INSERT INTO kv (k, v, at) VALUES ('lock', ?, ?)").bind(JSON.stringify("tok-1"), Date.now() + 15 * 60_000).run();
    release();
    await a;
    assert.equal((await drop()).cult_sig, saved, "the first claim stands");
  } finally { Object.defineProperty(crypto, "randomUUID", { value: realUUID, configurable: true, writable: true }); }
  assert.equal(S.sent.length, 0, "the late run sends nothing: the transaction it built is not the one on record");
});

test("a CULT swap saved but never sent (the process died) is not sent early, not sold again by the next tick, and is only retried once it is surely gone", async () => {
  threeHolders();
  S.cult = 5_000n * TOK;
  let crash = true;
  S.onSend = (tx) => { if (crash && cultSwap({ tx })) { crash = false; throw new Error("the process died before the send"); } };
  const r1 = await tick(env, T0);
  assert.ok(r1.error, JSON.stringify(r1));
  const claimed = await drop();
  assert.ok(claimed.cult_sig && claimed.cult_sig !== "none" && claimed.cult_lvbh === 1150, "the signature was saved before the send");
  assert.equal(S.sent.length, 0, "and it never went out");

  await tick(env, T0 + 60_000);
  assert.equal(S.sent.length, 0, "inside the blockhash's life nothing is sent: the transaction could still be out there");
  assert.equal(cultQuotes().length, 1, "and no second swap is even priced");
  assert.equal((await drop()).cult_sig, claimed.cult_sig);

  S.height = claimed.cult_lvbh + 150; // the edge of the margin
  await tick(env, T0 + 120_000);
  assert.equal(S.sent.length, 0);
  assert.equal((await drop()).cult_sig, claimed.cult_sig, "still inside the margin");

  S.height = claimed.cult_lvbh + 151; // past it, and the chain has never seen it
  await tick(env, T0 + 180_000);
  const cleared = await drop();
  assert.equal(cleared.cult_sig, null, "gone for good: cleared");
  assert.match(cleared.error, /CULT swap didn't land/);
  assert.equal(S.sent.length, 0, "clearing sends nothing");

  await tick(env, T0 + 240_000); // the next tick sells the CULT again, once
  assert.equal(S.sent.filter(cultSwap).length, 1);
  for (let i = 0; i < 6; i++) await tick(env, T0 + 300_000 + i * 1000);
  assert.equal(S.sent.filter(cultSwap).length, 1, "later ticks never sell it again");
  assert.equal(cultQuotes().length, 2, "the lost one and the retry");
  assert.equal(S.cult, 0n);
});

test("a SOL swap saved but never sent: the CULT leg is not repeated, and the SOL swap is not sent early", async () => {
  threeHolders();
  S.cult = 5_000n * TOK;
  let crash = true;
  S.onSend = (tx) => { if (crash && solSwap({ tx })) { crash = false; throw new Error("the process died before the send"); } };
  const r1 = await tick(env, T0);
  assert.ok(r1.error, JSON.stringify(r1));
  const claimed = await drop();
  assert.ok(claimed.cult_sig && claimed.cult_sig !== "none", "the CULT leg went through");
  assert.ok(claimed.swap_sig && claimed.swap_sig !== "none" && claimed.swap_lvbh === 1150, "the SOL leg's signature was saved");
  assert.equal(S.sent.length, 1, "only the CULT swap left");

  await tick(env, T0 + 60_000);
  assert.equal(S.sent.length, 1, "nothing is sent early");
  assert.equal(cultQuotes().length, 1, "the CULT is not sold again");
  assert.equal(S.quotes.filter((q) => q.inputMint === SOL).length, 1, "and the SOL leg isn't priced again either");

  S.height = claimed.swap_lvbh + 151;
  await tick(env, T0 + 120_000);
  assert.equal((await drop()).swap_sig, null, "the SOL swap that never left is cleared");
  assert.equal(S.sent.length, 1);

  await tick(env, T0 + 180_000);
  assert.equal(S.sent.filter(solSwap).length, 1, "the SOL swap is retried once");
  assert.equal(S.sent.filter(cultSwap).length, 1, "the CULT leg stayed done");
  assert.equal(cultQuotes().length, 1);
});
