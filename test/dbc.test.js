// The curve (src/dbc.js): the stage read from the REAL pool and config accounts of the mainnet throwaway token (test/fixtures/
// accounts.json) through the real Meteora SDK, and the migration and fee-claim state machines with a fake SDK client and chain.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import BN from "bn.js";
import bs58 from "bs58";
import { getPlatformProxy } from "wrangler";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { DynamicBondingCurveClient, deriveDammV2PoolAddress, DAMM_V2_MIGRATION_FEE_ADDRESS } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { readCurve, refreshCurve, publicStage, migrate, claimFees, claimDammFees, dbcTick, poolOf, poolRefusal, poolProblem } from "../src/dbc.js";
import { config } from "../src/config.js";
import { sigOf, LockLost } from "../src/chain.js";
import { addr } from "./fakes.js";

const PERSIST = ".wrangler/dbc-test";
const F = JSON.parse(readFileSync(new URL("./fixtures/accounts.json", import.meta.url), "utf8"));
const DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const kp = Keypair.generate(), PAYOUT = kp.publicKey.toBase58();
let proxy, env, S;

before(async () => {
  rmSync(PERSIST, { recursive: true, force: true });
  execSync(`node node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --local --persist-to ${PERSIST}`, { stdio: "ignore", env: { ...process.env, CI: "1" } });
  proxy = await getPlatformProxy({ configPath: "wrangler.jsonc", persist: { path: PERSIST + "/v3" } });
  env = { ...proxy.env, PAYOUT_SECRET_KEY: JSON.stringify([...kp.secretKey]) };
});
after(async () => { await proxy?.dispose(); rmSync(PERSIST, { recursive: true, force: true }); });
beforeEach(async () => { await env.DB.batch(["kv"].map((t) => env.DB.prepare(`DELETE FROM ${t}`))); });

/* ---------- the real SDK on real accounts ---------- */

const byAddr = Object.fromEntries(Object.values(F).map((a) => [a.address, a]));
const realClient = (gpaCalls, gpaFind = (a) => a.address === F.poolDbc.address) => {
  const acct = (a) => ({ data: [a.data, "base64"], executable: false, lamports: a.lamports, owner: a.owner, rentEpoch: 0, space: Buffer.from(a.data, "base64").length });
  const fake = async (_u, init) => {
    const one = (b) => {
      if (b.method === "getProgramAccounts") { // the filters are honoured, like a real node (the SDK asks for two account types and tells them apart by the discriminator)
        gpaCalls?.push(b.params);
        const ok = (a) => (b.params[1].filters || []).every((f) => !f.memcmp || Buffer.from(a.data, "base64").subarray(f.memcmp.offset).subarray(0, bs58.decode(f.memcmp.bytes).length).equals(Buffer.from(bs58.decode(f.memcmp.bytes))));
        return { jsonrpc: "2.0", id: b.id, result: Object.values(F).filter((a) => gpaFind(a) && ok(a)).map((a) => ({ pubkey: a.address, account: acct(a) })) };
      } const a = byAddr[b.params[0]]; return { jsonrpc: "2.0", id: b.id, result: { context: { slot: 1 }, value: a ? { data: [a.data, "base64"], executable: false, lamports: a.lamports, owner: a.owner, rentEpoch: 0, space: Buffer.from(a.data, "base64").length } : null } }; };
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
  };
  return new DynamicBondingCurveClient(new Connection("http://x.test", { commitment: "confirmed", fetch: fake }), "confirmed");
};
const realCfg = config({ MINT: F.mintDbc.address, DBC_CONFIG: F.configDbc.address, PAYOUT_WALLET: PAYOUT });

test("the curve pool address follows from the mint and the config (same as the pool made on mainnet)", () => {
  assert.equal(poolOf(realCfg).toBase58(), F.poolDbc.address);
});

test("readCurve on the real pool: on the curve, 0.0064% of the way to ~86 SOL, price 3.0e-8 SOL (30 SOL market cap), 28,980 lamports of partner fee waiting", async () => {
  const c = await readCurve(env, realCfg, { client: realClient });
  assert.equal(c.stage, "curve");
  assert.equal(c.thresholdLamports, 85_994_066_487);
  assert.equal(c.raisedLamports, 5_485_491);
  assert.equal(c.progressBps, 0);
  assert.ok(Math.abs(c.priceSol - 3.001e-8) < 1e-11, String(c.priceSol));
  assert.equal(c.partnerQuoteFee, 28_980);
  assert.equal(c.migrationFeeOption, 6, "Customizable: the option a transfer-fee coin must use");
  assert.equal(c.feeClaimer, "KDpz3icbjmmib1DDeitywpk6ZdsQckHiqt6hKmKnnaq");
});

