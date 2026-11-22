// --quote usdc in the curve scripts: the curve is quoted in USDC (6 decimals, classic SPL Token) and its market caps and graduation
// threshold are in dollars. The numbers below were computed by the SDK's own curve builder for the real $CULT targets (start $1,935,
// graduation $28,400); the SOL default is pinned by curve-lib.test.mjs, rules.test.mjs and verify-launch.test.mjs, which are unchanged.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { launchProblems, configMismatches, optsFromArgs as launchOpts } from "../launch-curve.mjs";
import { launchChecks, wantConfig, optsFromArgs as verifyOpts } from "../verify-launch.mjs";
import * as reh from "../rehearse-curve.mjs";
import { SOL_MINT, USDC_MINT, QUOTES, FEE_WALLET, Refuse, buildCurve, curvePlan, money, quoteOf, mcapsOf, makeSender } from "../lib/curve.mjs";

const root = mkdtempSync(join(tmpdir(), "usdc-quote-"));
after(() => rmSync(root, { recursive: true, force: true }));
const pk = () => Keypair.generate().publicKey;
const refusal = (f, re) => assert.throws(f, (e) => e instanceof Refuse && re.test(e.message), String(re));
const fee = new PublicKey(FEE_WALLET);
const REAL = { startMcap: 1935, gradMcap: 28400, poolFeeBps: 25 };

/* ---------- the quote tokens and the plan ---------- */

test("the quote tokens: SOL (9 decimals) and USDC (the classic mint, 6 decimals), and nothing else, not even an object's own property names", () => {
  assert.deepEqual([QUOTES.sol.mint.toBase58(), QUOTES.sol.decimals, QUOTES.sol.sym], ["So11111111111111111111111111111111111111112", 9, "SOL"]);
  assert.deepEqual([QUOTES.usdc.mint.toBase58(), QUOTES.usdc.decimals, QUOTES.usdc.sym], ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 6, "USDC"]);
  assert.equal(USDC_MINT.toBase58(), QUOTES.usdc.mint.toBase58());
  assert.equal(quoteOf().sym, "SOL", "no --quote is SOL");
  for (const bad of ["eth", "USDC", "", "constructor", "__proto__", "toString"]) refusal(() => quoteOf(bad), /--quote is sol or usdc/);
});

test("the USDC curve for the real targets: $1,935 start, $28,400 graduation, 5,878.63 USDC to raise, all in USDC micro (6 decimals)", () => {
  const cfg = buildCurve({ ...REAL, quote: "usdc" }), p = curvePlan(cfg, { poolFeeBps: 25, quote: "usdc" });
  assert.equal(p.thresholdLamports, 5_878_629_931n, "raw USDC: 5,878.63, not 5,878,629 (9 decimals would say a thousand times more)");
  assert.equal(money(p.thresholdLamports, "usdc"), "5878.63 USDC");
  assert.equal(BigInt(cfg.sqrtStartPrice.toString()), 25_660_210_050_285_991n);
  assert.ok(Math.abs(p.startPriceSol * 1e9 - 1935) < 1e-3, `a billion coins at ${p.startPriceSol} USDC each: ${p.startPriceSol * 1e9}`);
  assert.ok(Math.abs(p.graduationPriceSol * 1e9 - 28_400) < 1e-3, `${p.graduationPriceSol * 1e9}`);
  assert.equal(p.soldTokensRaw, 793_005_988_345_070n);
  assert.equal(p.soldTokensRaw + p.migrationBaseRaw, 1_000_000_000_000_000n, "the whole supply is accounted for");
  assert.equal(p.unusedQuoteBookedToProtocolLamports + p.poolDepositQuoteLamports + p.protocolMigrationFeeQuoteLamports, p.thresholdLamports);
  assert.ok(p.poolDepositQuoteLamports < p.thresholdLamports * 92n / 100n && p.poolDepositQuoteLamports > p.thresholdLamports * 88n / 100n, "the 10% scale-down, as in SOL");
  assert.ok(p.buyersPayAtGraduationLamports > p.thresholdLamports && p.buyersPayAtGraduationLamports < p.thresholdLamports * 1003n / 1000n);
  // The same dollars in SOL at $69.22 (the price these targets were set at): about the same money to raise.
  const sol = curvePlan(buildCurve({ startMcap: 27.96, gradMcap: 410.8 }), { poolFeeBps: 25 });
  assert.equal(sol.thresholdLamports, 84_997_752_448n);
  assert.ok(Math.abs((Number(sol.thresholdLamports) / 1e9) * 69.22 / (Number(p.thresholdLamports) / 1e6) - 1) < 0.002);
  assert.equal(curvePlan(buildCurve({ startMcap: 27.96, gradMcap: 410.8, quote: "sol" }), { quote: "sol" }).thresholdLamports, sol.thresholdLamports, "naming sol is the default");
});

test("money(): USDC micro as dollars, SOL as before", () => {
  assert.equal(money(5_878_629_931n, "usdc"), "5878.63 USDC");
  assert.equal(money(84_997_752_448n), "84.997752 SOL");
  assert.equal(money(84_997_752_448n, "sol"), "84.997752 SOL");
});

test("--start-mcap and --grad-mcap: the SOL defaults for SOL; a USDC curve must name both (27.96 USDC would be a $28 coin)", () => {
  const D = { startMcap: 27.96, gradMcap: 410.8 };
  assert.deepEqual(mcapsOf({}, "sol", D), D);
  assert.deepEqual(mcapsOf({ "start-mcap": "30" }, "sol", D), { startMcap: 30, gradMcap: 410.8 });
  refusal(() => mcapsOf({}, "usdc", D), /With --quote usdc give both --start-mcap and --grad-mcap in USDC/);
  refusal(() => mcapsOf({ "start-mcap": "1935" }, "usdc", D), /give both/);
  refusal(() => mcapsOf({ "grad-mcap": "28400" }, "usdc", D), /give both/);
  assert.deepEqual(mcapsOf({ "start-mcap": "1935", "grad-mcap": "28400" }, "usdc", D), { startMcap: 1935, gradMcap: 28400 });
  refusal(() => mcapsOf({ "start-mcap": "-1", "grad-mcap": "28400" }, "usdc", D), /--start-mcap must be a number above 0/);
});

/* ---------- the config read-back: configMismatches checks the quote mint ---------- */

