// Tests for scripts/lib/curve.mjs. Run: node --test scripts/test/
// The sender tests are the crash-and-resume proofs: a signature is saved before anything is sent, an unknown outcome is settled
// only from that signature's status, and nothing is ever sent twice.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, SendTransactionError } from "@solana/web3.js";
import {
  parseArgs, pacedFetch, lamportsOf, parseSecret, b58encode, b58decode, loadKey, Refuse, buildCurve, curvePlan, settle, makeSender, TxFailed, sizeOf, refundIx, sweepIxs, ata, checkUri,
} from "../lib/curve.mjs";

const root = mkdtempSync(join(tmpdir(), "curve-lib-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const dir = () => { const d = join(root, `d${n++}`); mkdirSync(d); return d; };
const refusal = (fn, re) => assert.throws(fn, (e) => e instanceof Refuse && re.test(e.message));

test("parseArgs refuses unknown flags and missing values, so a typo never sends money", () => {
  const spec = { value: ["team-buy", "rpc"], flag: ["go"] };
  assert.deepEqual(parseArgs(["status", "--rpc", "u", "--go"], spec), { args: { rpc: "u", go: true }, pos: ["status"] });
  refusal(() => parseArgs(["--team-bye", "1"], spec), /Unknown option --team-bye/);
  refusal(() => parseArgs(["--team-buy"], spec), /needs a value/);
  refusal(() => parseArgs(["--team-buy", "--go"], spec), /needs a value/);
});

test("lamportsOf is exact integer math and rejects floats, negatives and junk", () => {
  assert.equal(lamportsOf("0.003", "x"), 3_000_000n);
  assert.equal(lamportsOf("30", "x"), 30_000_000_000n);
  assert.equal(lamportsOf("0.000000001", "x"), 1n);
  for (const bad of ["-1", "1e3", "0.0000000001", "abc", "", "1.", ".5"]) refusal(() => lamportsOf(bad, "x"), /amount of SOL/);
});

test("base58 round trips and keys load from JSON arrays, base58 and env without echoing", () => {
  const kp = Keypair.generate();
  assert.deepEqual(b58decode(b58encode(kp.secretKey)), kp.secretKey);
  assert.equal(parseSecret(JSON.stringify([...kp.secretKey])).publicKey.toBase58(), kp.publicKey.toBase58());
  assert.equal(parseSecret(b58encode(kp.secretKey)).publicKey.toBase58(), kp.publicKey.toBase58());
  assert.equal(parseSecret("not a key"), null);
  const f = join(root, "k.json"); writeFileSync(f, JSON.stringify([...kp.secretKey]));
  assert.equal(loadKey({ file: f, label: "keypair" }).publicKey.toBase58(), kp.publicKey.toBase58());
  process.env.CURVE_TEST_KEY = b58encode(kp.secretKey);
  assert.equal(loadKey({ envName: "CURVE_TEST_KEY", label: "keypair" }).publicKey.toBase58(), kp.publicKey.toBase58());
  refusal(() => loadKey({ file: f, envName: "CURVE_TEST_KEY", label: "keypair" }), /Both --keypair and CURVE_TEST_KEY/);
  delete process.env.CURVE_TEST_KEY;
  assert.equal(loadKey({ envName: "CURVE_TEST_KEY", label: "keypair" }), null);
  refusal(() => loadKey({ file: join(root, "missing.json"), label: "keypair" }), /Can't read the key file/);
  const bad = join(root, "bad.json"); writeFileSync(bad, "hello secret-looking text");
  assert.throws(() => loadKey({ file: bad, label: "keypair" }), (e) => e instanceof Refuse && !e.message.includes("secret-looking"));
});

test("the plan equals what the program stored for the mainnet spike's 30 -> 400 SOL curve", () => {
  // Read from chain 16 Nov 2026: config 25yysRWpscFw6RMeTwFL78duEWgnB6oxAbr8mzq17yZZ (spikes/fee-test/dbc.mjs created it).
  const p = curvePlan(buildCurve({ startMcap: 30, gradMcap: 400 }));
  assert.equal(p.thresholdLamports, 85994066487n);
  assert.equal(p.soldTokensRaw, 785014833782499n);
  assert.equal(p.migrationBaseRaw, 214985166217501n);
  // The deposit is scaled down by the 10% fee and the rest of the SOL is booked to the protocol: pinned, not just printed.
  assert.ok(p.poolDepositQuoteLamports < p.thresholdLamports * 92n / 100n && p.poolDepositQuoteLamports > p.thresholdLamports * 88n / 100n);
  assert.equal(p.unusedQuoteBookedToProtocolLamports + p.poolDepositQuoteLamports + p.protocolMigrationFeeQuoteLamports, p.thresholdLamports);
  assert.ok(p.buyersPayAtGraduationLamports > p.thresholdLamports && p.buyersPayAtGraduationLamports < p.thresholdLamports * 1003n / 1000n);
  assert.equal(p.soldTokensRaw + p.migrationBaseRaw, 1_000_000_000_000_000n); // the whole supply is accounted for
});

test("buildCurve refuses nonsense before anything is built", () => {
  refusal(() => buildCurve({ startMcap: 30, gradMcap: 30 }), /above --start-mcap/);
  refusal(() => buildCurve({ startMcap: 0, gradMcap: 5 }), /above --start-mcap/);
  refusal(() => buildCurve({ startMcap: 30, gradMcap: 400, poolFeeBps: 24 }), /--pool-fee-bps/);
  refusal(() => buildCurve({ startMcap: 30, gradMcap: 400, poolFeeBps: 25.5 }), /--pool-fee-bps/);
  refusal(() => buildCurve({ startMcap: 30, gradMcap: 400, tokenAuthority: "anyone" }), /--token-authority/);
});

// ---- settle and the sender, with a fake chain -------------------------------------------------------------------------------
const fakeChain = (statusFor) => {
  const calls = { send: 0, status: 0, height: 0 };
  return {
    calls,
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 }),
    sendRawTransaction: async () => { calls.send++; return "sig"; },
    getSignatureStatuses: async () => { calls.status++; return { value: [statusFor(calls)] }; },
    getBlockHeight: async () => { calls.height++; return 1000; },
  };
};
const noWait = async () => {};

test("settle: landed, failed, expired (only after a second look), and unknown never resolves into a guess", async () => {
  assert.deepEqual(await settle(fakeChain(() => ({ confirmationStatus: "confirmed" })), "s", 100, { wait: noWait }), { status: "landed" });
  assert.deepEqual(await settle(fakeChain(() => ({ confirmationStatus: "finalized" })), "s", 100, { wait: noWait }), { status: "landed" });
  assert.equal((await settle(fakeChain(() => ({ err: { InstructionError: [0, "x"] } })), "s", 100, { wait: noWait })).status, "failed");
  const gone = fakeChain(() => null);
  assert.equal((await settle(gone, "s", 100, { wait: noWait })).status, "expired");
  assert.equal(gone.calls.status, 2, "looked the signature up twice (the second after the block height passed) before calling it expired");
  // Block height not yet past the last valid height: the transaction could still land, so it keeps waiting and never says "expired".
  const young = fakeChain(() => null); young.getBlockHeight = async () => 90;
  await assert.rejects(settle(young, "s", 100, { wait: noWait, timeoutMs: 30 }), /Still can't tell whether s landed/);
  // Seen late: a signature that appears on the second look is landed, not expired.
  let first = true;
  const late = fakeChain(() => (first ? ((first = false), null) : { confirmationStatus: "confirmed" }));
  assert.equal((await settle(late, "s", 100, { wait: noWait })).status, "landed");
});

const ix = (from, to) => SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: 1 });