test("the Meteora config on chain keeps the fee rate immutable and the withheld authority with the partner (what graduation preserves)", async () => {
  const conf = await realClient().state.getPoolConfig(F.configDbc.address);
  assert.equal(conf.migratedTransferFeeAuthorityOption, 0, "Immutable");
  assert.equal(Number(conf.migrationOption), 1, "DAMM v2");
});

/* ---------- stage logic with a fake client ---------- */

const bn = (n) => new BN(String(n));
const pool = (o = {}) => ({ quoteReserve: bn(o.raised ?? 0), isMigrated: o.migrated ? 1 : 0, migrationProgress: o.progress ?? 0, sqrtPrice: bn("101054067403003490"), partnerQuoteFee: bn(o.fee ?? 0), partnerBaseFee: bn(0) });
const conf = (o = {}) => ({ migrationQuoteThreshold: bn(86_000_000_000), tokenDecimal: 6, migrationFeeOption: 6, feeClaimer: new PublicKey(PAYOUT), quoteMint: new PublicKey("So11111111111111111111111111111111111111112"), ...o });
const dbcIx = (signers, extra = []) => new TransactionInstruction({ programId: new PublicKey(DBC), keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: true }, ...signers.map((k) => ({ pubkey: k.publicKey, isSigner: true, isWritable: true })), ...extra], data: Buffer.from([1]) });
function fresh(over = {}) {
  S = { sent: [], sim: { err: null, gain: 100_000_000n }, sol: 500_000_000n, landed: new Set(), status: () => "wait", migrations: 0, claims: 0, height: 1000, events: [], ...over, pool: pool(over.pool) };
  return {
    client: () => ({
      state: { getPool: async () => ({ poolState: S.pool }), getPoolConfig: async () => conf() },
      migration: { migrateToDammV2: async () => { S.migrations++; const a = Keypair.generate(), b = Keypair.generate(); return { transaction: new Transaction().add(dbcIx([a, b])), firstPositionNftKeypair: a, secondPositionNftKeypair: b }; } },
      partner: { claimPartnerTradingFeeToReceiver: async (p) => { S.claims++; S.lastClaim = p; return new Transaction().add(dbcIx([])); } },
    }),
    blockhash: async () => ({ blockhash: addr(), lastValidBlockHeight: S.height + 150 }),
    send: async (tx) => { S.events.push("send"); S.sent.push(tx); return sigOf(tx); },
    settle: async (items) => Object.fromEntries(items.map((i) => [i.sig, S.status(i.sig)])),
    simulate: async (tx, accounts) => ({ err: S.sim.err, after: new Map(accounts.map((a) => [a, { lamports: S.sol + S.sim.gain, data: new Uint8Array(0) }])), logs: [], units: 1 }),
    solBalance: async () => S.sol,
  };
}
const cfg = (o = {}) => config({ MINT: addr(), DBC_CONFIG: addr(), PAYOUT_WALLET: PAYOUT, DRY_RUN: "0", ...o });
const fence = async () => {};
const kv = async (k) => { const r = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind(k).first(); return r && JSON.parse(r.v); };

test("stage: curve, graduating (curve full, not migrated), graduated (migrated flag or progress 3)", async () => {
  const stage = async (o) => (await readCurve(env, cfg(), fresh({ pool: o }))).stage;
  assert.equal(await stage({ raised: 1 }), "curve");
  assert.equal(await stage({ raised: 85_999_999_999 }), "curve");
  assert.equal(await stage({ raised: 86_000_000_000 }), "graduating");
  assert.equal(await stage({ raised: 90_000_000_000, migrated: true }), "graduated");
  assert.equal(await stage({ raised: 90_000_000_000, progress: 3 }), "graduated");
});

test("publicStage reads only kv, and a read older than 10 minutes is 'unknown'", async () => {
  assert.deepEqual(await publicStage(env.DB), { stage: "unknown" });
  const c = await refreshCurve(env, cfg(), 1_000_000, fresh({ pool: { raised: 43_000_000_000 } }));
  assert.equal(c.progressBps, 5000);
  assert.deepEqual(await publicStage(env.DB, 1_000_000 + 1000), { stage: "curve", progressBps: 5000, raisedSol: 43, thresholdSol: 86, pool: c.pool });
  assert.deepEqual(await publicStage(env.DB, 1_000_000 + 601_000), { stage: "unknown" });
});

test("a failed curve read keeps the last good one; nothing is invented", async () => {
  await refreshCurve(env, cfg(), 1_000, fresh({ pool: { raised: 1 } }));
  const d = fresh(); d.client = () => ({ state: { getPool: async () => { throw new Error("rpc down"); } } });
  assert.equal((await refreshCurve(env, cfg(), 2_000, d)).stage, "curve");
  assert.equal((await kv("curve")).at, 1_000);
});

