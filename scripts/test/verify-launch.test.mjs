// verify-launch.mjs: every check it prints, every refusal, and that it needs nothing but a read-only RPC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { launchChecks, wantConfig, optsFromArgs, PROD_CONFIG } from "../verify-launch.mjs";
import { SOL_MINT, FEE_WALLET, Refuse } from "../lib/curve.mjs";

const pk = () => Keypair.generate().publicKey;
const fee = pk(), mint = pk(), config = pk(), creator = pk();
const want = wantConfig(fee);
// A config, mint and pool exactly as the design needs them (the same shapes rules.test.mjs feeds launch-curve's read-back).
const conf = () => ({
  quoteMint: SOL_MINT, feeClaimer: fee, leftoverReceiver: fee, tokenType: 1, tokenDecimal: 6, transferFeeFlag: 1, transferFeeBasisPoints: 1000, transferFeeWithheldAuthority: 0,
  migratedTransferFeeAuthorityOption: 0, fixedTokenSupplyFlag: 1, migrationOption: 1, migrationFeeOption: 6, migratedCollectFeeMode: 2, migratedCompoundingFeeBps: 0, migratedPoolFeeBps: 25,
  partnerPermanentLockedLiquidityPercentage: 100, creatorTradingFeePercentage: 0, migrationFeePercentage: 0, tokenUpdateAuthority: want.tokenAuthorityCode, migrationQuoteThreshold: want.thresholdLamports,
  sqrtStartPrice: want.sqrtStartPrice, preMigrationTokenSupply: 10n ** 15n, postMigrationTokenSupply: 10n ** 15n,
});
const mi = () => ({ decimals: 6, supply: 10n ** 15n, mintAuthority: null, freezeAuthority: null, fee: { bps: 1000, max: (1n << 64n) - 1n, configAuthority: null, withdrawAuthority: fee, withheld: 0n } });
const meta = () => ({ name: "Cult", symbol: "CULT", uri: "https://x/t.json", updateAuthority: undefined });
const good = () => ({ mi: mi(), meta: meta(), conf: conf(), pool: { baseMint: mint, config, creator }, poolAddr: pk() });
const o = { mint, config, creator, feeWallet: fee };
const failing = (r, oo = o) => launchChecks(r, oo).filter((c) => c.status === "FAIL").map((c) => c.what);

test("a coin exactly as designed passes every check", () => {
  const checks = launchChecks(good(), o);
  assert.deepEqual(failing(good()), []);
  assert.ok(checks.length >= 5 && checks.every((c) => c.status === "ok"), "mint, config, base mint, config of the pool, creator");
});

test("the pool's creator is the check that tells a copy on our public config from the real coin", () => {
  const copy = { ...good(), pool: { baseMint: mint, config, creator: pk() } };
  const bad = failing(copy);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /created by .*not frz's wallet, so this may be a copy/);
  const notChecked = launchChecks(copy, { ...o, creator: null });
  assert.deepEqual(notChecked.filter((c) => c.status === "FAIL"), [], "no --creator: not checked, and said so");
  assert.ok(notChecked.some((c) => c.status === "note" && /Not checked: give --creator/.test(c.what) && c.what.includes(String(copy.pool.creator))));
});

test("a mint on another config, another base mint, or with no pool fails", () => {
  assert.match(failing({ ...good(), pool: { baseMint: mint, config: pk(), creator } }).join("\n"), /pool is on the config .*a different config, not ours/);
  assert.match(failing({ ...good(), pool: { baseMint: pk(), config, creator } }).join("\n"), /base mint is this mint: it is /);
  assert.match(failing({ ...good(), pool: null, poolAddr: null }).join("\n"), /this mint has no bonding-curve pool/);
  assert.match(failing({ ...good(), conf: null }).join("\n"), /doesn't exist, or isn't owned by the bonding-curve program/);
});

