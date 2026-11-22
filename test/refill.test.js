// The SOL refill on a USDC-quoted curve (src/indexer.js refillLeg and refillMicro): nothing else refills the payout wallet's SOL once the
// curve's fees arrive as USDC, so a round that finds the wallet under REFILL_BELOW_SOL sells USDC for SOL after the CULT leg and before
// allocate. When it fires and how big, every skip, a crash at each step, a failed swap, two runs at once, and a refusal that must never
// hold the holders' payout. Same local-D1 + fake-chain harness as round.test.js (test/engine-fakes.js); the Jupiter-side checks of a
// USDC -> SOL swap are in refill-jupiter.test.js. Each test names the settings it relies on: it does not read the deploy file's values.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { createTransferInstruction } from "@solana/spl-token";
import { tick, refillMicro } from "../src/indexer.js";
import { usdcAta } from "../src/chain.js";
import { treasuryAta } from "../src/token22.js";
import { config, USDC_MINT } from "../src/config.js";
import { addr, SOL } from "./fakes.js";
import { TOK, makeVault, CLEAR, boot, freshS, isSwap, touches, installFakes, fastTimers } from "./engine-fakes.js";

const PERSIST = ".wrangler/refill-test";
const realSetTimeout = globalThis.setTimeout;
const kp = Keypair.generate();
const MINT = addr(), PAYOUT = kp.publicKey.toBase58(), VAULT = makeVault();
const TREASURY = treasuryAta(MINT, PAYOUT).toBase58();
const PERIOD = 10 * 60_000;
const T0 = Math.floor(Date.now() / PERIOD) * PERIOD + 30_000;
const LOW = 100_000_000; // 0.1 SOL: under the 0.3 threshold