const cfgOf = (quote, curve = REAL) => { const cfg = buildCurve({ ...curve, quote }), plan = curvePlan(cfg, { poolFeeBps: curve.poolFeeBps, quote }); return { cfg, plan }; };
const wantOf = (quote, curve = REAL) => { const { cfg, plan } = cfgOf(quote, curve); return { feeWallet: fee, poolFeeBps: 25, tokenAuthorityCode: 1, thresholdLamports: plan.thresholdLamports, sqrtStartPrice: BigInt(cfg.sqrtStartPrice.toString()), quote }; };
// A config exactly as the design needs it, quoted in `mint` (the shape rules.test.mjs feeds the same function).
const onChain = (want, mint) => ({
  quoteMint: mint, feeClaimer: fee, leftoverReceiver: fee, tokenType: 1, tokenDecimal: 6, transferFeeFlag: 1, transferFeeBasisPoints: 1000, transferFeeWithheldAuthority: 0,
  migratedTransferFeeAuthorityOption: 0, fixedTokenSupplyFlag: 1, migrationOption: 1, migrationFeeOption: 6, migratedCollectFeeMode: 2, migratedCompoundingFeeBps: 0, migratedPoolFeeBps: 25,
  partnerPermanentLockedLiquidityPercentage: 100, creatorTradingFeePercentage: 0, migrationFeePercentage: 0, tokenUpdateAuthority: want.tokenAuthorityCode, migrationQuoteThreshold: want.thresholdLamports,
  sqrtStartPrice: want.sqrtStartPrice, preMigrationTokenSupply: 10n ** 15n, postMigrationTokenSupply: 10n ** 15n,
});

test("configMismatches: a USDC config passes a USDC want; a SOL-quoted config, another token, or a USDC config against a SOL want, fails on the quote mint", () => {
  const w = wantOf("usdc");
  assert.deepEqual(configMismatches(onChain(w, USDC_MINT), w), []);
  const q = (mint, want = w) => configMismatches(onChain(w, mint), want);
  assert.deepEqual(q(SOL_MINT), [`config quoteMint is ${SOL_MINT}, expected ${USDC_MINT}`], "the right curve numbers in the wrong token: exactly the quote is wrong");
  assert.equal(q(pk()).length, 1);
  assert.match(q(pk())[0], /^config quoteMint is /);
  const { quote: _omitted, ...noQuote } = w; // a want from before --quote: SOL
  assert.match(configMismatches(onChain(w, USDC_MINT), noQuote)[0], /^config quoteMint is EPjF.*, expected So11/);
  const s = wantOf("sol", { startMcap: 27.96, gradMcap: 410.8, poolFeeBps: 25 });
  assert.deepEqual(configMismatches(onChain(s, SOL_MINT), s), [], "SOL as before");
  assert.deepEqual(configMismatches(onChain(s, SOL_MINT), { ...s, quote: "sol" }), []);
  assert.ok(configMismatches(onChain(s, USDC_MINT), s).some((x) => /quoteMint/.test(x)));
  // A USDC want checked against a SOL curve's numbers: the threshold and the start price differ too.
  const bad = configMismatches(onChain(s, USDC_MINT), w).join("\n");
  assert.match(bad, /migrationQuoteThreshold/);
  assert.match(bad, /sqrtStartPrice/);
});

test("configMismatches reads the quote from the want, and refuses a want that names one we don't have", () => {
  const w = wantOf("usdc");
  refusal(() => configMismatches(onChain(w, USDC_MINT), { ...w, quote: "eth" }), /--quote is sol or usdc/);
});

/* ---------- launch-curve ---------- */

const good = () => ({
  name: "Cult", symbol: "CULT", uri: "https://cult.example/token.json", allowMissingUri: false, uriCheck: { ok: true }, feeKey: null, feeWallet: fee, creator: pk(),
  creatorLamports: 1_000_000_000n, feeWalletLamports: 50_000_000n, neededLamports: 40_000_000n, teamBuyLamports: 0n, programsMissing: [], cluster: "mainnet-beta", finished: null, tokenAuthority: "immutable",
});