test("the mint's own read-back is part of it: a mint that can be minted or frozen, a fee that can change, another withdraw authority, a metadata update authority", () => {
  const bad = (patch, re, m = meta()) => assert.match(failing({ ...good(), mi: patch === null ? null : { ...mi(), ...patch }, meta: m }).join("\n"), re, re.source);
  bad({ mintAuthority: pk() }, /mint authority is .*expected none/);
  bad({ freezeAuthority: pk() }, /freeze authority/);
  bad({ fee: { ...mi().fee, configAuthority: pk() } }, /fee-config authority .*the rate could change/);
  bad({ fee: { ...mi().fee, bps: 500 } }, /transfer fee is 500 bps/);
  bad({ fee: { ...mi().fee, withdrawAuthority: pk() } }, /withdraw-withheld authority is .*expected the fee wallet/);
  bad({ supply: 5n }, /mint supply/);
  bad({}, /metadata update authority/, { ...meta(), updateAuthority: pk() });
  bad({}, /no on-chain metadata/, null);
  bad(null, /The mint doesn't exist/);
});

test("each config field the design needs is read back, against the fee wallet and the curve it was asked about", () => {
  const bad = (k, v) => failing({ ...good(), conf: { ...conf(), [k]: v } }).join("\n");
  assert.match(bad("feeClaimer", pk()), /config feeClaimer is/);
  assert.match(bad("transferFeeBasisPoints", 500), /transferFeeBasisPoints is 500/);
  assert.match(bad("quoteMint", pk()), /quoteMint/);
  assert.match(bad("migrationQuoteThreshold", 1n), /migrationQuoteThreshold/);
  assert.match(failing(good(), { ...o, feeWallet: pk() }).join("\n"), /config feeClaimer is .*expected/, "another fee wallet than the config names");
  // The curve the config was made with is a setting: the staging test config was 30 / 400, not the production 27.96 / 410.8.
  const other = wantConfig(fee, { startMcap: 30, gradMcap: 400, poolFeeBps: 25 });
  assert.notEqual(other.thresholdLamports, want.thresholdLamports);
  const staging = { ...conf(), migrationQuoteThreshold: other.thresholdLamports, sqrtStartPrice: other.sqrtStartPrice };
  assert.deepEqual(failing({ ...good(), conf: staging }, { ...o, curve: { startMcap: 30, gradMcap: 400, poolFeeBps: 25 } }), []);
  assert.ok(failing({ ...good(), conf: staging }).length >= 1, "and it fails against the production defaults");
});

test("optsFromArgs: the mint is required, the defaults are the production config and the payout wallet, a typo or a bad address is refused", () => {
  const prev = process.env.SOLANA_RPC_URL; delete process.env.SOLANA_RPC_URL;
  try {
    const m = pk().toBase58();
    assert.throws(() => optsFromArgs(["--rpc", "http://x.test"]), (e) => e instanceof Refuse && /--mint/.test(e.message));
    assert.throws(() => optsFromArgs(["--mint", m]), (e) => e instanceof Refuse && /Give the RPC/.test(e.message));
    const d = optsFromArgs(["--rpc", "http://x.test", "--mint", m]);
    assert.equal(d.config.toBase58(), PROD_CONFIG);
    assert.equal(PROD_CONFIG, "3jUuWLhrdao4upGuvC3muRN9cZtP7bSAqDaXsY6QsUfK");
    assert.equal(d.feeWallet.toBase58(), FEE_WALLET);
    assert.equal(d.creator, null);
    assert.deepEqual(d.curve, { startMcap: 27.96, gradMcap: 410.8, poolFeeBps: 25 });
    const c = pk().toBase58(), k = pk().toBase58();
    const full = optsFromArgs(["--rpc", "http://x.test", "--mint", m, "--config", c, "--creator", k, "--fee-wallet", k, "--start-mcap", "30", "--grad-mcap", "400"]);
    assert.deepEqual([full.config.toBase58(), full.creator.toBase58(), full.feeWallet.toBase58(), full.curve.startMcap], [c, k, k, 30]);
    assert.throws(() => optsFromArgs(["--rpc", "http://x.test", "--mint", m, "--go"]), (e) => e instanceof Refuse && /Unknown option --go/.test(e.message), "read only: there is no --go");
    assert.throws(() => optsFromArgs(["--rpc", "http://x.test", "--mint", "nope"]), (e) => e instanceof Refuse && /--mint isn't a Solana address/.test(e.message));
    assert.throws(() => optsFromArgs(["--rpc", "http://x.test", "--mint", m, "--creator", "nope"]), (e) => e instanceof Refuse && /--creator/.test(e.message));
  } finally { if (prev !== undefined) process.env.SOLANA_RPC_URL = prev; }
});