let proxy, env, envU, envS, S, restoreFetch, restoreTimers;
before(async () => {
  restoreTimers = fastTimers();
  ({ proxy, env } = await boot(PERSIST, { MINT, PAYOUT, kp, MAX_SWAP_IMPACT_BPS: "300", MIN_SWAP_USD: "1" }));
  envU = { ...env, QUOTE_MINT: USDC_MINT, REFILL_BELOW_SOL: "0.3", REFILL_TO_SOL: "0.6", REFILL_MAX_USD: "50" };
  envS = { ...envU, QUOTE_MINT: "" };
  restoreFetch = installFakes({ S: () => S, MINT, PAYOUT, env: () => env });
});
after(async () => { await proxy?.dispose(); restoreFetch?.(); restoreTimers?.(); });
beforeEach(async () => {
  S = freshS({ PAYOUT, vault: VAULT });
  S.sol = LOW;
  S.usdc = 200_000_000n; // $200 in the wallet
  // What a quote of `amount` micro-USDC pays in lamports at the SOL price: micro x 1000 / USD per SOL. CULT -> USDC pays $5.
  S.swapOut = (amount, input) => (input === USDC_MINT ? (amount * 1000n) / BigInt(S.solUsd) : 5_000_000n);
  await env.DB.batch(CLEAR.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

const holder = (tokens) => {
  const w = addr();
  S.balances.set(w, BigInt(tokens) * TOK);
  S.atas.add(usdcAta(w, env).toBase58());
  return w;
};
const threeHolders = () => [holder(100_000), holder(200_000), holder(300_000)];
const first = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const drop = () => first("SELECT * FROM drops");
const refillSwap = (x) => isSwap(x) && !touches(x, TREASURY); // in a USDC round the CULT leg touches the treasury's account, the refill does not
const cultSwap = (x) => isSwap(x) && touches(x, TREASURY);
const refills = () => S.sent.filter(refillSwap);
const swaps = () => S.sent.filter(isSwap); // S.sent also holds the payout batches once a round reaches paying
const usdcQuotes = () => S.quotes.filter((q) => q.inputMint === USDC_MINT);
const quiet = async (f) => { const log = console.error; console.error = () => {}; try { return await f(); } finally { console.error = log; } };
const jsonIx = (ix) => ({ programId: ix.programId.toBase58(), accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data).toString("base64") });

/* ---------------- the settings and the sizing rule ---------------- */

test("config: REFILL_BELOW_SOL 0.3, REFILL_TO_SOL 0.6 and REFILL_MAX_USD 50 by default, set in SOL and USD, and a value that makes no sense falls back", () => {
  const c = config({});
  assert.deepEqual([c.refillBelow, c.refillTo, c.refillMaxUsd], [300_000_000, 600_000_000, 50]);
  const o = config({ REFILL_BELOW_SOL: "0.25", REFILL_TO_SOL: "1.5", REFILL_MAX_USD: "20" });
  assert.deepEqual([o.refillBelow, o.refillTo, o.refillMaxUsd], [250_000_000, 1_500_000_000, 20]);
  const bad = config({ REFILL_BELOW_SOL: "lots", REFILL_TO_SOL: "-1", REFILL_MAX_USD: "" });
  assert.deepEqual([bad.refillBelow, bad.refillTo, bad.refillMaxUsd], [300_000_000, 600_000_000, 50]);
});

test("refillMicro: the USD that brings SOL to the target at the price plus 3%, capped by REFILL_MAX_USD and half the USDC, nothing under the minimum or at/above the threshold", () => {
  const cfg = config({ REFILL_BELOW_SOL: "0.3", REFILL_TO_SOL: "0.6", REFILL_MAX_USD: "50", MIN_SWAP_USD: "1" });
  // 0.25 SOL to 0.6 SOL is 0.35 SOL = $35 at $100, plus 3% = $36.05
  assert.equal(refillMicro(cfg, 250_000_000, 200_000_000, 100), 36_050_000);
  assert.equal(refillMicro(cfg, 250_000_000, 200_000_000, 200), 50_000_000, "$72.10 wanted: the $50 cap");
  assert.equal(refillMicro(cfg, 250_000_000, 60_000_000, 100), 30_000_000, "half of $60");
  assert.equal(refillMicro(cfg, 250_000_000, 60_000_001, 100), 30_000_000, "half rounds down");
  assert.equal(refillMicro(cfg, 299_999_999, 200_000_000, 100), 30_900_001, "one lamport under the threshold still refills: 0.300000001 SOL x $100 x 1.03, rounded up");
  assert.equal(refillMicro(cfg, 300_000_000, 200_000_000, 100), 0, "at the threshold: nothing");
  assert.equal(refillMicro(cfg, 900_000_000, 200_000_000, 100), 0, "above it: nothing");
  assert.equal(refillMicro(cfg, 250_000_000, 2_000_000, 100), 1_000_000, "half of $2 is exactly the $1 minimum");
  assert.equal(refillMicro(cfg, 250_000_000, 1_999_999, 100), 0, "under it: nothing");
  assert.equal(refillMicro(cfg, 250_000_000, 0, 100), 0, "no USDC");
  assert.equal(refillMicro(cfg, 250_000_000, 200_000_000, 0), 0, "no price: refuse, don't guess");
  assert.equal(refillMicro(cfg, 250_000_000, 200_000_000, NaN), 0);
  assert.equal(refillMicro({ ...cfg, refillMaxUsd: 0 }, 250_000_000, 200_000_000, 100), 0, "REFILL_MAX_USD 0 turns it off");
  assert.equal(refillMicro({ ...cfg, refillTo: 200_000_000, minSwapUsd: 0 }, 250_000_000, 200_000_000, 100), 0, "a target under the balance asks for nothing, even with no minimum");
});

/* ---------------- when it fires, and how much ---------------- */

test("SOL under the threshold: after the CULT leg and before allocate one USDC -> SOL swap sized to the target, its signature and last valid height in D1 before it is sent", async () => {
  threeHolders();
  S.sol = 250_000_000; S.solUsd = 100; S.cult = 5_000n * TOK; // $5 of CULT sells first, so it is in the USDC the refill is sized from
  let atSend = null;
  S.onSend = async (tx, sig) => { if (refillSwap({ tx })) { const d = await drop(); atSend = { sig, saved: d.refill_sig, lvbh: d.refill_lvbh, usdc: d.refill_usdc, lamports: d.refill_lamports, status: d.status }; } };
  const r = await tick(envU, T0);
  assert.equal(r.status, "paying", JSON.stringify(r));
  const swaps = S.sent.filter(isSwap);
  assert.equal(swaps.length, 2);
  assert.ok(cultSwap(swaps[0]) && refillSwap(swaps[1]), "the CULT leg first, then the refill");
  assert.deepEqual(usdcQuotes().map((q) => q.amount), ["36050000"], "0.35 SOL to the target at $100 a SOL plus 3%");
  assert.deepEqual(atSend && [atSend.saved === atSend.sig, atSend.lvbh, atSend.usdc, atSend.lamports, atSend.status], [true, 1150, 36_050_000, 360_500_000, "swap"], "all of it was in D1 when the transaction left");
  assert.ok(S.sol >= 600_000_000 && S.sol <= 620_000_000, `SOL went from 0.25 to the 0.6 target: ${S.sol}`);
  const d = await drop();
  assert.equal(d.refill_sig, swaps[1].sig);
  assert.equal(S.usdc, 200_000_000n + 5_000_000n - 36_050_000n);
  assert.ok(d.usdc_micro > 168_900_000 && d.usdc_micro <= 168_950_000, `allocate pays what is left, not the $205 the wallet held before the refill: ${d.usdc_micro}`);
});

test("REFILL_MAX_USD caps one refill, and so does half of the wallet's USDC (holders must still be paid)", async () => {
  threeHolders();
  S.sol = LOW; // wants 0.5 SOL = $100 plus 3% at $200
  await tick(envU, T0);
  assert.deepEqual(usdcQuotes().map((q) => q.amount), ["50000000"], "the $50 default cap");

  await env.DB.batch(CLEAR.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  S.quotes.length = 0; S.sent.length = 0; S.sol = LOW; S.usdc = 200_000_000n;
  await tick({ ...envU, REFILL_MAX_USD: "20" }, T0);
  assert.deepEqual(usdcQuotes().map((q) => q.amount), ["20000000"], "a lower cap from the setting");

  await env.DB.batch(CLEAR.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  S.quotes.length = 0; S.sent.length = 0; S.sol = LOW; S.usdc = 30_000_000n;
  await tick(envU, T0);
  assert.deepEqual(usdcQuotes().map((q) => q.amount), ["15000000"], "half of $30");
  assert.equal(S.usdc, 15_000_000n);
  const d = await drop();
  assert.ok(d.usdc_micro > 14_990_000 && d.usdc_micro <= 15_000_000, `the holders get the other half: ${d.usdc_micro}`);
});

test("the threshold is exclusive: SOL at 0.3 does nothing (and is marked 'none'), a lamport under it refills", async () => {
  threeHolders();
  S.sol = 300_000_000;
  const r = await tick(envU, T0);
  assert.equal(r.status, "paying", JSON.stringify(r));
  assert.equal((await drop()).refill_sig, "none");
  assert.equal(usdcQuotes().length, 0, "not even priced");
  assert.equal(swaps().length, 0);

  await env.DB.batch(CLEAR.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  S.sol = 299_999_999;
  await tick(envU, T0);
  assert.equal(refills().length, 1);
});

/* ---------------- when it does nothing ---------------- */

test("a SOL-quoted curve never refills: the SOL leg runs as it always did and refill_sig stays empty", async () => {
  threeHolders();
  S.cult = 5_000n * TOK;
  const r = await tick(envS, T0);
  assert.equal(r.status, "paying", JSON.stringify(r));
  assert.equal(usdcQuotes().length, 0);
  const d = await drop();
  assert.equal(d.refill_sig, null);
  assert.ok(d.swap_sig && d.swap_sig !== "none", "the spare SOL was sold to USDC, as with any SOL curve");
});

test("DRY_RUN signs and sends nothing and marks the leg 'dry-run'; SWAP=off marks it 'none'", async () => {
  threeHolders();
  const r = await tick({ ...envU, DRY_RUN: "1" }, T0);
  assert.equal(r.status, "done", JSON.stringify(r));
  assert.equal(S.sent.length, 0);
  assert.equal(usdcQuotes().length, 0);
  const d = await drop();
  assert.deepEqual([d.refill_sig, d.swap_sig], ["dry-run", "dry-run"]);

  await env.DB.batch(CLEAR.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await tick({ ...envU, SWAP: "off" }, T0);
  assert.equal((await drop()).refill_sig, "none");
  assert.equal(S.quotes.length, 0);
  assert.equal(S.sent.filter(isSwap).length, 0);
});

test("under MIN_SWAP_USD after the caps nothing is sent: $1.50 in the wallet is $0.75 spendable; $2 is exactly the $1 minimum", async () => {
  threeHolders();
  S.usdc = 1_500_000n;
  await tick(envU, T0);
  assert.equal((await drop()).refill_sig, "none");
  assert.equal(usdcQuotes().length, 0);
  assert.equal(swaps().length, 0);

  await env.DB.batch(CLEAR.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  S.usdc = 2_000_000n;
  await tick(envU, T0);
  assert.deepEqual(usdcQuotes().map((q) => q.amount), ["1000000"]);

  await env.DB.batch(CLEAR.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  S.quotes.length = 0; S.sent.length = 0; S.usdc = 200_000_000n; S.sol = LOW;
  await tick({ ...envU, MIN_SWAP_USD: "60" }, T0); // $50 cap < $60 minimum
  assert.equal((await drop()).refill_sig, "none");
  assert.equal(usdcQuotes().length, 0);
});

test("a wallet with no USDC account, or REFILL_MAX_USD 0, sells nothing", async () => {
  threeHolders();
  S.usdcExists = false;
  await tick(envU, T0);
  assert.equal((await drop()).refill_sig, "none");
  assert.equal(usdcQuotes().length, 0);

  await env.DB.batch(CLEAR.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  S.usdcExists = true;
  await tick({ ...envU, REFILL_MAX_USD: "0" }, T0);
  assert.equal((await drop()).refill_sig, "none");
  assert.equal(usdcQuotes().length, 0);
});

/* ---------------- a crash at each step never sends it twice ---------------- */

test("a refill saved but never sent (the process died): not sent early, not priced again, cleared only once surely gone, then tried once more", async () => {
  threeHolders();
  let crash = true;
  S.onSend = (tx) => { if (crash && refillSwap({ tx })) { crash = false; throw new Error("the process died before the send"); } };
  const r1 = await tick(envU, T0);
  assert.ok(r1.error, JSON.stringify(r1));
  const claimed = await drop();
  assert.ok(claimed.refill_sig && !["none", "refused", "dry-run"].includes(claimed.refill_sig) && claimed.refill_lvbh === 1150, "the signature was saved before the send");
  assert.equal(S.sent.length, 0, "and it never went out");

  await tick(envU, T0 + 60_000);
  assert.equal(S.sent.length, 0, "inside the blockhash's life nothing is sent: it could still be out there");
  assert.equal(usdcQuotes().length, 1, "and no second swap is priced");
  assert.equal((await drop()).refill_sig, claimed.refill_sig);

  S.height = claimed.refill_lvbh + 150; // the edge of the margin
  await tick(envU, T0 + 120_000);
  assert.equal((await drop()).refill_sig, claimed.refill_sig, "still inside the margin");

  S.height = claimed.refill_lvbh + 151; // past it, and the chain has never seen it
  await tick(envU, T0 + 180_000);
  const cleared = await drop();
  assert.deepEqual([cleared.refill_sig, cleared.refill_lvbh, cleared.refill_usdc, cleared.refill_lamports], [null, null, null, null]);
  assert.match(cleared.error, /SOL refill didn't land/);
  assert.equal(S.sent.length, 0, "clearing sends nothing");

  await tick(envU, T0 + 240_000);
  assert.equal(refills().length, 1, "the next tick sends it once");
  for (let i = 0; i < 6; i++) await tick(envU, T0 + 300_000 + i * 1000);
  assert.equal(refills().length, 1, "later ticks never send it again");
  assert.equal(usdcQuotes().length, 2, "the lost one and the retry");
});

test("a refill that was sent but is not confirmed yet holds the round at the swap: no second decision even while the wallet still shows low SOL, no second send", async () => {
  threeHolders();
  S.status = () => ({ confirmationStatus: "processed", err: null }); // in a block, not confirmed
  const r1 = await tick(envU, T0);
  assert.equal(r1.status, "swap", JSON.stringify(r1));
  assert.equal(refills().length, 1);
  const sig = (await drop()).refill_sig;
  S.sol = LOW; // a stale read: the landing is not visible yet
  for (let i = 1; i <= 4; i++) assert.equal((await tick(envU, T0 + i * 1000)).status, "swap");
  assert.equal(refills().length, 1, "nothing more is sent");
  assert.equal(usdcQuotes().length, 1, "or priced");
  assert.equal((await drop()).refill_sig, sig);

  S.status = () => ({ confirmationStatus: "confirmed", err: null });
  const r6 = await tick(envU, T0 + 10_000);
  assert.equal(r6.status, "paying", JSON.stringify(r6));
  assert.equal(refills().length, 1);
});

test("a refill that lands with an error is cleared and sent again next tick, once, and the round pays after the second one", async () => {
  threeHolders();
  let failSig = null, out = 0n;
  S.onSend = (tx, sig) => { if (refillSwap({ tx }) && !failSig) { failSig = sig; out = S.lastSwapOut; } };
  S.status = (sig) => (sig === failSig ? { confirmationStatus: "confirmed", err: { InstructionError: [2, "Custom"] } } : { confirmationStatus: "confirmed", err: null });
  const r1 = await tick(envU, T0);
  assert.equal(r1.status, "swap", JSON.stringify(r1));
  assert.equal((await drop()).refill_sig, failSig);
  S.usdc += 50_000_000n; S.sol -= Number(out); // a failed transaction changed nothing (the fake applies a send at once)

  const r2 = await tick(envU, T0 + 1000);
  assert.equal(r2.status, "swap");
  const cleared = await drop();
  assert.equal(cleared.refill_sig, null);
  assert.match(cleared.error, /SOL refill didn't land/);
  assert.equal(refills().length, 1, "clearing sends nothing");

  const r3 = await tick(envU, T0 + 2000);
  assert.equal(r3.status, "paying", JSON.stringify(r3));
  assert.equal(refills().length, 2);
  const d = await drop();
  assert.ok(d.refill_sig && d.refill_sig !== failSig);
  assert.equal(refills()[1].sig, d.refill_sig);
  for (let i = 0; i < 4; i++) await tick(envU, T0 + 3000 + i * 1000);
  assert.equal(refills().length, 2, "and never a third");
});

// A run that stalls while it builds its refill (the lock defeated, as in round.test.js): only the run that saved its signature first may send.
test("a refill another run already claimed is not sent a second time", async () => {
  threeHolders();
  const realUUID = crypto.randomUUID;
  let n = 0;
  Object.defineProperty(crypto, "randomUUID", { value: () => `tok-${++n}`, configurable: true, writable: true });
  try {
    let release, stalled = false;
    const gate = new Promise((r) => (release = r));
    S.onSwap = async () => { if (!stalled) { stalled = true; await gate; } };
    const a = tick(envU, T0); // "tok-1": stalls while building its refill
    for (let i = 0; !stalled && i < 250; i++) await new Promise((r) => realSetTimeout(r, 20)); // bounded: a run that never builds a swap must fail the test, not hang it
    assert.ok(stalled, "the first run got as far as building the refill");
    await env.DB.prepare("DELETE FROM kv WHERE k = 'lock'").run();
    await tick(envU, T0 + 1000); // "tok-2": builds, claims and sends it
    assert.equal(refills().length, 1);
    await env.DB.prepare("INSERT INTO kv (k, v, at) VALUES ('lock', ?, ?)").bind(JSON.stringify("tok-1"), Date.now() + 15 * 60_000).run();
    release();
    await a;
  } finally { Object.defineProperty(crypto, "randomUUID", { value: realUUID, configurable: true, writable: true }); }
  assert.equal(refills().length, 1, "the second swap was built but never sent");
  assert.equal(usdcQuotes().length, 2, "both runs priced it");
});

// The other order: the run that claimed first dies at the send, so the round is still at the swap when the stalled run comes back.
test("a run that built its refill after another had saved its signature (and died before sending) neither overwrites that signature nor sends", async () => {
  threeHolders();
  const realUUID = crypto.randomUUID;
  let n = 0;
  Object.defineProperty(crypto, "randomUUID", { value: () => `tok-${++n}`, configurable: true, writable: true });
  try {
    let release, stalled = false;
    const gate = new Promise((r) => (release = r));
    S.onSwap = async () => { if (!stalled) { stalled = true; await gate; } };
    const a = tick(envU, T0); // "tok-1": stalls while building its refill
    for (let i = 0; !stalled && i < 250; i++) await new Promise((r) => realSetTimeout(r, 20));
    assert.ok(stalled, "the first run got as far as building the refill");
    await env.DB.prepare("DELETE FROM kv WHERE k = 'lock'").run();
    S.onSend = (tx) => { if (refillSwap({ tx })) throw new Error("the process died before the send"); };
    const b = await tick(envU, T0 + 1000); // "tok-2": claims the refill (signature saved) and dies at the send
    assert.ok(b.error, JSON.stringify(b));
    const saved = (await drop()).refill_sig;
    assert.ok(saved && !["none", "refused"].includes(saved));
    S.onSend = null;
    await env.DB.prepare("INSERT INTO kv (k, v, at) VALUES ('lock', ?, ?)").bind(JSON.stringify("tok-1"), Date.now() + 15 * 60_000).run();
    release();
    await a;
    assert.equal((await drop()).refill_sig, saved, "the first claim stands");
  } finally { Object.defineProperty(crypto, "randomUUID", { value: realUUID, configurable: true, writable: true }); }
  assert.equal(refills().length, 0, "the late run sends nothing: the transaction it built is not the one on record");
});

/* ---------------- a refusal skips the refill and never holds the payout ---------------- */

const stolen = addr();
const refusals = [
  ["Jupiter's swap with a System transfer to another wallet", () => { S.instructionsHook = (a) => a.setupInstructions.push(jsonIx(SystemProgram.transfer({ fromPubkey: new PublicKey(PAYOUT), toPubkey: new PublicKey(stolen), lamports: 1_000_000 }))); }, /refused \(system transfer\)/],
  ["Jupiter's swap with a second signer", () => { S.instructionsHook = (a) => a.swapInstruction.accounts.push({ pubkey: addr(), isSigner: true, isWritable: false }); }, /refused \(another signer\)/],
  ["Jupiter's swap with a USDC transfer out of the wallet", () => { S.instructionsHook = (a) => a.setupInstructions.push(jsonIx(createTransferInstruction(usdcAta(PAYOUT, env), new PublicKey(stolen), new PublicKey(PAYOUT), 1n))); }, /refused \(token instruction\)/],
  ["a simulation that pays out less SOL than the quote's minimum", () => { S.simShort = 100_000_000n; }, /refused \(the swap would pay out less than its quote\)/],
  ["a simulation that takes more USDC than was sold", () => { S.simTake = 1n; }, /refused \(the swap would take more than it should\)/],
  ["a simulation that moves the treasury's CULT", () => { S.cult = 500n * TOK; S.simOther = 1n; /* $0.50: under MIN_SWAP_USD, so it stays in the treasury */ }, /refused \(the swap would take another token\)/],
  ["a simulation that fails", () => { S.simErr = { InstructionError: [2, "Custom"] }; }, /refused \(the swap fails in simulation\)/],
  ["a quote far below the SOL price", () => { S.swapOut = (amount, input) => (input === USDC_MINT ? (amount * 1000n) / BigInt(S.solUsd) / 2n : 5_000_000n); }, /far below the SOL price/],
];
for (const [name, setup, match] of refusals) {
  test(`refill refused for ${name}: nothing is sent, the reason is on the round, and the holders are still paid`, async () => {
    threeHolders();
    setup();
    const r = await quiet(() => tick(envU, T0));
    assert.equal(r.status, "paying", JSON.stringify(r));
    assert.equal(swaps().length, 0, "no swap was sent");
    const d = await drop();
    assert.equal(d.refill_sig, "refused");
    assert.match(d.error, /^SOL refill skipped: /);
    assert.match(d.error, match);
    assert.equal(d.refill_usdc, null);
    assert.ok(d.usdc_micro >= 199_990_000, `the whole $200 goes to the holders: ${d.usdc_micro}`);
  });
}

test("no SOL price: the refill is skipped as 'refused' and nothing is sent (the round then waits for a price at allocate, as it always did)", async () => {
  threeHolders();
  S.solUsd = 0;
  const r = await quiet(() => tick(envU, T0));
  assert.match(r.error, /No SOL price yet/);
  assert.equal(S.sent.length, 0);
  assert.equal(usdcQuotes().length, 0);
  const d = await drop();
  assert.equal(d.refill_sig, "refused");
  assert.equal(d.status, "allocate");
});

test("a round back at the swap step after the leg was marked 'none', 'refused' or 'dry-run' (a crash before the step moved on) does not decide again", async () => {
  threeHolders();
  for (const mark of ["none", "refused", "dry-run"]) {
    await env.DB.batch(CLEAR.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    S.quotes.length = 0; S.sent.length = 0; S.sol = LOW; S.usdc = 200_000_000n;
    const n = Math.floor(T0 / PERIOD);
    await env.DB.prepare("INSERT INTO drops (n, at, status, cult_sig, refill_sig, updated) VALUES (?, ?, 'swap', 'none', ?, ?)").bind(n, n * PERIOD, mark, T0).run();
    await env.DB.prepare("INSERT INTO payouts (drop_n, wallet, weight) SELECT ?, ?, 1").bind(n, [...S.balances.keys()][2]).run();
    const r = await tick(envU, T0);
    assert.notEqual(r.status, "swap", `${mark}: ${JSON.stringify(r)}`);
    assert.equal(S.quotes.length, 0, `${mark}: not priced`);
    assert.equal(S.sent.filter(isSwap).length, 0, `${mark}: nothing sold`);
    assert.equal((await drop()).refill_sig, mark);
  }
});

/* ---------------- the table the watcher reads ---------------- */

test("migration 0009 adds its columns to a drops table made by 0001: old rows keep their values and read NULL", async () => {
  const text = (f) => readFileSync(`migrations/${f}`, "utf8").replace(/\r/g, "").replace(/--.*$/gm, "");
  const old = (sql) => sql.replace(/\bdrops\b/g, "drops_old");
  const oneLine = (sql) => sql.replace(/\s+/g, " ").trim();
  try {
    await env.DB.exec(oneLine(old(/CREATE TABLE drops \([\s\S]*?\n\);/.exec(text("0001_init.sql"))[0])));
    await env.DB.prepare("INSERT INTO drops_old (n, at, status, fee_lamports, updated) VALUES (1, 1, 'done', 300000000, 1)").run();
    const stmts = text("0009_sol_refill.sql").split(";").map((s) => s.trim()).filter((s) => /^ALTER TABLE/.test(s)).map(old);
    assert.equal(stmts.length, 4);
    for (const s of stmts) await env.DB.exec(oneLine(s));
    assert.deepEqual(await first("SELECT status, fee_lamports, refill_sig, refill_lvbh, refill_usdc, refill_lamports FROM drops_old WHERE n = 1"), { status: "done", fee_lamports: 300_000_000, refill_sig: null, refill_lvbh: null, refill_usdc: null, refill_lamports: null });
  } finally { await env.DB.exec("DROP TABLE IF EXISTS drops_old"); }
});
