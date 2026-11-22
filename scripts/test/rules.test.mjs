// Tests for the pure rules in launch-curve, migrate-curve, fee-ops and rehearse-curve: every refusal, every verdict.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { launchProblems, configMismatches, mintMismatches, optsFromArgs, REHEARSAL_NAME } from "../launch-curve.mjs";
import { curveStatus } from "../migrate-curve.mjs";
import { refundVerdict, sweepPlan } from "../fee-ops.mjs";
import { collectSigs } from "../rehearse-curve.mjs";
import { SOL_MINT, FEE_WALLET, Refuse, buildCurve, curvePlan } from "../lib/curve.mjs";

const root = mkdtempSync(join(tmpdir(), "curve-rules-"));
after(() => rmSync(root, { recursive: true, force: true }));
const pk = () => Keypair.generate().publicKey;

// ---- launch refusals ------------------------------------------------------------------------------------------------------
const fee = new PublicKey(FEE_WALLET), creator = pk();
const good = () => ({
  name: "Cult", symbol: "CULT", uri: "https://cult.example/token.json", allowMissingUri: false, uriCheck: { ok: true }, feeKey: null, feeWallet: fee, creator,
  creatorLamports: 1_000_000_000n, feeWalletLamports: 50_000_000n, neededLamports: 40_000_000n, teamBuyLamports: 0n, programsMissing: [], cluster: "mainnet-beta", finished: null, tokenAuthority: "immutable",
});
const has = (i, re) => launchProblems(i).some((p) => re.test(p));

test("a sound launch has no refusals", () => assert.deepEqual(launchProblems(good()), []));