/* ---------- migration ---------- */

const graduating = async () => { const d = fresh({ pool: { raised: 90_000_000_000 } }); await refreshCurve(env, cfg(), 1_000, d); return d; };

test("migration: only when the curve is full; a dry run only says so", async () => {
  const d = fresh({ pool: { raised: 1 } }); await refreshCurve(env, cfg(), 1_000, d);
  assert.deepEqual(await migrate(env, cfg(), kp, fence, 2_000, d), {});
  const g = await graduating();
  assert.match((await migrate(env, cfg({ DRY_RUN: "1" }), kp, fence, 2_000, g)).migrate, /dry-run/);
  assert.equal(S.sent.length, 0);
});

test("migration: simulated first, saved by signature BEFORE it is sent, signed by the payout wallet and the two position keypairs", async () => {
  const d = await graduating();
  const send = d.send;
  d.send = async (tx) => { const saved = await kv("migrate"); assert.equal(saved.state, "sent"); assert.equal(saved.sig, sigOf(tx), "the signature was in kv when the send happened"); assert.ok(saved.first && saved.second && saved.lvbh); return send(tx); };
  const r = await migrate(env, cfg(), kp, fence, 2_000, d);
  assert.equal(r.migrate, "sent");
  assert.equal(S.sent.length, 1);
  const tx = S.sent[0];
  assert.equal(tx.message.header.numRequiredSignatures, 3);
  assert.ok(tx.signatures.every((s) => s.some((b) => b !== 0)), "all three signatures are present");
  const dammConfigArg = tx.message.compiledInstructions.length;
  assert.ok(dammConfigArg >= 2);
});

test("migration: a transaction already sent is only ever settled, never sent again; failed or lost builds a new one with new keypairs", async () => {
  const d = await graduating();
  await migrate(env, cfg(), kp, fence, 2_000, d);
  const first = await kv("migrate");
  assert.equal((await migrate(env, cfg(), kp, fence, 3_000, d)).migrate, "waiting");
  assert.equal(S.sent.length, 1);
  assert.equal(S.migrations, 1, "not even built again");
  S.status = () => "lost";
  const r = await migrate(env, cfg(), kp, fence, 4_000, d);
  assert.equal(r.migrate, "sent");
  assert.equal(S.sent.length, 2);
  const second = await kv("migrate");
  assert.notEqual(second.sig, first.sig);
  assert.notEqual(second.first, first.first, "new position NFT keypairs");
  S.status = () => "confirmed";
  assert.equal((await migrate(env, cfg(), kp, fence, 5_000, d)).migrate, "done");
  assert.equal((await migrate(env, cfg(), kp, fence, 6_000, d)).migrate, "done");
  assert.equal(S.sent.length, 2);
});

test("migration: a failing simulation sends nothing; so does a payout wallet short of SOL", async () => {
  const d = await graduating();
  S.sim.err = { InstructionError: [0, "Custom"] };
  assert.equal((await migrate(env, cfg(), kp, fence, 2_000, d)).migrate, "simulation failed");
  S.sim.err = null; S.sol = 10_000_000n;
  assert.equal((await migrate(env, cfg(), kp, fence, 2_000, d)).migrate, "needs SOL");
  assert.equal(S.sent.length, 0);
  assert.equal(await kv("migrate"), null);
});

test("migration: once the keeper or someone else has migrated, we do nothing", async () => {
  const d = fresh({ pool: { raised: 90_000_000_000, migrated: true } });
  await refreshCurve(env, cfg(), 1_000, d);
  assert.deepEqual(await migrate(env, cfg(), kp, fence, 2_000, d), {});
  assert.equal(S.migrations, 0);
});

test("migration: AUTO_MIGRATE=0 leaves it to an operator", async () => {
  const d = await graduating();
  const out = await dbcTick(env, cfg({ AUTO_MIGRATE: "0" }), kp, fence, 2_000, d);
  assert.equal(S.migrations, 0);
  assert.match(out.migrate, /AUTO_MIGRATE is off/);
});

/* ---------- partner fees ---------- */

const fees = async (fee) => { const d = fresh({ pool: { raised: 1_000_000_000, fee } }); await refreshCurve(env, cfg(), 1_000, d); return d; };