test("send: the signature is on disk before the transaction is broadcast", async () => {
  const kp = Keypair.generate(), d = dir();
  const conn = fakeChain(() => ({ confirmationStatus: "confirmed" }));
  let seenBeforeSend = null;
  conn.sendRawTransaction = async () => { seenBeforeSend = JSON.parse(readFileSync(join(d, "t.pending.json"), "utf8")); return "x"; };
  const s = makeSender({ conn, dir: d, name: "t", say: () => {}, wait: noWait });
  const r = await s.send("step", [ix(kp.publicKey, Keypair.generate().publicKey)], [kp]);
  assert.equal(seenBeforeSend.sig, r.sig);
  assert.equal(seenBeforeSend.label, "step");
  assert.ok(!existsSync(join(d, "t.pending.json")), "pending file removed once settled");
  assert.match(readFileSync(join(d, "t.log"), "utf8"), new RegExp(`landed step ${r.sig}`));
});

test("crash after signing, before the send: the next run settles from the signature and sends nothing", async () => {
  const kp = Keypair.generate(), d = dir();
  const first = makeSender({ conn: fakeChain(() => null), dir: d, name: "t", say: () => {}, wait: noWait });
  // Simulate the crash: the sender died right after writing the pending file.
  writeFileSync(join(d, "t.pending.json"), JSON.stringify({ label: "step", sig: "SIGSAVED", lastValidBlockHeight: 100 }));
  for (const [status, expect] of [[{ confirmationStatus: "confirmed" }, "landed"], [null, "expired"]]) {
    const conn = fakeChain(() => status);
    const s = makeSender({ conn, dir: d, name: "t", say: () => {}, wait: noWait });
    writeFileSync(join(d, "t.pending.json"), JSON.stringify({ label: "step", sig: "SIGSAVED", lastValidBlockHeight: 100 }));
    const r = await s.resolvePending();
    assert.equal(r.status, expect);
    assert.equal(conn.calls.send, 0, "never resends");
    assert.ok(!existsSync(join(d, "t.pending.json")));
  }
  assert.equal(await first.resolvePending(), null, "nothing pending is a no-op");
});