test("launch refuses each bad input with a plain reason", () => {
  assert.ok(has({ ...good(), uri: "", uriCheck: null }, /--uri is required/));
  assert.ok(has({ ...good(), uriCheck: { ok: false, why: "https://x answers 404" } }, /metadata file isn't usable: https:\/\/x answers 404/));
  assert.ok(has({ ...good(), creatorLamports: 10_000_000n }, /creator wallet .* holds 0\.010000 SOL; .*need about 0\.040000 SOL.*Send at least 0\.030000 SOL more/));
  assert.ok(has({ ...good(), creatorLamports: null }, /Can't read the creator wallet/));
  assert.ok(has({ ...good(), feeWalletLamports: 0n }, /fee wallet .* holds 0\.000000 SOL; it needs at least 0\.010000 SOL/));
  assert.ok(has({ ...good(), feeWalletLamports: 9_999_999n }, /fee wallet/), "one lamport under the minimum still refuses");
  assert.ok(!has({ ...good(), feeWalletLamports: 10_000_000n }, /fee wallet/), "exactly the minimum passes");
  assert.ok(has({ ...good(), feeWalletLamports: null }, /Can't read the fee wallet/));
  assert.ok(has({ ...good(), feeKey: Keypair.generate() }, /--fee-keypair is .*, not the fee wallet/));
  assert.ok(!has({ ...good(), feeKey: { publicKey: fee } }, /fee-keypair/));
  assert.ok(has({ ...good(), programsMissing: ["the DAMM v2 program X"] }, /Not deployed on this cluster/));
  assert.ok(has({ ...good(), finished: "/x/launch-curve-M.json" }, /Already launched here .*--new-mint/));
  assert.ok(has({ ...good(), cluster: "an unknown cluster" }, /unknown cluster/));
  assert.ok(has({ ...good(), name: "" }, /--name is 1 to 32/));
  assert.ok(has({ ...good(), name: "x".repeat(33) }, /--name is 1 to 32/));
  assert.ok(has({ ...good(), symbol: "ABCDEFGHIJK" }, /--symbol is 1 to 10/));
  assert.ok(has({ ...good(), uri: "https://x/" + "a".repeat(200) }, /longer than 200/));
});

test("--allow-missing-uri is refused for the real coin and accepted only for the rehearsal name", () => {
  assert.ok(has({ ...good(), allowMissingUri: true, uri: "", uriCheck: null }, /only for the rehearsal coin/));
  assert.ok(has({ ...good(), name: "Cult", symbol: "CULT", allowMissingUri: true, uri: "https://x/t.json" }, /only for the rehearsal coin/));
  assert.deepEqual(launchProblems({ ...good(), name: REHEARSAL_NAME, symbol: "TITHE", allowMissingUri: true, uri: "", uriCheck: null }), []);
});

// ---- what must be on chain ------------------------------------------------------------------------------------------------------
const cfg = buildCurve({ startMcap: 30, gradMcap: 400 }), plan = curvePlan(cfg);
const want = { feeWallet: fee, poolFeeBps: 25, tokenAuthorityCode: 1, thresholdLamports: plan.thresholdLamports, sqrtStartPrice: BigInt(cfg.sqrtStartPrice.toString()) };
// The config the mainnet spike stored (read 16 Nov 2026), with the withheld authority set to the partner as the real launch does.
const onChain = () => ({
  quoteMint: SOL_MINT, feeClaimer: fee, leftoverReceiver: fee, tokenType: 1, tokenDecimal: 6, transferFeeFlag: 1, transferFeeBasisPoints: 1000, transferFeeWithheldAuthority: 0,
  migratedTransferFeeAuthorityOption: 0, fixedTokenSupplyFlag: 1, migrationOption: 1, migrationFeeOption: 6, migratedCollectFeeMode: 2, migratedCompoundingFeeBps: 0, migratedPoolFeeBps: 25,
  partnerPermanentLockedLiquidityPercentage: 100, creatorTradingFeePercentage: 0, migrationFeePercentage: 0, tokenUpdateAuthority: 1, migrationQuoteThreshold: plan.thresholdLamports,
  sqrtStartPrice: BigInt(cfg.sqrtStartPrice.toString()), preMigrationTokenSupply: 10n ** 15n, postMigrationTokenSupply: 10n ** 15n,
});
const wrong = (k, v) => configMismatches({ ...onChain(), [k]: v }, want);

test("the stored config must say exactly what the design needs: each field is checked", () => {
  assert.deepEqual(configMismatches(onChain(), want), []);
  assert.match(wrong("feeClaimer", pk())[0], /feeClaimer/);
  assert.match(wrong("leftoverReceiver", pk())[0], /leftoverReceiver/);
  assert.match(wrong("transferFeeBasisPoints", 500)[0], /transferFeeBasisPoints is 500/);
  assert.match(wrong("transferFeeWithheldAuthority", 1)[0], /transferFeeWithheldAuthority \(partner\)/);
  assert.match(wrong("migratedTransferFeeAuthorityOption", 3)[0], /immutable/);
  assert.match(wrong("migratedCollectFeeMode", 0)[0], /compounding/);
  assert.match(wrong("migrationFeeOption", 3)[0], /customizable/);
  assert.match(wrong("partnerPermanentLockedLiquidityPercentage", 90)[0], /LockedLiquidity/);
  assert.match(wrong("migratedCompoundingFeeBps", 5000)[0], /Compounding/i);
  assert.match(wrong("migrationQuoteThreshold", 1n)[0], /migrationQuoteThreshold/);
  assert.match(wrong("tokenUpdateAuthority", 0)[0], /tokenUpdateAuthority/);
  assert.match(wrong("quoteMint", pk())[0], /quoteMint/);
  assert.match(wrong("fixedTokenSupplyFlag", 0)[0], /fixedTokenSupplyFlag/);
  assert.match(wrong("creatorTradingFeePercentage", 50)[0], /creatorTradingFeePercentage/);
});

const goodMint = () => ({ decimals: 6, supply: 10n ** 15n, mintAuthority: null, freezeAuthority: null, fee: { bps: 1000, max: (1n << 64n) - 1n, configAuthority: null, withdrawAuthority: fee, withheld: 0n } });
const wantMint = { feeWallet: fee, name: "Cult", symbol: "CULT", uri: "https://x/t.json", tokenAuthority: "immutable" };
const meta = () => ({ name: "Cult", symbol: "CULT", uri: "https://x/t.json", updateAuthority: null });

test("the mint read-back refuses a mint that could change the rate, mint more, or lose the fee key", () => {
  assert.deepEqual(mintMismatches(goodMint(), wantMint, meta()), []);
  const bad = (patch, re, m = meta()) => assert.ok(mintMismatches({ ...goodMint(), ...patch }, wantMint, m).some((x) => re.test(x)), re.source);
  bad({ mintAuthority: pk() }, /mint authority is .*expected none/);
  bad({ freezeAuthority: pk() }, /freeze authority/);
  bad({ supply: 5n }, /mint supply/);
  bad({ decimals: 9 }, /decimals/);
  bad({ fee: null }, /no transfer fee/);
  bad({ fee: { ...goodMint().fee, bps: 1500 } }, /1500 bps/);
  bad({ fee: { ...goodMint().fee, configAuthority: pk() } }, /fee-config authority .*the rate could change/);
  bad({ fee: { ...goodMint().fee, withdrawAuthority: pk() } }, /withdraw-withheld authority is .*expected the fee wallet/);
  bad({ fee: { ...goodMint().fee, withdrawAuthority: null } }, /withdraw-withheld authority/);
  bad({ fee: { ...goodMint().fee, max: 5n } }, /maximum per transfer/);
  bad({}, /metadata update authority/, { ...meta(), updateAuthority: pk() });
  bad({}, /metadata name/, { ...meta(), name: "Other" });
  bad({}, /metadata uri/, { ...meta(), uri: "https://evil/t.json" });
  bad({}, /no on-chain metadata`?/, null);
  assert.deepEqual(mintMismatches(null, wantMint, null), ["The mint doesn't exist."]);
  // A creator-authority token legitimately keeps its update authority.
  assert.deepEqual(mintMismatches(goodMint(), { ...wantMint, tokenAuthority: "creator" }, { ...meta(), updateAuthority: pk() }), []);
});

test("optsFromArgs needs a key and an RPC, and refuses typos", () => {
  const prev = { ...process.env }; delete process.env.CREATOR_KEY; delete process.env.SOLANA_RPC_URL;
  try {
    assert.throws(() => optsFromArgs(["--rpc", "http://x"]), (e) => e instanceof Refuse && /Give the creator's key/.test(e.message));
    const f = join(root, "c.json"); writeFileSync(f, JSON.stringify([...Keypair.generate().secretKey]));
    assert.throws(() => optsFromArgs(["--keypair", f]), (e) => e instanceof Refuse && /Give the RPC/.test(e.message));
    assert.throws(() => optsFromArgs(["--keypair", f, "--rpc", "http://x", "--teambuy", "1"]), (e) => e instanceof Refuse && /Unknown option --teambuy/.test(e.message));
    const o = optsFromArgs(["--keypair", f, "--rpc", "http://x", "--uri", "https://x/t.json", "--team-buy", "0.5"]);
    assert.equal(o.go, false, "dry run unless --go");
    assert.equal(o.feeWallet.toBase58(), FEE_WALLET);
    assert.equal(o.name, "Cult"); assert.equal(o.tokenAuthority, "immutable"); assert.equal(o.startMcap, 27.96); assert.equal(o.gradMcap, 410.8); assert.equal(o.poolFeeBps, 25);
    assert.equal(o.teamBuyLamports, 500_000_000n);
    assert.throws(() => optsFromArgs(["--keypair", f, "--rpc", "http://x", "--team-buy", "-1"]), (e) => e instanceof Refuse);
    assert.throws(() => optsFromArgs(["--keypair", f, "--rpc", "http://x", "--fee-wallet", "nope"]), (e) => e instanceof Refuse && /--fee-wallet/.test(e.message));
  } finally { process.env = prev; }
});

// ---- migrate -----------------------------------------------------------------------------------------------------------------------
test("curveStatus: not complete, complete, migrated, and exactly at the threshold", () => {
  const c = { migrationQuoteThreshold: 1000n };
  assert.deepEqual(curveStatus({ isMigrated: 0, quoteReserve: 400n, migrationProgress: 0 }, c), { migrated: false, complete: false, quote: 400n, threshold: 1000n, remaining: 600n, progress: 0 });
  assert.equal(curveStatus({ isMigrated: 0, quoteReserve: 999n, migrationProgress: 0 }, c).complete, false);
  assert.equal(curveStatus({ isMigrated: 0, quoteReserve: 1000n, migrationProgress: 3 }, c).complete, true, "exactly the threshold is complete");
  assert.equal(curveStatus({ isMigrated: 0, quoteReserve: 1000n, migrationProgress: 3 }, c).remaining, 0n);
  assert.equal(curveStatus({ isMigrated: 1, quoteReserve: 1100n, migrationProgress: 3 }, c).migrated, true);
});

// ---- fee-ops -----------------------------------------------------------------------------------------------------------------------
const wallet = pk();
const [pda] = PublicKey.findProgramAddressSync([Buffer.from("vault")], pk());
const acct = (patch) => ({ address: pk(), amount: 10n, withheld: 5n, owner: wallet, delegate: null, closeAuthority: null, ...patch });

test("refund verdict follows the rule: on-curve wallet, no delegate, no close authority, something withheld", () => {
  assert.equal(PublicKey.isOnCurve(wallet.toBytes()), true);
  assert.equal(PublicKey.isOnCurve(pda.toBytes()), false);
  assert.deepEqual(refundVerdict(acct({})), { ok: true });
  assert.match(refundVerdict(null).why, /isn't a token account of this coin/);
  const vault = refundVerdict(acct({ owner: pda }));
  assert.equal(vault.ok, false); assert.match(vault.why, /program-owned.*use sweep/);
  assert.match(refundVerdict(acct({ delegate: pk() })).why, /delegate/);
  assert.match(refundVerdict(acct({ closeAuthority: pk() })).why, /close authority/);
  const none = refundVerdict(acct({ withheld: 0n }));
  assert.equal(none.ok, false); assert.equal(none.nothing, true);
});

test("sweep takes only program-owned vaults that hold something, plus the mint; it never names a holder", () => {
  const vault = acct({ owner: pda, withheld: 100n }), empty = acct({ owner: pda, withheld: 0n }), dammVault = acct({ owner: pda, withheld: 7n });
  const g = { baseVaultAcct: vault, dammVaultA: dammVault, mi: { fee: { withheld: 3n } } };
  const p = sweepPlan(g);
  assert.deepEqual(p.sources.map((s) => s.address.toBase58()), [vault.address.toBase58(), dammVault.address.toBase58()]);
  assert.equal(p.total, 110n); assert.equal(p.fromMint, true);
  const q = sweepPlan({ baseVaultAcct: empty, dammVaultA: null, mi: { fee: { withheld: 0n } } });
  assert.deepEqual(q, { sources: [], fromMint: false, total: 0n });
});

// ---- rehearse ----------------------------------------------------------------------------------------------------------------------
test("collectSigs lists landed and resolved-landed transactions only, in time order", () => {
  const s1 = "5".repeat(88), s2 = "6".repeat(88), s3 = "7".repeat(88), s4 = "8".repeat(88);
  writeFileSync(join(root, "a.log"), [
    `2026-11-16T10:00:03.000Z sending buy ${s1}`, `2026-11-16T10:00:04.000Z landed buy ${s1}`,
    `2026-11-16T10:00:01.000Z sending launch ${s2}`, `2026-11-16T10:00:02.000Z landed pool + team buy ${s2}`,
    `2026-11-16T10:00:05.000Z failed sell ${s3}`, `2026-11-16T10:00:06.000Z resolved sweep ${s4} landed`, `2026-11-16T10:00:07.000Z resolved lost ${s3} expired`, "",
  ].join("\n"));
  assert.deepEqual(collectSigs(root).map((x) => [x.label, x.sig]), [["pool + team buy", s2], ["buy", s1], ["sweep", s4]]);
});