test("claim: below 0.005 SOL nothing; above, one claim to the payout wallet, simulated, saved before it is sent", async () => {
  assert.deepEqual(await claimFees(env, cfg(), kp, fence, 10_000, await fees(4_000_000)), {});
  const d = await fees(50_000_000);
  const send = d.send;
  d.send = async (tx) => { assert.equal((await kv("claim")).sig, sigOf(tx)); return send(tx); };
  assert.equal((await claimFees(env, cfg(), kp, fence, 10_000, d)).claim, "sent");
  assert.equal(S.claims, 1);
  assert.equal(S.lastClaim.receiver.toBase58(), PAYOUT, "the receiver is the payout wallet");
  assert.equal(S.lastClaim.maxQuoteAmount.toString(), "50000000");
});

test("claim: hourly, never while one is in flight, and a simulation that doesn't raise the balance is not sent", async () => {
  const d = await fees(50_000_000);
  await claimFees(env, cfg(), kp, fence, 10_000, d);
  assert.equal((await claimFees(env, cfg(), kp, fence, 20_000, d)).claim, "waiting");
  S.status = () => "confirmed";
  assert.equal((await claimFees(env, cfg(), kp, fence, 30_000, d)).claim, "confirmed");
  assert.deepEqual(await claimFees(env, cfg(), kp, fence, 40_000, d), {}, "not again inside the hour");
  S.sim.gain = 0n; S.sent.length = 0;
  assert.equal((await claimFees(env, cfg(), kp, fence, 10_000 + 3_700_000, d)).claim, "simulation failed");
  assert.equal(S.sent.length, 0);
  assert.equal((await claimFees(env, cfg({ DRY_RUN: "1" }), kp, fence, 10_000 + 7_400_000, d))?.claim, undefined, "dry run claims nothing");
});

test("dbcTick: an exception in one step is logged and never stops the round", async () => {
  const d = await graduating();
  d.client = () => ({ state: { getPool: async () => ({ poolState: pool({ raised: 90_000_000_000 }) }), getPoolConfig: async () => conf() }, migration: { migrateToDammV2: async () => { throw new Error("sdk blew up"); } }, partner: {} });
  const out = await dbcTick(env, cfg(), kp, fence, 2_000, d);
  assert.equal(out.stage, "graduating");
});

/* ---------- what the SDK hands back is checked, and every send is fenced and saved first ---------- */