test("launch-curve refuses a team buy on a USDC curve (it is SOL, and the creator holds SOL); a SOL curve and a USDC curve without one are fine", () => {
  assert.deepEqual(launchProblems({ ...good(), quote: "usdc" }), []);
  assert.deepEqual(launchProblems({ ...good(), quote: "sol", teamBuyLamports: 500_000_000n }), []);
  assert.deepEqual(launchProblems({ ...good(), teamBuyLamports: 500_000_000n }), [], "no quote named: SOL, as before");
  const p = launchProblems({ ...good(), quote: "usdc", teamBuyLamports: 500_000_000n });
  assert.equal(p.length, 1);
  assert.match(p[0], /--team-buy is SOL and can't be used with --quote usdc/);
});

test("launch-curve --quote: sol by default, usdc needs both market caps, anything else is refused, and the team buy flag still parses", () => {
  const prev = { ...process.env }; delete process.env.CREATOR_KEY; delete process.env.SOLANA_RPC_URL;
  try {
    const f = join(root, "c.json"); writeFileSync(f, JSON.stringify([...Keypair.generate().secretKey]));
    const base = ["--keypair", f, "--rpc", "http://x"];
    const d = launchOpts(base);
    assert.deepEqual([d.quote, d.startMcap, d.gradMcap], ["sol", 27.96, 410.8]);
    refusal(() => launchOpts([...base, "--quote", "usdc"]), /give both --start-mcap and --grad-mcap/);
    refusal(() => launchOpts([...base, "--quote", "eth"]), /--quote is sol or usdc/);
    refusal(() => launchOpts([...base, "--quote"]), /--quote needs a value/);
    const u = launchOpts([...base, "--quote", "usdc", "--start-mcap", "1935", "--grad-mcap", "28400"]);
    assert.deepEqual([u.quote, u.startMcap, u.gradMcap, u.poolFeeBps, u.go], ["usdc", 1935, 28400, 25, false], "a dry run unless --go");
    assert.equal(launchOpts([...base, "--quote", "sol", "--start-mcap", "30", "--grad-mcap", "400"]).startMcap, 30);
  } finally { process.env = prev; }
});

/* ---------- verify-launch ---------- */

const wantU = wantConfig(fee, REAL, "usdc");
const mint = pk(), config = pk(), creator = pk();
const mi = () => ({ decimals: 6, supply: 10n ** 15n, mintAuthority: null, freezeAuthority: null, fee: { bps: 1000, max: (1n << 64n) - 1n, configAuthority: null, withdrawAuthority: fee, withheld: 0n } });
const meta = () => ({ name: "Cult", symbol: "CULT", uri: "https://x/t.json", updateAuthority: undefined });
const read = (quoteMint) => ({ mi: mi(), meta: meta(), conf: onChain(wantU, quoteMint), pool: { baseMint: mint, config, creator }, poolAddr: pk() });
const o = { mint, config, creator, feeWallet: fee };
const failing = (r, oo) => launchChecks(r, oo).filter((c) => c.status === "FAIL").map((c) => c.what);

test("verify-launch's want for the real USDC curve is the SDK's numbers in USDC micro (not a SOL curve's, not the same function checking itself)", () => {
  assert.equal(wantU.thresholdLamports, 5_878_629_931n);
  assert.equal(wantU.sqrtStartPrice, 25_660_210_050_285_991n);
  assert.equal(wantU.quote, "usdc");
  assert.notEqual(wantConfig(fee, REAL, "sol").thresholdLamports, wantU.thresholdLamports);
  assert.equal(wantConfig(fee).quote, "sol", "no quote named: SOL, and the SOL numbers are the production defaults'");
  assert.equal(wantConfig(fee).thresholdLamports, 84_997_752_448n);
});

test("verify-launch --quote usdc: a USDC config on the real curve passes every check, and the check names the quote", () => {
  const checks = launchChecks(read(USDC_MINT), { ...o, curve: REAL, quote: "usdc" });
  assert.deepEqual(checks.filter((c) => c.status === "FAIL"), []);
  assert.ok(checks.some((c) => /USDC quote \(EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v\)/.test(c.what)), "the config line says what it checked");
});

test("verify-launch refuses a pool whose quote differs, in both directions: SOL-quoted when USDC is wanted, USDC-quoted when SOL is (the default)", () => {
  const sol = failing(read(SOL_MINT), { ...o, curve: REAL, quote: "usdc" });
  assert.equal(sol.length, 1, sol.join("\n"));
  assert.match(sol[0], /config quoteMint is So11111111111111111111111111111111111111112, expected EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/);
  const usdc = failing(read(USDC_MINT), { ...o, curve: REAL });
  assert.ok(usdc.some((w) => /config quoteMint is EPjF.*expected So11/.test(w)), "a USDC config is not what a default run expects");
  assert.ok(failing(read(pk()), { ...o, curve: REAL, quote: "usdc" }).some((w) => /config quoteMint/.test(w)), "any other token");
});

test("verify-launch --quote: the default is sol, usdc needs both market caps (so a SOL default can't judge a USDC curve), a typo is refused", () => {
  const prev = process.env.SOLANA_RPC_URL; delete process.env.SOLANA_RPC_URL;
  try {
    const m = pk().toBase58(), base = ["--rpc", "http://x.test", "--mint", m];
    const d = verifyOpts(base);
    assert.deepEqual([d.quote, d.curve], ["sol", { startMcap: 27.96, gradMcap: 410.8, poolFeeBps: 25 }]);
    refusal(() => verifyOpts([...base, "--quote", "usdc"]), /give both --start-mcap and --grad-mcap/);
    refusal(() => verifyOpts([...base, "--quote", "usd"]), /--quote is sol or usdc/);
    const u = verifyOpts([...base, "--quote", "usdc", "--start-mcap", "1935", "--grad-mcap", "28400"]);
    assert.deepEqual([u.quote, u.curve], ["usdc", REAL]);
    assert.deepEqual(wantConfig(fee, u.curve, u.quote), wantU);
  } finally { if (prev !== undefined) process.env.SOLANA_RPC_URL = prev; }
});

/* ---------- create-config: the plan for the real USDC config, from the CLI, against an RPC that only answers reads ---------- */

const CREATE = fileURLToPath(new URL("../create-config.mjs", import.meta.url));
const payerFile = join(root, "payer.json");
writeFileSync(payerFile, JSON.stringify([...Keypair.generate().secretKey]));
// An in-process JSON-RPC server (async: a spawnSync would block it) that answers the few reads a dry run makes, and counts them.
const PROGRAMS = ["dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"]; // the bonding-curve and DAMM v2 programs: executable
const creatorKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(payerFile, "utf8")))).publicKey.toBase58();
// opts.balances: lamports by address (default 1 SOL); opts.usdc: a USDC account's raw amount by address (an unknown one is "could not find account").
async function fakeRpc(opts = {}) {
  const calls = [], multi = [], mintAccount = Buffer.alloc(82); mintAccount[44] = 6; mintAccount[45] = 1; // an initialized 6-decimal mint
  const answer = (b) => {
    calls.push(b.method);
    if (b.method === "getMultipleAccounts") multi.push(b.params[0]);
    const acct = (lamports, executable = false) => ({ data: ["", "base64"], executable, lamports, owner: "11111111111111111111111111111111", rentEpoch: 0, space: 0 });
    const result = b.method === "getBalance" ? { context: { slot: 1 }, value: opts.balances?.[b.params[0]] ?? 1_000_000_000 }
      : b.method === "getTokenAccountBalance" ? (opts.usdc?.[b.params[0]] === undefined ? { error: { code: -32602, message: "Invalid param: could not find account" } } : { context: { slot: 1 }, value: { amount: String(opts.usdc[b.params[0]]), decimals: 6, uiAmount: 0, uiAmountString: "0" } })
      : b.method === "getMultipleAccounts" ? { context: { slot: 1 }, value: b.params[0].map((a) => (PROGRAMS.includes(a) ? acct(1, true) : a === FEE_WALLET ? acct(1_200_000_000) : a === creatorKey ? acct(1_000_000_000) : null)) }
      : b.method === "getLatestBlockhash" ? { context: { slot: 1 }, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 } }
      : b.method === "simulateTransaction" ? { context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 100_000, accounts: [acct(990_000_000)] } }
      : b.method === "getGenesisHash" ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
      : b.method === "getAccountInfo" ? { context: { slot: 1 }, value: { data: [mintAccount.toString("base64"), "base64"], executable: false, lamports: 1, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", rentEpoch: 0, space: 82 } }
      : b.method === "getEpochInfo" ? { epoch: 900, slotIndex: 1, slotsInEpoch: 432000, absoluteSlot: 1, blockHeight: 1 }
      : null;
    return result?.error ? { jsonrpc: "2.0", id: b.id, error: result.error } : { jsonrpc: "2.0", id: b.id, result };
  };
  const srv = http.createServer((req, res) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { const j = JSON.parse(s); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(j) ? j.map(answer) : answer(j))); }); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, calls, multi, close: () => new Promise((r) => srv.close(r)) };
}
const { CREATOR_KEY: _a, SOLANA_RPC_URL: _b, ...cleanEnv } = process.env; // neither may be set: the key is the file, the RPC is the flag
const runCreate = (args) => new Promise((resolve) => execFile(process.execPath, [CREATE, "--keypair", payerFile, "--state-dir", join(root, "state"), ...args], { env: cleanEnv }, (e, stdout, stderr) => resolve({ code: e?.code ?? 0, stdout, stderr })));