test("a send resolves an earlier pending signature first, and a landed one is not sent again", async () => {
  const kp = Keypair.generate(), d = dir();
  writeFileSync(join(d, "t.pending.json"), JSON.stringify({ label: "earlier", sig: "OLD", lastValidBlockHeight: 100 }));
  const conn = fakeChain(() => ({ confirmationStatus: "confirmed" }));
  const s = makeSender({ conn, dir: d, name: "t", say: () => {}, wait: noWait });
  await s.send("next", [ix(kp.publicKey, Keypair.generate().publicKey)], [kp]);
  assert.match(readFileSync(join(d, "t.log"), "utf8"), /resolved earlier OLD landed/);
  assert.equal(conn.calls.send, 1, "only the new transaction was sent");
});

test("a network error after broadcast is settled from the signature, never resent", async () => {
  const kp = Keypair.generate(), d = dir();
  const conn = fakeChain(() => ({ confirmationStatus: "confirmed" }));
  conn.sendRawTransaction = async () => { conn.calls.send++; throw new Error("socket hang up"); };
  const s = makeSender({ conn, dir: d, name: "t", say: () => {}, wait: noWait });
  const r = await s.send("step", [ix(kp.publicKey, Keypair.generate().publicKey)], [kp]);
  assert.equal(r.status, "landed");
  assert.equal(conn.calls.send, 1);
});

test("a preflight refusal never reached the network: pending is cleared, nothing is settled, the error says why", async () => {
  const kp = Keypair.generate(), d = dir();
  const conn = fakeChain(() => { throw new Error("must not look up a refused transaction"); });
  conn.sendRawTransaction = async () => { throw new SendTransactionError({ action: "send", signature: "", transactionMessage: "Transaction simulation failed", logs: ["Program log: boom"] }); };
  const s = makeSender({ conn, dir: d, name: "t", say: () => {}, wait: noWait });
  await assert.rejects(s.send("step", [ix(kp.publicKey, Keypair.generate().publicKey)], [kp]), /Refused before sending \(step\)/);
  assert.ok(!existsSync(join(d, "t.pending.json")));
});

test("a transaction that fails on chain throws TxFailed with its signature, and an expired one reports expired", async () => {
  const kp = Keypair.generate();
  const bad = makeSender({ conn: fakeChain(() => ({ err: { InstructionError: [0, "Custom"] } })), dir: dir(), name: "t", say: () => {}, wait: noWait });
  await assert.rejects(bad.send("step", [ix(kp.publicKey, Keypair.generate().publicKey)], [kp]), (e) => e instanceof TxFailed && /failed on chain/.test(e.message) && !!e.sig);
  const exp = makeSender({ conn: fakeChain(() => null), dir: dir(), name: "t", say: () => {}, wait: noWait });
  assert.equal((await exp.send("step", [ix(kp.publicKey, Keypair.generate().publicKey)], [kp])).status, "expired");
});