test("an SDK transaction with an instruction for a program we don't expect, or a signer we don't hold, is refused: nothing saved, nothing sent", async () => {
  const foreign = new Transaction().add(new TransactionInstruction({ programId: new PublicKey(addr()), keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([1]) }));
  const stranger = Keypair.generate();
  const unknownSigner = (a, b) => new Transaction().add(dbcIx([a, b, stranger]));
  for (const [name, mig, claim, re] of [
    ["unexpected program", async () => ({ transaction: foreign, firstPositionNftKeypair: Keypair.generate(), secondPositionNftKeypair: Keypair.generate() }), async () => foreign, /unexpected program/],
    ["signer we don't hold", async () => { const a = Keypair.generate(), b = Keypair.generate(); return { transaction: unknownSigner(a, b), firstPositionNftKeypair: a, secondPositionNftKeypair: b }; }, async () => new Transaction().add(dbcIx([stranger])), /signer we don't hold/],
  ]) {
    await env.DB.prepare("DELETE FROM kv WHERE k IN ('migrate', 'claim')").run();
    const g = await graduating(); const base = g.client;
    g.client = () => ({ ...base(), migration: { migrateToDammV2: mig } });
    await assert.rejects(migrate(env, cfg(), kp, fence, 2_000, g), re, name);
    assert.equal(await kv("migrate"), null, name);
    const f = await fees(50_000_000); const fb = f.client;
    f.client = () => ({ ...fb(), partner: { claimPartnerTradingFeeToReceiver: claim } });
    await assert.rejects(claimFees(env, cfg(), kp, fence, 10_000, f), re, name);
    assert.equal(await kv("claim"), null, name);
    assert.equal(S.sent.length, 0, name);
  }
});

test("migration and claim call the fence before they save, and a lost lock stops them with nothing saved or sent", async () => {
  const lost = async () => { throw new LockLost("lost the tick lock"); };
  const g = await graduating();
  await assert.rejects(migrate(env, cfg(), kp, lost, 2_000, g), LockLost);
  assert.equal(await kv("migrate"), null);
  const f = await fees(50_000_000);
  await assert.rejects(claimFees(env, cfg(), kp, lost, 10_000, f), LockLost);
  assert.equal(await kv("claim"), null);
  assert.equal(S.sent.length, 0);
  await env.DB.prepare("DELETE FROM kv").run();
  const g2 = await graduating();
  await assert.rejects(dbcTick(env, cfg(), kp, lost, 2_000, g2), LockLost, "dbcTick lets a lost lock through; only other errors are swallowed");
});

test("two migrations at once: one is sent, the other finds it has lost the claim", async () => {
  const d = await graduating();
  const [a, b] = await Promise.all([migrate(env, cfg(), kp, fence, 2_000, d), migrate(env, cfg(), kp, fence, 2_000, d)]);
  assert.deepEqual([a.migrate, b.migrate].sort(), ["another run has it", "sent"]);
  assert.equal(S.sent.length, 1);
});

/* ---------- the pool and config come from the chain: MINT alone is enough ---------- */

test("DBC_CONFIG unset: the curve is found from the mint alone (the real SDK, one getProgramAccounts by base mint), its config read from the pool, and remembered", async () => {
  const calls = [], cfgNoConfig = config({ MINT: F.mintDbc.address, PAYOUT_WALLET: PAYOUT });
  assert.equal(cfgNoConfig.dbcConfig, "");
  const c = await readCurve(env, cfgNoConfig, { client: () => realClient(calls) });
  assert.equal(c.pool, F.poolDbc.address);
  assert.equal(c.stage, "curve");
  assert.equal(c.thresholdLamports, 85_994_066_487, "the threshold of the config the pool names");
  assert.equal(c.feeClaimer, "KDpz3icbjmmib1DDeitywpk6ZdsQckHiqt6hKmKnnaq");
  assert.equal(calls.length, 2, "the SDK asks for the two kinds of pool (plain and with a transfer hook) in one go");
  assert.ok(calls.every((x) => x[1].filters.some((f) => f.memcmp.bytes === F.mintDbc.address)), "both filtered by the mint");
  const creator = (await realClient().state.getPool(F.poolDbc.address)).poolState.creator.toBase58();
  assert.deepEqual(await kv("curve_pool"), { mint: F.mintDbc.address, pool: F.poolDbc.address, config: F.configDbc.address, creator }, "the creator is remembered with the pool, so a CREATOR set later is checked");
  await readCurve(env, cfgNoConfig, { client: () => realClient(calls) });
  assert.equal(calls.length, 2, "found once, then remembered");
  const other = config({ MINT: F.mintDamm.address, PAYOUT_WALLET: PAYOUT });
  await assert.rejects(readCurve(env, other, { client: () => realClient(calls, () => false) }), /isn't on chain yet/, "another mint is looked up again, and a coin with no curve is an error, not a guess");
  assert.equal(calls.length, 4);
});

test("DBC_CONFIG unset: refreshCurve keeps the stage for the site, and a curve that is not quoted in SOL is refused", async () => {
  const cfgNoConfig = config({ MINT: F.mintDbc.address, PAYOUT_WALLET: PAYOUT });
  const c = await refreshCurve(env, cfgNoConfig, 1_000, { client: () => realClient() });
  assert.equal(c.stage, "curve");
  assert.equal((await publicStage(env.DB, 2_000)).stage, "curve");
  await env.DB.prepare("DELETE FROM kv").run();
  const d = fresh({ pool: { raised: 1 } }), base = d.client;
  d.client = () => { const x = base(); return { ...x, state: { ...x.state, getPoolByBaseMint: async () => ({ publicKey: new PublicKey(addr()), account: { poolState: { config: new PublicKey(addr()) } } }), getPoolConfig: async () => conf({ quoteMint: new PublicKey(addr()) }) } }; };
  await assert.rejects(readCurve(env, config({ MINT: addr(), PAYOUT_WALLET: PAYOUT }), d), /isn't quoted in SOL/);
  assert.equal(await refreshCurve(env, config({ MINT: addr(), PAYOUT_WALLET: PAYOUT }), 3_000, d), null, "nothing known: nothing shown");
});

/* ---------- review 2, N4: the pool must be the one we launched (the DBC config is public) ---------- */

const CONF = addr(), CREATOR_A = addr(), CREATOR_B = addr();
const ps = (config, creator) => ({ config: new PublicKey(config), creator: new PublicKey(creator) });
// A fresh() client whose getPoolByBaseMint answers with `state` (null: no pool), counting the asks.
const withPoolByMint = (d, state, calls = []) => {
  const base = d.client;
  d.client = () => { const x = base(); return { ...x, state: { ...x.state, getPoolByBaseMint: async (m) => { calls.push(m); return state && { publicKey: new PublicKey(addr()), account: { poolState: state } }; } } }; };
  return d;
};

test("poolRefusal: DBC_CONFIG and CREATOR are checked only when set; a pool that differs, or whose answer is missing, is refused", () => {
  assert.equal(poolRefusal(config({}), ps(CONF, CREATOR_A)), null, "nothing set: today's behaviour");
  assert.equal(poolRefusal(config({}), undefined), null);
  assert.equal(poolRefusal(config({ DBC_CONFIG: CONF }), ps(CONF, CREATOR_B)), null);
  assert.match(poolRefusal(config({ DBC_CONFIG: CONF }), ps(addr(), CREATOR_A)), /not the DBC_CONFIG/);
  assert.equal(poolRefusal(config({ CREATOR: CREATOR_A }), ps(addr(), CREATOR_A)), null, "any config when only CREATOR is set");
  assert.match(poolRefusal(config({ CREATOR: CREATOR_A }), ps(CONF, CREATOR_B)), /was made by .*not the CREATOR/);
  assert.equal(poolRefusal(config({ DBC_CONFIG: CONF, CREATOR: CREATOR_A }), { config: CONF, creator: CREATOR_A }), null, "saved records hold base58 strings");
  assert.match(poolRefusal(config({ DBC_CONFIG: CONF, CREATOR: CREATOR_A }), ps(CONF, CREATOR_B)), /CREATOR/);
  assert.match(poolRefusal(config({ DBC_CONFIG: CONF }), {}), /not the DBC_CONFIG/, "unknown is a refusal");
  assert.match(poolRefusal(config({ CREATOR: CREATOR_A }), null), /CREATOR/);
});

test("poolProblem (the tick's start-up check): nothing set reads nothing; set, the pool the mint really has must match, and anything unknown refuses", async () => {
  const calls = [], mint = addr();
  const ask = (vars, d) => poolProblem(env, config({ MINT: mint, PAYOUT_WALLET: PAYOUT, ...vars }), d);
  assert.equal(await ask({}, withPoolByMint(fresh(), ps(addr(), CREATOR_B), calls)), null);
  assert.equal(calls.length, 0, "no DBC_CONFIG and no CREATOR: no read");
  assert.equal(await ask({ DBC_CONFIG: CONF, CREATOR: CREATOR_A }, withPoolByMint(fresh(), ps(CONF, CREATOR_A), calls)), null);
  assert.deepEqual(calls, [mint], "asked for the pool by the mint");
  assert.match(await ask({ CREATOR: CREATOR_A }, withPoolByMint(fresh(), ps(CONF, CREATOR_B))), /made by .*not the CREATOR/, "a stranger's copy on our own config");
  assert.match(await ask({ DBC_CONFIG: CONF }, withPoolByMint(fresh(), ps(addr(), CREATOR_A))), /not the DBC_CONFIG/, "the mint is on another config");
  assert.match(await ask({ CREATOR: CREATOR_A }, withPoolByMint(fresh(), null)), /isn't on chain yet/);
  const down = fresh(), base = down.client;
  down.client = () => ({ ...base(), state: { getPoolByBaseMint: async () => { throw new Error("rpc down"); } } });
  assert.match(await ask({ CREATOR: CREATOR_A }, down), /Couldn't read the curve pool .*rpc down/);
});

test("locate: a pool found from the mint is refused when its creator or config isn't ours, and a refused pool is never remembered; a saved pool is trusted only for the settings it was checked under", async () => {
  const mint = addr(), calls = [];
  const read = (vars, d) => readCurve(env, config({ MINT: mint, PAYOUT_WALLET: PAYOUT, ...vars }), d);
  await assert.rejects(read({ CREATOR: CREATOR_A }, withPoolByMint(fresh({ pool: { raised: 1 } }), ps(CONF, CREATOR_B), calls)), /made by .*not the CREATOR/);
  assert.equal(await kv("curve_pool"), null, "never remembered");
  const c = await read({ CREATOR: CREATOR_A }, withPoolByMint(fresh({ pool: { raised: 1 } }), ps(CONF, CREATOR_A), calls));
  assert.equal(c.stage, "curve");
  assert.equal((await kv("curve_pool")).creator, CREATOR_A);
  assert.equal(calls.length, 2);
  await read({ CREATOR: CREATOR_A }, withPoolByMint(fresh({ pool: { raised: 1 } }), ps(CONF, CREATOR_A), calls));
  assert.equal(calls.length, 2, "remembered for the same settings");
  await read({ CREATOR: CREATOR_B }, withPoolByMint(fresh({ pool: { raised: 1 } }), ps(CONF, CREATOR_B), calls));
  assert.equal(calls.length, 3, "a CREATOR the saved pool wasn't checked under is not trusted: the pool is looked up again");
  assert.equal((await kv("curve_pool")).creator, CREATOR_B);
  // A record saved before the creator was kept does not satisfy a CREATOR either.
  await env.DB.prepare("DELETE FROM kv").run();
  await env.DB.prepare("INSERT INTO kv (k, v, at) VALUES ('curve_pool', ?, 1)").bind(JSON.stringify({ mint, pool: addr(), config: CONF })).run();
  await assert.rejects(read({ CREATOR: CREATOR_A }, withPoolByMint(fresh({ pool: { raised: 1 } }), ps(CONF, CREATOR_B), calls)), /made by/);
  assert.equal(calls.length, 4);
});

/* ---------- review 2, N7: after graduation the hourly claim takes the locked position's SOL fees ---------- */

const DAMM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
const zero32 = () => Array(32).fill(0);
// getUnClaimLpFee (the real SDK function) over states with no liquidity: the pending fee is exactly feeBPending.
const positionOf = (feeB) => ({ position: new PublicKey(addr()), positionNftAccount: new PublicKey(addr()), positionState: {
  unlockedLiquidity: bn(0), vestedLiquidity: bn(0), permanentLockedLiquidity: bn(0), feeAPerTokenCheckpoint: zero32(), feeBPerTokenCheckpoint: zero32(), feeAPending: bn(0), feeBPending: bn(feeB), rewardInfos: [] } });
const dammPool = () => ({ feeAPerLiquidity: zero32(), feeBPerLiquidity: zero32(), tokenAMint: new PublicKey(addr()), tokenBMint: new PublicKey("So11111111111111111111111111111111111111112"), tokenAVault: new PublicKey(addr()), tokenBVault: new PublicKey(addr()), rewardInfos: [] });
const dammIx = (program = DAMM) => new TransactionInstruction({ programId: new PublicKey(program), keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([2]) });
function withDamm(d, { positions = [], poolFails = false, program } = {}) {
  S.damm = { reads: 0, listed: 0, claims: [] };
  d.cp = () => ({
    fetchPoolState: async (p) => { S.damm.reads++; S.damm.pool = p; if (poolFails) throw new Error("account not found"); return dammPool(); },
    getUserPositionByPool: async (p, owner) => { S.damm.listed++; S.damm.owner = owner; return positions; },
    claimPositionFee: async (params) => { S.damm.claims.push(params); return new Transaction().add(dammIx(program)); },
  });
  return d;
}
const graduated = async (over = {}) => { const d = fresh({ pool: { raised: 90_000_000_000, migrated: true, ...over } }); await refreshCurve(env, cfg(), 1_000, d); return d; };
const quiet = async (f) => { const log = console.error; console.error = () => {}; try { return await f(); } finally { console.error = log; } };

test("claim_damm: after graduation the position's SOL fees go to the payout wallet: the position owned by the payout wallet, simulated, saved by signature BEFORE it is sent", async () => {
  const positions = [positionOf(50_000_000)];
  const d = withDamm(await graduated(), { positions }), send = d.send;
  d.send = async (tx) => { assert.equal((await kv("claim_damm")).sig, sigOf(tx), "the signature was in kv when the send happened"); return send(tx); };
  const c = cfg();
  const r = await claimDammFees(env, c, kp, fence, 10_000, d);
  assert.equal(r.claim_damm, "sent");
  assert.equal(S.sent.length, 1);
  assert.equal(S.damm.owner.toBase58(), PAYOUT, "positions are listed for the payout wallet");
  const p = S.damm.claims[0];
  assert.equal(p.owner.toBase58(), PAYOUT);
  assert.equal(p.position.toBase58(), positions[0].position.toBase58());
  assert.equal(p.pool.toBase58(), deriveDammV2PoolAddress(new PublicKey(DAMM_V2_MIGRATION_FEE_ADDRESS[6]), new PublicKey(c.mint), new PublicKey("So11111111111111111111111111111111111111112")).toBase58(), "the DAMM pool follows from the mint and the migration fee option");
  assert.equal((await kv("claim_damm")).amount, 50_000_000);
  assert.equal(await kv("claim"), null, "the curve's own claim has its own row");
  assert.equal(S.sent[0].message.header.numRequiredSignatures, 1);
});

test("claim_damm: only after graduation, never in a dry run, and an idle look costs no RPC for the next hour", async () => {
  const before = withDamm(await (async () => { const d = fresh({ pool: { raised: 1_000_000_000, fee: 50_000_000 } }); await refreshCurve(env, cfg(), 1_000, d); return d; })(), { positions: [positionOf(50_000_000)] });
  assert.deepEqual(await claimDammFees(env, cfg(), kp, fence, 10_000, before), {}, "the curve isn't graduated");
  assert.equal(S.damm.reads, 0);
  assert.equal(await kv("claim_damm"), null, "nothing is written while it doesn't apply");
  const dry = withDamm(await graduated(), { positions: [positionOf(50_000_000)] });
  assert.deepEqual(await claimDammFees(env, cfg({ DRY_RUN: "1" }), kp, fence, 10_000, dry), {});
  assert.equal(S.damm.reads + S.sent.length, 0);
  // Below 0.005 SOL: nothing, and the next look is an hour away.
  const small = withDamm(await graduated(), { positions: [positionOf(4_999_999)] });
  assert.deepEqual(await claimDammFees(env, cfg(), kp, fence, 20_000, small), {});
  assert.equal(S.damm.reads, 1);
  assert.deepEqual(await claimDammFees(env, cfg(), kp, fence, 20_000 + 30 * 60_000, small), {});
  assert.equal(S.damm.reads, 1, "not looked at again inside the hour");
  assert.deepEqual(await claimDammFees(env, cfg(), kp, fence, 20_000 + 61 * 60_000, small), {});
  assert.equal(S.damm.reads, 2);
  assert.equal(S.sent.length, 0);
  S.damm.claims.length = 0;
});

test("claim_damm: one position a claim, the one with the most SOL waiting; hourly, never while one is in flight, settled from its signature", async () => {
  const positions = [positionOf(10_000_000), positionOf(80_000_000), positionOf(20_000_000)];
  const d = withDamm(await graduated(), { positions });
  assert.equal((await claimDammFees(env, cfg(), kp, fence, 10_000, d)).claim_damm, "sent");
  assert.equal(S.damm.claims[0].position.toBase58(), positions[1].position.toBase58());
  assert.equal((await kv("claim_damm")).amount, 80_000_000);
  assert.equal((await claimDammFees(env, cfg(), kp, fence, 20_000, d)).claim_damm, "waiting");
  assert.equal(S.sent.length, 1, "never sent twice");
  S.status = () => "confirmed";
  assert.equal((await claimDammFees(env, cfg(), kp, fence, 30_000, d)).claim_damm, "confirmed");
  assert.deepEqual(await claimDammFees(env, cfg(), kp, fence, 40_000, d), {}, "not again inside the hour");
  assert.equal((await claimDammFees(env, cfg(), kp, fence, 10_000 + 3_700_000, d)).claim_damm, "sent", "the next hour");
  assert.equal(S.sent.length, 2);
});

test("claim_damm: a pool or a position list that can't be read is nothing to claim (logged, nothing sent); a simulation without a SOL gain is not sent; a foreign program is refused", async () => {
  const d = withDamm(await graduated(), { poolFails: true });
  assert.deepEqual(await quiet(() => claimDammFees(env, cfg(), kp, fence, 10_000, d)), {});
  assert.equal(S.sent.length, 0);
  const e = withDamm(await graduated(), { positions: [positionOf(50_000_000)] });
  S.sim.gain = 0n;
  assert.equal((await quiet(() => claimDammFees(env, cfg(), kp, fence, 20_000 + 3_700_000, e))).claim_damm, "simulation failed");
  assert.equal(S.sent.length, 0);
  assert.equal(await kv("claim_damm") === null || (await kv("claim_damm")).state !== "sent", true, "nothing was saved as sent");
  await env.DB.prepare("DELETE FROM kv WHERE k = 'claim_damm'").run();
  const f = withDamm(await graduated(), { positions: [positionOf(50_000_000)], program: addr() });
  await assert.rejects(claimDammFees(env, cfg(), kp, fence, 30_000, f), /unexpected program/);
  assert.equal(await kv("claim_damm"), null);
  assert.equal(S.sent.length, 0);
  const lost = async () => { throw new LockLost("lost the tick lock"); };
  const g = withDamm(await graduated(), { positions: [positionOf(50_000_000)] });
  await assert.rejects(claimDammFees(env, cfg(), kp, lost, 40_000, g), LockLost);
  assert.equal(await kv("claim_damm"), null, "the fence runs before anything is saved");
  assert.equal(S.sent.length, 0);
});

test("dbcTick: the curve's claim and the position's claim are separate steps: one failing never stops the other", async () => {
  const d = withDamm(await graduated({ fee: 50_000_000 }), { positions: [positionOf(50_000_000)] });
  const out = await dbcTick(env, cfg(), kp, fence, 5_000, d);
  assert.equal(out.claim, "sent");
  assert.equal(out.claim_damm, "sent");
  assert.equal(S.sent.length, 2);
  await env.DB.prepare("DELETE FROM kv WHERE k IN ('claim', 'claim_damm')").run();
  const e = withDamm(await graduated({ fee: 50_000_000 }), { positions: [positionOf(50_000_000)] }), base = e.client;
  e.client = () => { const x = base(); return { ...x, partner: { claimPartnerTradingFeeToReceiver: async () => { throw new Error("sdk blew up"); } } }; };
  S.sent.length = 0;
  const out2 = await quiet(() => dbcTick(env, cfg(), kp, fence, 5_000, e));
  assert.equal(out2.claim, undefined);
  assert.equal(out2.claim_damm, "sent", "the position's claim still ran");
  assert.equal(S.sent.length, 1);
});