test("create-config for the real USDC config: the plan names USDC, the caps and the threshold; it is a dry run that sends nothing and writes nothing", async () => {
  const rpc = await fakeRpc();
  try {
    const r = await runCreate(["--rpc", rpc.url, "--quote", "usdc", "--start-mcap", "1935", "--grad-mcap", "28400"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Config plan \(dry run, add --go to send\)/);
    assert.match(r.stdout, /quoted in USDC: market cap 1935 USDC -> graduates at 28400 USDC after 5878\.63 USDC raised; pool fee 0\.25%/);
    assert.match(r.stdout, /10% transfer fee, rate locked for good/);
    assert.match(r.stdout, new RegExp(`fee wallet   ${FEE_WALLET}`));
    assert.ok(rpc.calls.includes("getAccountInfo"), "the SDK read the quote mint");
    assert.ok(!rpc.calls.includes("sendTransaction"), "nothing was sent");
    assert.equal(existsSync(join(root, "state")), false, "nothing was written");
  } finally { await rpc.close(); }
});

test("create-config without --quote is the SOL config as it always was", async () => {
  const rpc = await fakeRpc();
  try {
    const r = await runCreate(["--rpc", rpc.url]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /quoted in SOL: market cap 27\.96 SOL -> graduates at 410\.8 SOL after 84\.997752 SOL raised/);
  } finally { await rpc.close(); }
});

const LAUNCH = fileURLToPath(new URL("../launch-curve.mjs", import.meta.url));
const runLaunch = (args, stateDir = "launch-state") => new Promise((resolve) => execFile(process.execPath, [LAUNCH, "--keypair", payerFile, "--state-dir", join(root, stateDir), "--name", "Tithe Rehearsal", "--symbol", "TITHE", "--allow-missing-uri", ...args], { env: cleanEnv }, (e, stdout, stderr) => resolve({ code: e?.code ?? 0, stdout, stderr })));

test("launch-curve --quote usdc: the dry run plans a USDC curve (caps, price, threshold, the USDC side of graduation), sends nothing, and the SOL default is unchanged", async () => {
  const rpc = await fakeRpc();
  try {
    const u = await runLaunch(["--rpc", rpc.url, "--quote", "usdc", "--start-mcap", "1935", "--grad-mcap", "28400"]);
    assert.equal(u.code, 0, u.stderr);
    assert.match(u.stdout, /Plan \(dry run, add --go to send\)/);
    assert.match(u.stdout, /starts at 1\.935e-6 USDC per token \(market cap 1935 USDC\), graduates at 2\.840e-5 \(market cap 28400 USDC\); pool fee 0\.25% in USDC/);
    assert.match(u.stdout, /graduation needs 5878\.63 USDC raised/);
    assert.match(u.stdout, /the USDC side is scaled down by the same 10%: about 5280\.19 USDC goes into the pool/);
    assert.match(u.stdout, /claims its USDC fees/);
    assert.match(u.stdout, /sends        tx 1: config \+ pool/);
    assert.ok(!rpc.calls.includes("sendTransaction"), "a dry run sends nothing");
    const s = await runLaunch(["--rpc", rpc.url]);
    assert.equal(s.code, 0, s.stderr);
    assert.match(s.stdout, /starts at 2\.796e-8 SOL per token \(market cap 27\.96 SOL\)/);
    assert.match(s.stdout, /graduation needs 84\.997752 SOL raised/);
  } finally { await rpc.close(); }
});

test("launch-curve refuses --team-buy with --quote usdc, and --quote usdc without both market caps, before sending anything", async () => {
  const rpc = await fakeRpc();
  try {
    const t = await runLaunch(["--rpc", rpc.url, "--quote", "usdc", "--start-mcap", "1935", "--grad-mcap", "28400", "--team-buy", "0.5"]);
    assert.equal(t.code, 1);
    assert.match(t.stderr, /REFUSING: --team-buy is SOL and can't be used with --quote usdc/);
    const m = await runLaunch(["--rpc", "http://127.0.0.1:9", "--quote", "usdc"]);
    assert.equal(m.code, 1);
    assert.match(m.stderr, /REFUSING: With --quote usdc give both --start-mcap and --grad-mcap/);
    assert.ok(!rpc.calls.includes("sendTransaction"));
  } finally { await rpc.close(); }
});

test("launch-curve looks for the pool of the quote's own address (the mint and config come from a saved unfinished launch, so the test knows them)", async () => {
  const dir = join(root, "resume-state"), mint = Keypair.generate(), config = Keypair.generate();
  mkdirSync(dir);
  writeFileSync(join(dir, `mint-${mint.publicKey}.json`), JSON.stringify([...mint.secretKey]));
  writeFileSync(join(dir, `config-${config.publicKey}.json`), JSON.stringify([...config.secretKey]));
  writeFileSync(join(dir, `launch-curve-${mint.publicKey}.json`), JSON.stringify({ creator: creatorKey, symbol: "TITHE", mint: mint.publicKey.toBase58(), config: config.publicKey.toBase58(), txs: [] }));
  const poolIn = (rpc, q) => rpc.multi.some((r) => r[0] === config.publicKey.toBase58() && r[1] === deriveDbcPoolAddress(q, mint.publicKey, config.publicKey).toBase58());
  const rpc = await fakeRpc();
  try {
    const u = await runLaunch(["--rpc", rpc.url, "--quote", "usdc", "--start-mcap", "1935", "--grad-mcap", "28400"], "resume-state");
    assert.equal(u.code, 0, u.stderr);
    assert.match(u.stdout, /RESUMING the unfinished launch/);
    assert.ok(poolIn(rpc, USDC_MINT), "the USDC curve's pool was looked up");
    assert.ok(!poolIn(rpc, QUOTES.sol.mint), "and not the SOL pool for the same mint and config");
    const s = await runLaunch(["--rpc", rpc.url], "resume-state");
    assert.equal(s.code, 0, s.stderr);
    assert.ok(poolIn(rpc, QUOTES.sol.mint), "the SOL default looks up the SOL pool");
  } finally { await rpc.close(); }
});

test("create-config refuses --quote usdc without both market caps, and an unknown quote, before it reads the chain (the RPC is a closed port)", async () => {
  const closed = "http://127.0.0.1:9";
  const a = await runCreate(["--rpc", closed, "--quote", "usdc"]);
  assert.equal(a.code, 1);
  assert.match(a.stderr, /REFUSING: With --quote usdc give both --start-mcap and --grad-mcap in USDC/);
  const b = await runCreate(["--rpc", closed, "--quote", "usdc", "--start-mcap", "1935"]);
  assert.equal(b.code, 1);
  assert.match(b.stderr, /give both/);
  const c = await runCreate(["--rpc", closed, "--quote", "eth", "--start-mcap", "1", "--grad-mcap", "2"]);
  assert.equal(c.code, 1);
  assert.match(c.stderr, /REFUSING: --quote is sol or usdc/);
});

/* ---------- rehearse-curve --quote usdc: the sizing, the swap step, the dry run, the refusals ---------- */

const depKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(payerFile, "utf8")))); // the creator the fake RPC knows (and so the fee wallet)
const usdcAta = (pkey) => getAssociatedTokenAddressSync(USDC_MINT, pkey, true, TOKEN_PROGRAM_ID).toBase58();