test("a pending file that can't be read stops everything instead of being guessed at", async () => {
  const d = dir(), kp = Keypair.generate();
  writeFileSync(join(d, "t.pending.json"), "{not json");
  const conn = fakeChain(() => ({ confirmationStatus: "confirmed" }));
  const s = makeSender({ conn, dir: d, name: "t", say: () => {}, wait: noWait });
  await assert.rejects(s.send("step", [ix(kp.publicKey, Keypair.generate().publicKey)], [kp]), /unreadable/);
  assert.equal(conn.calls.send, 0);
});

test("withheld-fee instructions: refund is a self-harvest, sweep never names a holder unless told to", () => {
  const mint = Keypair.generate().publicKey, fee = Keypair.generate().publicKey, acct = Keypair.generate().publicKey, vault = Keypair.generate().publicKey;
  const r = refundIx({ mint, feeWallet: fee, account: acct });
  assert.equal(r.keys[0].pubkey.toBase58(), mint.toBase58());
  assert.equal(r.keys[1].pubkey.toBase58(), acct.toBase58(), "destination is the account itself");
  assert.equal(r.keys[3].pubkey.toBase58(), acct.toBase58(), "and so is the only source");
  const s = sweepIxs({ mint, feeWallet: fee, sources: [vault], fromMint: true });
  assert.equal(s.length, 3, "ATA create, from the mint, from the vault");
  const dest = ata(mint, fee).toBase58();
  assert.equal(s[2].keys[1].pubkey.toBase58(), dest, "everything goes to the fee wallet's own token account");
  assert.ok(sizeOf(s, fee) < 1232);
});

test("checkUri refuses a missing file, non-JSON and a file without name, symbol or image", async () => {
  const realFetch = globalThis.fetch;
  const serve = (map) => { globalThis.fetch = async (url) => { const b = map[url]; return b === undefined ? { ok: false, status: 404, text: async () => "nope" } : { ok: true, status: 200, text: async () => (typeof b === "string" ? b : JSON.stringify(b)) }; }; };
  try {
    serve({}); assert.equal((await checkUri("https://x/t.json")).ok, false);
    serve({ "https://x/t.json": "<html>" }); assert.match((await checkUri("https://x/t.json")).why, /isn't JSON/);
    serve({ "https://x/t.json": { name: "Cult", symbol: "CULT" } }); assert.match((await checkUri("https://x/t.json")).why, /no image/);
    serve({ "https://x/t.json": { name: "Cult", symbol: "CULT", image: "https://x/i.png" } }); assert.match((await checkUri("https://x/t.json")).why, /image .* answers 404/);
    serve({ "https://x/t.json": { name: "Cult", symbol: "CULT", image: "https://x/i.png" }, "https://x/i.png": "png" }); assert.equal((await checkUri("https://x/t.json")).ok, true);
  } finally { globalThis.fetch = realFetch; }
});

test("pacedFetch retries 429 and network errors with backoff, gives up after the last try, and passes other statuses through", async () => {
  const waits = [];
  const wait = async (ms) => { waits.push(ms); };
  const seq = (...r) => { let i = 0; return async () => { const x = r[i++]; if (x instanceof Error) throw x; return x; }; };
  const ok = { status: 200 }, limited = { status: 429 };
  assert.equal(await pacedFetch({ fetchFn: seq(limited, limited, ok), wait, gapMs: 0 })("u"), ok);
  assert.deepEqual(waits.filter((w) => w > 0), [1000, 2000]);
  assert.equal(await pacedFetch({ fetchFn: seq(new Error("reset"), ok), wait, gapMs: 0 })("u"), ok);
  assert.equal((await pacedFetch({ fetchFn: seq({ status: 400 }), wait, gapMs: 0 })("u")).status, 400, "a 4xx other than 429 is the caller's to handle");
  await assert.rejects(pacedFetch({ fetchFn: seq(new Error("a"), new Error("b"), new Error("c")), wait, gapMs: 0, tries: 3 })("u"), /c/);
  assert.equal((await pacedFetch({ fetchFn: seq(limited, limited), wait, gapMs: 0, tries: 2 })("u")).status, 429, "the last 429 is returned, not retried forever");
});