// What the 6 / 6.6 USDC curve costs, from the SDK's own plan: buyers pay 3,229,456 at graduation; need = that + 2.5% + 0.6 USDC of DAMM buys + 0.05.
const NEED = 3_960_192n, WANTED = 4_752_230n;

test("USDC sizing: the need is the graduation raise (+2.5% room) plus the DAMM buys, the swap buys 20% more, and the SOL for it is rounded up", () => {
  const plan = curvePlan(buildCurve({ startMcap: 6, gradMcap: 6.6, quote: "usdc" }), { quote: "usdc" });
  assert.equal(plan.buyersPayAtGraduationLamports, 3_229_456n);
  assert.equal(reh.usdcNeed(plan, { dammBuy: 400_000n, dammBuy2: 200_000n }), NEED);
  assert.equal(reh.usdcWanted(NEED), WANTED);
  assert.equal(reh.solFor(WANTED, 10_000_000n, 700_000n), 67_889_000n, "1 SOL = 70 USDC: 4.75 USDC is 0.067889 SOL");
  assert.equal(reh.solFor(1n, 10_000_000n, 700_000n), 15n, "rounded up: 14.28 lamports buys 1 micro-USDC");
  assert.equal(reh.solFor(700_000n, 10_000_000n, 700_000n), 10_000_000n, "exactly the probe");
  assert.equal(reh.solFor(0n, 10_000_000n, 700_000n), 0n);
});

test("jupKey reads JUP_API_KEY from the vars file (quotes, spaces, CRLF), refuses a missing file or key, and never puts the key in a message", () => {
  const f = (text) => { const p = join(root, `vars-${rehN++}`); writeFileSync(p, text); return p; };
  assert.equal(reh.jupKey(f("A=1\nJUP_API_KEY=abc123\nB=2\n")), "abc123");
  assert.equal(reh.jupKey(f('X=1\r\nJUP_API_KEY = "quoted-key"\r\n')), "quoted-key");
  assert.equal(reh.jupKey(f("JUP_API_KEY='single'")), "single");
  assert.equal(reh.jupKey(f("NOT_JUP_API_KEY=wrong\nJUP_API_KEY=right")), "right", "the name is matched from the start of the line");
  refusal(() => reh.jupKey(f("SOLANA_RPC_URL=https://x\nJUP_API_KEY=\n")), /has no JUP_API_KEY/);
  refusal(() => reh.jupKey(f("SOLANA_RPC_URL=https://x\n")), /has no JUP_API_KEY/);
  refusal(() => reh.jupKey(join(root, "no-such-vars")), /Can't read .*no-such-vars for the Jupiter key/);
  const secret = "SECRET-DO-NOT-PRINT";
  assert.throws(() => reh.jupKey(f(`  JUP_API_KEY=${secret}`)), (e) => e instanceof Refuse && !e.message.includes(secret), "an indented line is not a variable");
});

test("rehearse-curve --quote: sol is the default and unchanged; usdc has its own state dir, defaults, USDC trade sizes and no team buy; a typo or a mixed-up flag is refused", () => {
  const prev = { ...process.env }; delete process.env.SOLANA_RPC_URL;
  try {
    const a = join(root, "rd.json"), b = join(root, "rt.json");
    writeFileSync(a, JSON.stringify([...Keypair.generate().secretKey])); writeFileSync(b, JSON.stringify([...Keypair.generate().secretKey]));
    const base = ["--rpc", "http://x", "--deployer-keypair", a, "--trader-keypair", b];
    const s = reh.optsFromArgs(base);
    assert.deepEqual([s.quote, s.startMcap, s.gradMcap, s.capLamports, s.teamBuy, s.traderBuy, s.go], ["sol", 0.03, 0.033, 75_000_000n, 3_000_000n, 4_000_000n, false], "the SOL rehearsal's numbers, untouched");
    assert.match(s.stateDir, /rehearsal-curve$/);
    const u = reh.optsFromArgs([...base, "--quote", "usdc"]);
    assert.deepEqual([u.quote, u.startMcap, u.gradMcap, u.capLamports, u.teamBuy, u.traderBuy, u.go], ["usdc", 6, 6.6, 130_000_000n, 0n, 400_000n, false]);
    assert.match(u.stateDir, /rehearsal-usdc$/);
    const c = reh.optsFromArgs([...base, "--quote", "usdc", "--trader-buy", "0.25", "--start-mcap", "5", "--grad-mcap", "5.5", "--cap-sol", "0.2", "--state-dir", join(root, "mine")]);
    assert.deepEqual([c.traderBuy, c.startMcap, c.gradMcap, c.capLamports, c.stateDir], [250_000n, 5, 5.5, 200_000_000n, join(root, "mine")]);
    assert.equal(reh.optsFromArgs([...base, "--trader-buy", "0.25"]).traderBuy, 250_000_000n, "in SOL when the curve is SOL");
    refusal(() => reh.optsFromArgs([...base, "--quote", "usdc", "--team-buy", "0.003"]), /--team-buy is SOL and can't be used with --quote usdc/);
    refusal(() => reh.optsFromArgs([...base, "--quote", "usdc", "--trader-buy", "0.0000001"]), /--trader-buy must be an amount like 1 or 0.25 \(at most 6 decimals\)/);
    refusal(() => reh.optsFromArgs([...base, "--quote", "eth"]), /--quote is sol or usdc/);
    refusal(() => reh.optsFromArgs([...base, "--quote"]), /--quote needs a value/);
  } finally { process.env = prev; }
});

// A Jupiter that quotes 0.07 USDC-micro per lamport (1 SOL = 70 USDC), counts what it was asked and what key it was shown.
async function fakeJup({ noRoute = false } = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, key: req.headers["x-api-key"] });
    const amount = BigInt(new URL(req.url, "http://x").searchParams.get("amount") ?? 0);
    res.setHeader("content-type", "application/json");
    if (noRoute) { res.statusCode = 404; return res.end(JSON.stringify({ error: "no route" })); }
    res.end(JSON.stringify({ inAmount: String(amount), outAmount: String((amount * 7n) / 100n), otherAmountThreshold: "1", routePlan: [{ swapInfo: {} }], priceImpactPct: "0" }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise((r) => srv.close(r)) };
}
// The Worker's treasurySwap, faked: it has its own tests (test/round.test.js); here it records what the rehearsal asked of it.
const fakeSwap = () => { const calls = []; const f = async (env, cfg, kp, args) => { calls.push({ env, cfg, kp: kp.publicKey.toBase58(), args }); return { tx: { serialize: () => Uint8Array.from([7]) }, sig: "SWAPSIG", lvbh: 500, minOut: 4_700_000 }; }; f.calls = calls; return f; };
let rehN = 0;
// One in-process rehearse() call against the fake RPC and Jupiter. The trader holds 0.101435 SOL unless rpcOpts.balances says otherwise.
async function dry({ rpcOpts, jupOpts, trader = Keypair.generate(), ...over } = {}) {
  const swap = fakeSwap(), rpc = await fakeRpc({ ...rpcOpts, balances: { [trader.publicKey.toBase58()]: 101_435_000, ...rpcOpts?.balances } }), jup = await fakeJup(jupOpts);
  const out = [], errs = [], prevErr = console.error, prevCode = process.exitCode;
  console.error = (...a) => errs.push(a.join(" "));
  try {
    const o = { conn: new Connection(rpc.url, "confirmed"), quote: "usdc", deployer: depKp, trader, stateDir: join(root, `reh${rehN++}`), capLamports: 130_000_000n, teamBuy: 0n, traderBuy: 400_000n, startMcap: 6, gradMcap: 6.6, go: false, skipMarkets: true, jupUrl: jup.url, treasurySwap: swap, ...over };
    let thrown = null; try { await reh.rehearse(o, (s) => out.push(String(s))); } catch (e) { thrown = e; }
    return { out: out.join("\n"), errs: errs.join("\n"), exit: process.exitCode, rpc, jup, swap, trader, o, thrown };
  } finally { console.error = prevErr; process.exitCode = prevCode; await rpc.close(); await jup.close(); }
}

test("rehearse dry run, --quote usdc: the plan is in USDC, the swap is sized from Jupiter's price and simulated, the SOL and USDC budgets are shown, and nothing is sent or saved", async () => {
  const r = await dry();
  assert.equal(r.thrown, null, String(r.thrown?.stack));
  assert.equal(r.exit, undefined, r.errs);
  assert.match(r.out, /Rehearsal \(dry run, add --go to send\)/);
  assert.match(r.out, /trader   \S+ holds 0\.101435 SOL and 0\.00 USDC/);
  assert.match(r.out, /curve    start mcap 6 USDC, graduation mcap 6\.6 USDC -> graduation needs 3\.22 USDC raised; team buy none, trader first buy 0\.40 USDC/);
  assert.match(r.out, /the rehearsal trades about 3\.96 USDC \(the curve's buyers pay 3\.23 USDC to graduate, the two DAMM buys 0\.60 USDC\); the trader holds 0\.00 USDC/);
  assert.match(r.out, /step 0 buys 4\.75 USDC \(the need plus 20%\) with 0\.067889 SOL of the trader's SOL on Jupiter at 1 SOL = 70\.00 USDC \(keyless estimate\)/);
  assert.match(r.out, /budget   SOL 0\.067889 SOL for the swap \+ about 0\.045000 SOL for rent and fees = about 0\.112889 SOL of the 0\.130000 SOL cap; USDC 4\.75 USDC bought, 3\.96 USDC expected to be traded/);
  assert.match(r.out, /swap     simulated against the real programs: ok, pays out at least 4\.70 USDC \(instructions inspected; not sent\)/);
  assert.match(r.out, /on the curve .*graduation needs 3\.22 USDC raised/, "the launch plan under it is the USDC curve too");
  assert.match(r.out, /team buy     none/);
  assert.equal(r.swap.calls.length, 1, "the swap was built (and so simulated) once");
  const c = r.swap.calls[0];
  assert.deepEqual(c.args, { inputMint: SOL_MINT.toBase58(), inputProgram: TOKEN_PROGRAM_ID.toBase58(), outputMint: USDC_MINT.toBase58(), outputProgram: TOKEN_PROGRAM_ID.toBase58(), amount: "67889000" });
  assert.equal(c.kp, r.trader.publicKey.toBase58(), "the trader's SOL, signed by the trader");
  assert.equal(c.cfg.slippageBps, 100);
  assert.equal(c.cfg.jup, r.jup.url);
  assert.equal(c.env.JUP_API_KEY, undefined, "a dry run does not read the vars file");
  assert.equal(c.env.SOLANA_RPC_URL, r.rpc.url, "the swap code reads and simulates on the RPC this run was given, not its own default");
  assert.equal(r.jup.seen.length, 1, "one probe quote");
  assert.equal(r.jup.seen[0].key, undefined, "and it was keyless");
  assert.match(r.jup.seen[0].url, /inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=10000000&slippageBps=100/);
  assert.ok(!r.rpc.calls.includes("sendTransaction"), "nothing was sent");
  assert.equal(existsSync(join(r.o.stateDir, "rehearsal.json")), false, "a dry run saves no state");
});

test("rehearse dry run, --quote sol: the SOL rehearsal's plan, no USDC line and no call to Jupiter", async () => {
  // No team buy here: the fake RPC answers every account lookup with a mint, which the SDK's first-buy path can't read.
  const r = await dry({ quote: "sol", teamBuy: 0n, traderBuy: 4_000_000n, startMcap: 0.03, gradMcap: 0.033, capLamports: 75_000_000n });
  assert.equal(r.thrown, null, String(r.thrown?.stack));
  assert.match(r.out, /curve    start mcap 0\.03 SOL, graduation mcap 0\.033 SOL -> graduation needs 0\.016107 SOL raised; team buy 0\.000000 SOL, trader first buy 0\.004000 SOL/);
  assert.ok(!/USDC/.test(r.out) && !/step 0/.test(r.out));
  assert.equal(r.jup.seen.length, 0);
  assert.equal(r.swap.calls.length, 0);
});

test("rehearse dry run: a trader that already holds the USDC buys none, one that holds some buys only the rest, and Jupiter's price is needed only when there is a swap", async () => {
  const trader = Keypair.generate(), at = usdcAta(trader.publicKey);
  const enough = await dry({ trader, rpcOpts: { usdc: { [at]: 5_000_000 } }, jupOpts: { noRoute: true } });
  assert.equal(enough.thrown, null); assert.equal(enough.exit, undefined, enough.errs);
  assert.match(enough.out, /the trader holds 5\.00 USDC\n\s+the trader holds enough: no swap/);
  assert.match(enough.out, /budget   SOL 0\.000000 SOL for the swap \+ about 0\.045000 SOL/);
  assert.equal(enough.swap.calls.length, 0);
  const some = await dry({ trader, rpcOpts: { usdc: { [at]: 1_000_000 } } });
  assert.match(some.out, /step 0 buys 3\.75 USDC .* with 0\.053603 SOL/, "4,752,230 wanted less the 1,000,000 held, at 70 USDC a SOL, rounded up");
  assert.equal(some.swap.calls[0].args.amount, "53603286");
});

test("rehearse dry run refuses (exit 1, nothing sent) a trader short of SOL, a plan over the cap, a Jupiter with no price, and a swap whose checks fail", async () => {
  const trader = Keypair.generate();
  const poor = await dry({ trader, rpcOpts: { balances: { [trader.publicKey.toBase58()]: 50_000_000 } } });
  assert.equal(poor.exit, 1);
  assert.match(poor.errs, new RegExp(`REFUSING: The trader ${trader.publicKey.toBase58()} holds 0\\.050000 SOL; the swap and its accounts and fees need 0\\.077889 SOL\\. Send at least 0\\.027889 SOL more to it\\.`));
  assert.equal(poor.swap.calls.length, 0, "no swap is simulated for a wallet that can't pay for it");
  assert.match(poor.out, /Plan \(dry run/, "the launch plan still prints");
  const edge = await dry({ trader, rpcOpts: { balances: { [trader.publicKey.toBase58()]: 77_889_000 } } });
  assert.equal(edge.exit, undefined, "exactly what it needs is enough");
  const dear = await dry({ capLamports: 100_000_000n });
  assert.equal(dear.exit, 1);
  assert.match(dear.errs, /REFUSING: BUDGET: the plan needs about 0\.112889 SOL of SOL and the cap is 0\.100000 SOL\. Raise --cap-sol only if you accept that\. Nothing was sent\./);
  const exact = await dry({ capLamports: 112_889_000n });
  assert.equal(exact.exit, undefined, "a plan exactly at the cap is allowed");
  const blind = await dry({ jupOpts: { noRoute: true } });
  assert.equal(blind.exit, 1);
  assert.match(blind.errs, /REFUSING: Jupiter gave no SOL price \(Jupiter 404: no route\), so the swap can't be sized\. Nothing was sent\./);
  assert.equal(blind.swap.calls.length, 0);
  const refused = await dry({ treasurySwap: async () => { throw new Error("Jupiter's swap was refused (system transfer)."); } });
  assert.equal(refused.exit, 1);
  assert.match(refused.errs, /REFUSING: The swap is refused: Jupiter's swap was refused \(system transfer\)\./);
});

test("rehearse --go with a plan that can't be done stops before anything is sent; the Jupiter key is read, used, and never printed", async () => {
  const key = "k-test-NEVER-PRINT-123", vars = join(root, "go-vars");
  writeFileSync(vars, `SOLANA_RPC_URL=https://x\r\nJUP_API_KEY="${key}"\r\n`);
  const trader = Keypair.generate();
  const r = await dry({ go: true, jupVars: vars, trader, rpcOpts: { balances: { [trader.publicKey.toBase58()]: 50_000_000 } } });
  assert.ok(r.thrown instanceof Refuse, String(r.thrown));
  assert.match(r.thrown.message, /The trader .* holds 0\.050000 SOL/);
  assert.ok(r.jup.seen.length >= 1 && r.jup.seen.every((s) => s.key === key), "the probe quote carried the key");
  for (const text of [r.out, r.errs, r.thrown.message, String(r.thrown.stack)]) assert.ok(!text.includes(key), "the key is in no output");
  assert.ok(!r.out.includes("keyless"), "a live run names api.jup.ag, not the keyless estimate");
  assert.ok(!r.rpc.calls.includes("sendTransaction"), "nothing was sent");
  assert.ok(!r.rpc.calls.includes("getLatestBlockhash"), "not even a launch was started");
  assert.equal(r.swap.calls.length, 0);
  const none = await dry({ go: true, jupVars: join(root, "no-vars-here") });
  assert.ok(none.thrown instanceof Refuse);
  assert.match(none.thrown.message, /Can't read .*no-vars-here for the Jupiter key/);
  assert.equal(none.jup.seen.length, 0, "no key, no call");
  assert.ok(!none.rpc.calls.includes("sendTransaction"));
});

test("a state folder from the other quote's rehearsal is refused, not resumed", async () => {
  const stateDir = join(root, "mixed"); mkdirSync(stateDir);
  writeFileSync(join(stateDir, "rehearsal.json"), JSON.stringify({ done: { "1 launch (team buy + refund)": true }, checks: [], markets: {}, v: {}, mint: "X" }));
  const r = await dry({ stateDir });
  assert.ok(r.thrown instanceof Refuse);
  assert.match(r.thrown.message, /is a sol rehearsal; this run is --quote usdc\. Use its own --state-dir\./);
  assert.equal(r.swap.calls.length, 0);
  assert.equal(r.jup.seen.length, 0);
});

test("a resumed USDC rehearsal whose swap is done plans no swap: a trader low on USDC and SOL is not refused for it, and Jupiter is not asked", async () => {
  const stateDir = join(root, "resumed"), trader = Keypair.generate(); mkdirSync(stateDir);
  writeFileSync(join(stateDir, "rehearsal.json"), JSON.stringify({ done: { "0 swap SOL for USDC": true }, checks: [], markets: {}, v: { swap: { sig: "S", lvbh: 5 } }, mint: "X", quote: "usdc" }));
  const r = await dry({ stateDir, trader, rpcOpts: { balances: { [trader.publicKey.toBase58()]: 1_000_000 } } });
  assert.equal(r.thrown, null, String(r.thrown?.stack));
  assert.equal(r.exit, undefined, r.errs);
  assert.match(r.out, /USDC     step 0 \(the swap\) is done/);
  assert.ok(!/step 0 buys/.test(r.out));
  assert.equal(r.jup.seen.length, 0); assert.equal(r.swap.calls.length, 0);
});

/* ---- step 0: the swap is signed once, its signature saved before the broadcast, and a re-run settles it instead of swapping again ---- */

const chainFor = (statusOf = () => ({ confirmationStatus: "confirmed" })) => {
  const c = { sent: [], getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 }), sendRawTransaction: async (raw) => { c.sent.push(raw); return "x"; }, getSignatureStatuses: async ([sig]) => ({ value: [statusOf(sig)] }), getBlockHeight: async () => 1000 };
  return c;
};
function stepZero({ status, S = { v: {} }, balance = 0n, swapOver = {}, swapFn } = {}) {
  const d = join(root, `getusdc${rehN++}`); mkdirSync(d);
  const conn = chainFor(status), swaps = [], notes = [];
  const save = () => writeFileSync(join(d, "state.json"), JSON.stringify(S));
  const sender = makeSender({ conn, dir: d, name: "t", say: () => {}, wait: async () => {} });
  const swap = swapFn ?? (async () => { swaps.push(1); return { sig: `SWAP${swaps.length}`, lvbh: 500, raw: Uint8Array.from([9]), ...swapOver }; });
  const run = () => reh.getUsdc({ conn, sender, S, save, need: 4_000_000n, have: async () => balance, swap, say: (s) => notes.push(s) });
  return { d, conn, S, swaps, notes, run, stateFile: join(d, "state.json"), state: () => JSON.parse(readFileSync(join(d, "state.json"), "utf8")), pending: () => join(d, "t.pending.json") };
}

test("step 0: the swap's signature is in the state file and the pending file before the transaction is broadcast, and it is sent once", async () => {
  const z = stepZero();
  let before = null;
  z.conn.sendRawTransaction = async (raw) => { before = { state: z.state(), pending: JSON.parse(readFileSync(z.pending(), "utf8")) }; z.conn.sent.push(raw); return "x"; };
  await z.run();
  assert.deepEqual(before.state.v.swap, { sig: "SWAP1", lvbh: 500 });
  assert.deepEqual(before.pending, { label: "swap SOL for USDC", sig: "SWAP1", lastValidBlockHeight: 500 });
  assert.equal(z.conn.sent.length, 1);
  assert.equal(z.swaps.length, 1);
  assert.ok(!existsSync(z.pending()));
  assert.deepEqual(z.S.v.swap, { sig: "SWAP1", lvbh: 500 }, "kept: the next run settles from it");
});

test("step 0 after a crash: a saved swap that landed is not swapped again (no new quote, nothing sent)", async () => {
  const z = stepZero({ S: { v: { swap: { sig: "OLD", lvbh: 400 } } } });
  await z.run();
  assert.equal(z.swaps.length, 0);
  assert.equal(z.conn.sent.length, 0);
  assert.match(z.notes.join("\n"), /the swap OLD landed in an earlier run/);
});

test("step 0 after a crash: a saved swap that expired, or failed on chain, is replaced by one new swap, and only then", async () => {
  for (const [what, status, re] of [["expired", () => null, /never landed \(its blockhash expired\); swapping again/], ["failed", () => ({ err: { InstructionError: [0, "Custom"] } }), /failed on chain; swapping again/]]) {
    const z = stepZero({ S: { v: { swap: { sig: "OLD", lvbh: 400 } } }, status: (sig) => (sig === "OLD" ? status() : { confirmationStatus: "confirmed" }) });
    await z.run();
    assert.equal(z.swaps.length, 1, what);
    assert.equal(z.conn.sent.length, 1, what);
    assert.equal(z.S.v.swap.sig, "SWAP1", what);
    assert.match(z.notes.join("\n"), re);
    // A dead record is dropped even when nothing replaces it (the trader was topped up by hand meanwhile).
    const held = stepZero({ S: { v: { swap: { sig: "OLD", lvbh: 400 } } }, balance: 4_000_000n, status: () => status() });
    await held.run();
    assert.equal(held.swaps.length, 0, what); assert.equal(held.S.v.swap, undefined, what); assert.equal(held.state().v.swap, undefined, what);
  }
});

test("step 0 after a crash mid-send: the pending signature is settled first and its transaction is never sent again", async () => {
  const z = stepZero({ S: { v: { swap: { sig: "PEND", lvbh: 400 } } } });
  writeFileSync(z.pending(), JSON.stringify({ label: "swap SOL for USDC", sig: "PEND", lastValidBlockHeight: 400 }));
  await z.run();
  assert.equal(z.conn.sent.length, 0);
  assert.equal(z.swaps.length, 0);
  assert.ok(!existsSync(z.pending()), "settled and cleared");
});

test("step 0: a trader that already holds the need swaps nothing; a refused or unbounded swap sends and saves nothing", async () => {
  const rich = stepZero({ balance: 4_000_000n });
  await rich.run();
  assert.equal(rich.swaps.length, 0); assert.equal(rich.conn.sent.length, 0);
  assert.match(rich.notes.join("\n"), /already holds enough USDC; no swap/);
  const poor = stepZero({ balance: 3_999_999n });
  await poor.run();
  assert.equal(poor.swaps.length, 1, "one micro-USDC short is a swap");
  const noBound = stepZero({ swapOver: { lvbh: 0 } });
  await assert.rejects(noBound.run(), (e) => e instanceof Refuse && /no last-valid block height/.test(e.message));
  assert.equal(noBound.conn.sent.length, 0); assert.equal(noBound.S.v.swap, undefined); assert.ok(!existsSync(noBound.stateFile));
  const bad = stepZero({ swapFn: async () => { throw new Error("Jupiter's swap was refused (priority fee)."); } });
  await assert.rejects(bad.run(), /priority fee/);
  assert.equal(bad.conn.sent.length, 0); assert.equal(bad.S.v.swap, undefined); assert.ok(!existsSync(bad.stateFile));
});

test("step 0: a swap that expires unseen is forgotten (so the next run swaps again), and one that fails on chain keeps its signature for the next run to settle", async () => {
  const gone = stepZero({ status: () => null });
  await assert.rejects(gone.run(), /expired without landing, so nothing was spent/);
  assert.equal(gone.S.v.swap, undefined);
  assert.equal(gone.state().v.swap, undefined, "forgotten on disk too");
  const failed = stepZero({ status: () => ({ err: { InstructionError: [0, "Custom"] } }) });
  await assert.rejects(failed.run(), /failed on chain/);
  assert.equal(failed.S.v.swap.sig, "SWAP1");
});
