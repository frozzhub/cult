// QUOTE_MINT = USDC: the curve is quoted in USDC instead of SOL (src/config.js quoteSym). What changes, and what must not:
//   the pool is derived from the configured quote mint and a curve quoted in anything else is refused (the real SDK on a real
//   USDC-quoted config and pool, test/fixtures/usdc-accounts.json); the curve's fee claims are measured in the payout wallet's USDC
//   account, never its lamports; the round sells the treasury's CULT but not SOL (the SOL is the team's gas float) and pays the
//   whole USDC balance; trades are recorded in quote units without needing a SOL price; /api/state shows the curve in dollars.
// SOL stays the default: each USDC test that changes behaviour has its SOL twin next to it. Same harness as the other round tests.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import BN from "bn.js";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { DynamicBondingCurveClient, deriveDammV2PoolAddress, DAMM_V2_MIGRATION_FEE_ADDRESS, getSqrtPriceFromPrice } from "@meteora-ag/dynamic-bonding-curve-sdk";
import worker from "../src/index.js";
import { tick, cachedPrices, recordTrade, pollMint } from "../src/indexer.js";
import { readCurve, refreshCurve, publicStage, claimFees, claimDammFees, poolOf } from "../src/dbc.js";
import { config, quoteUsd, SOL_MINT, USDC_MINT } from "../src/config.js";
import { sigOf, usdcAta } from "../src/chain.js";
import { treasuryAta, feeOn } from "../src/token22.js";
import { addr, tokenAccount, SOL } from "./fakes.js";
import { TOK, makeVault, CLEAR, boot, freshS, isSwap, touches, enhancedSell, postHook, installFakes, fastTimers } from "./engine-fakes.js";

const PERSIST = ".wrangler/usdc-quote-test";
const DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", DAMM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
const kp = Keypair.generate();
const MINT = addr(), PAYOUT = kp.publicKey.toBase58(), VAULT = makeVault();
const TREASURY = treasuryAta(MINT, PAYOUT).toBase58();
const PERIOD = 10 * 60_000; // DROP_MINUTES=10; 6 decimals; $0.001/token; SOL $200
const T0 = Math.floor(Date.now() / PERIOD) * PERIOD + 30_000;

let proxy, env, envS, envU, S, restoreFetch, restoreTimers; // envS, envU: the same environment with the quote named: SOL, and USDC
before(async () => {
  restoreTimers = fastTimers(); // the swap waits 2.5 s a look: don't
  ({ proxy, env } = await boot(PERSIST, { MINT, PAYOUT, kp, MAX_SWAP_IMPACT_BPS: "300", MIN_SWAP_USD: "1" }));
  envS = { ...env, QUOTE_MINT: "" }; // named, so what a deploy puts in wrangler.jsonc for QUOTE_MINT can't change a test
  envU = { ...env, QUOTE_MINT: USDC_MINT };
  restoreFetch = installFakes({ S: () => S, MINT, PAYOUT, env: () => env });
});
after(async () => { await proxy?.dispose(); restoreFetch?.(); restoreTimers?.(); });
beforeEach(async () => {
  S = freshS({ PAYOUT, vault: VAULT });
  await env.DB.batch(CLEAR.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

const first = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const kv = async (k) => { const r = await first("SELECT v FROM kv WHERE k = ?", k); return r && JSON.parse(r.v); };
const drop = () => first("SELECT * FROM drops");
const quiet = async (f) => { const log = console.error; console.error = () => {}; try { return await f(); } finally { console.error = log; } };

/* ---------------- the setting ---------------- */

test("QUOTE_MINT: unset or empty is SOL (today's behaviour), the USDC mint is USDC with six decimals, anything else is no quote at all", () => {
  for (const c of [config({}), config({ QUOTE_MINT: "" })]) assert.deepEqual([c.quoteMint, c.quoteSym, c.quoteDecimals], [SOL_MINT, "SOL", 9]);
  const u = config({ QUOTE_MINT: USDC_MINT });
  assert.deepEqual([u.quoteMint, u.quoteSym, u.quoteDecimals], [USDC_MINT, "USDC", 6]);
  assert.equal(USDC_MINT, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(config({ QUOTE_MINT: addr() }).quoteSym, "", "a quote we don't know is refused, not guessed");
  const stand = addr(); // devnet's stand-in USDC (env.USDC_MINT) is the USDC of that deployment, and the real one is not
  assert.equal(config({ USDC_MINT: stand, QUOTE_MINT: stand }).quoteSym, "USDC");
  assert.equal(config({ USDC_MINT: stand, QUOTE_MINT: USDC_MINT }).quoteSym, "");
});

test("quoteUsd: SOL's price for a SOL curve, exactly 1 for USDC (a dollar needs no price feed)", () => {
  assert.equal(quoteUsd(config({}), { sol: 200, token: 0.001 }), 200);
  assert.equal(quoteUsd(config({ QUOTE_MINT: USDC_MINT }), { sol: 200, token: 0.001 }), 1);
  assert.equal(quoteUsd(config({ QUOTE_MINT: USDC_MINT }), { sol: 0, token: 0.001 }), 1, "SOL's price unknown changes nothing");
  assert.equal(quoteUsd(config({}), { sol: 0, token: 0.001 }), 0, "...and with a SOL curve it stays unknown");
});

/* ---------------- the pool, from the quote mint ---------------- */

const U = JSON.parse(readFileSync(new URL("./fixtures/usdc-accounts.json", import.meta.url), "utf8"));
const byAddr = { [U.configUsdc.address]: U.configUsdc, [U.poolUsdc.address]: U.poolUsdc };
// The real SDK over real accounts: a mainnet DBC config quoted in USDC (6 decimals, classic SPL Token) and a pool on it.
const realClient = () => {
  const acct = (a) => (a ? { data: [a.data, "base64"], executable: false, lamports: a.lamports, owner: a.owner, rentEpoch: 0, space: Buffer.from(a.data, "base64").length } : null);
  const fake = async (_u, init) => {
    const one = (b) => ({ jsonrpc: "2.0", id: b.id, result: { context: { slot: 1 }, value: acct(byAddr[b.params[0]]) } });
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
  };
  return new DynamicBondingCurveClient(new Connection("http://x.test", { commitment: "confirmed", fetch: fake }), "confirmed");
};
const FIXTURE_MINT = (await realClient().state.getPool(U.poolUsdc.address)).poolState.baseMint.toBase58();
const usdcCfg = (o = {}) => config({ MINT: FIXTURE_MINT, DBC_CONFIG: U.configUsdc.address, PAYOUT_WALLET: PAYOUT, QUOTE_MINT: USDC_MINT, ...o });

// The seeds the program uses (config, then the larger of the two mints, then the smaller), written out here rather than taken from the SDK.
const poolSeeds = (conf, quote, base) => {
  const [a, b] = [new PublicKey(quote).toBuffer(), new PublicKey(base).toBuffer()];
  const [hi, lo] = Buffer.compare(a, b) === 1 ? [a, b] : [b, a];
  return PublicKey.findProgramAddressSync([Buffer.from("pool"), new PublicKey(conf).toBuffer(), hi, lo], new PublicKey(DBC))[0].toBase58();
};

test("poolOf: the pool follows from the configured quote mint: it is the address of a real mainnet USDC pool, and not the SOL one", () => {
  assert.equal(poolOf(usdcCfg()).toBase58(), U.poolUsdc.address, "a pool made on mainnet on a USDC config, found from its base mint and config");
  assert.notEqual(poolOf(usdcCfg({ QUOTE_MINT: "" })).toBase58(), U.poolUsdc.address, "the same mint and config with a SOL quote is another address");
  const mint = addr(), dbcConfig = addr();
  assert.equal(poolOf(config({ MINT: mint, DBC_CONFIG: dbcConfig })).toBase58(), poolSeeds(dbcConfig, SOL_MINT, mint));
  assert.equal(poolOf(config({ MINT: mint, DBC_CONFIG: dbcConfig, QUOTE_MINT: USDC_MINT })).toBase58(), poolSeeds(dbcConfig, USDC_MINT, mint));
});

test("readCurve on a real USDC-quoted pool: dollars raised against the threshold, the price per coin in USDC, the stage", async () => {
  const c = await readCurve(env, usdcCfg(), { client: realClient });
  assert.equal(c.pool, U.poolUsdc.address);
  assert.equal(c.stage, "curve");
  assert.deepEqual([c.quote, c.quoteDecimals], ["USDC", 6]);
  assert.equal(c.raisedLamports, 18_134_242, "USDC micro: $18.13 raised");
  assert.equal(c.thresholdLamports, 15_390_982_211, "USDC micro: $15,390.98 to graduate");
  assert.equal(c.progressBps, 11);
  assert.equal(c.partnerQuoteFee, 0);
  assert.equal(c.feeClaimer, "CWcERiVd7xkUrcJK5QBdcKC5GG8JMATMLNHtCEUguwPz");
  // Price per whole coin in whole USDC: (sqrtPrice / 2^64)^2 raw USDC per raw coin, both with six decimals, so the same number.
  const sqrt = 41387802495821920n, want = Number((sqrt * sqrt * 10n ** 18n) / 2n ** 128n) / 1e18;
  assert.ok(Math.abs(c.priceSol / want - 1) < 1e-9, `${c.priceSol} vs ${want}`);
  assert.ok(c.priceSol > 4e-6 && c.priceSol < 6e-6, "about $5,000 of market cap on a billion coins, not 1000 times that");
});

test("a curve quoted in the other token, or in neither, is refused, whichever way round", async () => {
  // The real USDC pool again: a SOL deployment derives a SOL-quoted pool address, which isn't on chain, so it is refused one step earlier.
  await assert.rejects(readCurve(env, usdcCfg({ QUOTE_MINT: "" }), { client: realClient }), /isn't on chain yet/);
  // The quote check itself, with a pool at the derived address and a config that names another quote:
  const quotedIn = (mint) => { const d = fresh(), base = d.client; d.client = () => { const x = base(); return { ...x, state: { ...x.state, getPoolConfig: async () => usdcConf({ quoteMint: new PublicKey(mint) }) } }; }; return d; };
  const cfgOf = (vars) => config({ MINT: addr(), DBC_CONFIG: addr(), PAYOUT_WALLET: PAYOUT, ...vars });
  await assert.rejects(readCurve(env, cfgOf({}), quotedIn(USDC_MINT)), /isn't quoted in SOL./, "a SOL deployment pointed at a USDC curve");
  await assert.rejects(readCurve(env, cfgOf({ QUOTE_MINT: USDC_MINT }), quotedIn(SOL_MINT)), /isn't quoted in USDC./, "a USDC deployment pointed at a SOL curve");
  await assert.rejects(readCurve(env, cfgOf({ QUOTE_MINT: USDC_MINT }), quotedIn(addr())), /isn't quoted in USDC./, "any other token");
  assert.equal((await readCurve(env, cfgOf({ QUOTE_MINT: USDC_MINT }), quotedIn(USDC_MINT))).quote, "USDC", "and the match passes");
  assert.equal((await readCurve(env, cfgOf({}), quotedIn(SOL_MINT))).quote, "SOL");
  const garbage = addr();
  await assert.rejects(readCurve(env, cfgOf({ QUOTE_MINT: garbage }), quotedIn(garbage)), /isn't quoted in SOL or USDC./, "a QUOTE_MINT that is neither is no quote at all, even when the config names it");
});

test("publicStage: a USDC curve reports whole USDC (dollars); a SOL curve, and a read from before QUOTE_MINT, still report raisedSol", async () => {
  const c = await refreshCurve(env, usdcCfg(), 1_000_000, { client: realClient });
  assert.equal(c.stage, "curve");
  assert.deepEqual(await publicStage(env.DB, 1_000_000 + 1000), { stage: "curve", progressBps: 11, quote: "USDC", raised: 18.134242, threshold: 15390.982211, pool: U.poolUsdc.address });
  assert.deepEqual(await publicStage(env.DB, 1_000_000 + 601_000), { stage: "unknown" });
  await env.DB.prepare("DELETE FROM kv").run();
  await env.DB.prepare("INSERT INTO kv (k, v, at) VALUES ('curve', ?, ?)").bind(JSON.stringify({ stage: "curve", progressBps: 5000, raisedLamports: 43_000_000_000, thresholdLamports: 86_000_000_000, pool: "p", at: 5_000 }), 5_000).run();
  assert.deepEqual(await publicStage(env.DB, 6_000), { stage: "curve", progressBps: 5000, raisedSol: 43, thresholdSol: 86, pool: "p" }, "no quote in the record: it was SOL");
});

test("/api/state: the pool block of a USDC curve is in dollars, and the coin's price is still its USD price", async () => {
  const pool = addr();
  await env.DB.prepare("INSERT INTO kv (k, v, at) VALUES ('curve', ?, ?)").bind(JSON.stringify({ stage: "curve", progressBps: 5000, raisedLamports: 2_939_314_965, thresholdLamports: 5_878_629_931, quote: "USDC", quoteDecimals: 6, pool, at: Date.now() }), Date.now()).run();
  const s = await (await worker.fetch(new Request("http://x/api/state"), envU)).json();
  assert.deepEqual(s.pool, { stage: "curve", progressBps: 5000, quote: "USDC", raised: 2939.314965, threshold: 5878.629931, pool });
  assert.equal("raisedSol" in s.pool, false, "nothing for the page to misread as SOL");
  assert.equal(s.price, 0.001);
});

/* ---------------- the curve's fee claims, measured in USDC ---------------- */

const bn = (n) => new BN(String(n));
const SQRT = getSqrtPriceFromPrice("0.0000019349999995", 6, 6); // the $1,935 start of the real config
const usdcConf = (o = {}) => ({ migrationQuoteThreshold: bn(5_878_629_931), tokenDecimal: 6, migrationFeeOption: 6, feeClaimer: new PublicKey(PAYOUT), quoteMint: new PublicKey(USDC_MINT), ...o });
const dbcIx = () => new TransactionInstruction({ programId: new PublicKey(DBC), keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([1]) });
const dammIx = () => new TransactionInstruction({ programId: new PublicKey(DAMM), keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([2]) });
const ATA = () => usdcAta(PAYOUT, env).toBase58();
// Fake chain and SDK client for the claims. The simulation reports the payout wallet's USDC account (and, to catch a mix-up, its SOL).
function fresh(over = {}) {
  S = { sent: [], asked: [], usdc: 5_000_000n, gain: 1_000_000n, sol: 500_000_000n, solGain: 0n, simErr: null, status: () => "wait", height: 1000, ...over };
  const pool = { quoteReserve: bn(over.raised ?? 1_000_000_000), isMigrated: over.migrated ? 1 : 0, migrationProgress: 0, sqrtPrice: SQRT, partnerQuoteFee: bn(over.fee ?? 0), partnerBaseFee: bn(0) };
  return {
    client: () => ({
      state: { getPool: async () => ({ poolState: pool }), getPoolConfig: async () => usdcConf() },
      partner: { claimPartnerTradingFeeToReceiver: async (p) => { S.lastClaim = p; return new Transaction().add(dbcIx()); } },
    }),
    blockhash: async () => ({ blockhash: addr(), lastValidBlockHeight: S.height + 150 }),
    send: async (tx) => { S.sent.push(tx); return sigOf(tx); },
    settle: async (items) => Object.fromEntries(items.map((i) => [i.sig, S.status(i.sig)])),
    simulate: async (_tx, accounts) => {
      S.asked.push(accounts);
      return { err: S.simErr, logs: [], units: 1, after: new Map(accounts.map((a) => [a, { lamports: S.sol + S.solGain, data: tokenAccount({ mint: USDC_MINT, owner: PAYOUT, amount: S.usdc + S.gain, ext: false }) }])) };
    },
    solBalance: async () => { throw new Error("a USDC claim never reads the wallet's SOL"); },
    usdcBalance: async () => S.usdc,
  };
}
const fence = async () => {};
const withFee = async (fee, cfg = usdcCfg({ DRY_RUN: "0" })) => { const d = fresh({ fee }); await refreshCurve(env, cfg, 1_000, d); return d; };

test("claim in USDC: the gain is read from the payout wallet's USDC account (never its lamports), the claim is saved by signature before it is sent, and it names the USDC amount", async () => {
  const cfg = usdcCfg({ DRY_RUN: "0" }), d = await withFee(400_000, cfg), send = d.send;
  d.send = async (tx) => { assert.equal((await kv("claim")).sig, sigOf(tx), "the signature was in kv when the send happened"); return send(tx); };
  assert.equal((await claimFees(env, cfg, kp, fence, 10_000, d)).claim, "sent");
  assert.deepEqual(S.asked, [[ATA()]], "the simulation watched the wallet's USDC account, not the wallet");
  assert.equal(S.lastClaim.maxQuoteAmount.toString(), "400000");
  assert.equal(S.lastClaim.receiver.toBase58(), PAYOUT);
  assert.equal((await kv("claim")).amount, 400_000);
  assert.equal(S.sent.length, 1);
});

test("claim in USDC: a simulation that raises the wallet's SOL but not its USDC is not sent; one that raises USDC is, with no SOL change at all", async () => {
  const cfg = usdcCfg({ DRY_RUN: "0" });
  const d = await withFee(400_000, cfg);
  S.gain = 0n; S.solGain = 100_000_000n; // the lamports rise (a different claim, a top-up) and the USDC does not
  assert.equal((await quiet(() => claimFees(env, cfg, kp, fence, 10_000, d))).claim, "simulation failed");
  assert.equal(S.sent.length, 0);
  assert.notEqual((await kv("claim"))?.state, "sent", "nothing was saved as sent");
  S.gain = 1_000_000n; S.solGain = 0n; S.simErr = { InstructionError: [0, "Custom"] };
  assert.equal((await quiet(() => claimFees(env, cfg, kp, fence, 10_000, d))).claim, "simulation failed", "a failing simulation never sends");
  S.simErr = null;
  assert.equal((await claimFees(env, cfg, kp, fence, 10_000, d)).claim, "sent");
  assert.equal(S.sent.length, 1);
});

test("claim in USDC: under 0.35 USDC nothing, from 0.35 one claim; a dry run claims nothing; a SOL curve keeps its own 0.005 SOL minimum", async () => {
  const cfg = usdcCfg({ DRY_RUN: "0" });
  assert.deepEqual(await claimFees(env, cfg, kp, fence, 10_000, await withFee(349_999, cfg)), {});
  assert.equal((await claimFees(env, cfg, kp, fence, 10_000, await withFee(350_000, cfg))).claim, "sent");
  await env.DB.prepare("DELETE FROM kv").run(); S.sent.length = 0;
  assert.deepEqual(await claimFees(env, usdcCfg({ DRY_RUN: "1" }), kp, fence, 10_000, await withFee(400_000, usdcCfg({ DRY_RUN: "1" }))), {}, "dry run");
  await env.DB.prepare("DELETE FROM kv").run();
  const solCfg = config({ MINT: addr(), DBC_CONFIG: addr(), PAYOUT_WALLET: PAYOUT, DRY_RUN: "0" });
  const d = fresh({ fee: 400_000 }); d.client = () => ({ state: { getPool: async () => ({ poolState: { quoteReserve: bn(1), isMigrated: 0, migrationProgress: 0, sqrtPrice: SQRT, partnerQuoteFee: bn(400_000), partnerBaseFee: bn(0) } }), getPoolConfig: async () => usdcConf({ quoteMint: new PublicKey(SOL_MINT) }) } });
  await refreshCurve(env, solCfg, 1_000, d);
  assert.deepEqual(await claimFees(env, solCfg, kp, fence, 10_000, d), {}, "400,000 lamports is far below 0.005 SOL");
});

/* ---------------- after graduation: the DAMM v2 position, from the quote mint ---------------- */

const zero32 = () => Array(32).fill(0);
const positionOf = (feeB) => ({ position: new PublicKey(addr()), positionNftAccount: new PublicKey(addr()), positionState: {
  unlockedLiquidity: bn(0), vestedLiquidity: bn(0), permanentLockedLiquidity: bn(0), feeAPerTokenCheckpoint: zero32(), feeBPerTokenCheckpoint: zero32(), feeAPending: bn(0), feeBPending: bn(feeB), rewardInfos: [] } });
const dammState = (tokenB) => ({ feeAPerLiquidity: zero32(), feeBPerLiquidity: zero32(), tokenAMint: new PublicKey(addr()), tokenBMint: new PublicKey(tokenB), tokenAVault: new PublicKey(addr()), tokenBVault: new PublicKey(addr()), rewardInfos: [] });
function withDamm(d, { positions = [], tokenB = USDC_MINT } = {}) {
  S.damm = { reads: 0, listed: 0, claims: [] };
  d.cp = () => ({
    fetchPoolState: async (p) => { S.damm.reads++; S.damm.pool = p; return dammState(tokenB); },
    getUserPositionByPool: async () => { S.damm.listed++; return positions; },
    claimPositionFee: async (params) => { S.damm.claims.push(params); return new Transaction().add(dammIx()); },
  });
  return d;
}
const graduated = async (cfg) => { const d = fresh({ raised: 6_000_000_000, migrated: true }); await refreshCurve(env, cfg, 1_000, d); return d; };

test("claim_damm in USDC: the pool is derived from the USDC mint, the position's USDC side is what is measured and claimed, from 0.35 USDC", async () => {
  const cfg = usdcCfg({ DRY_RUN: "0", MINT: addr() });
  const positions = [positionOf(349_999), positionOf(2_500_000), positionOf(900_000)];
  const d = withDamm(await graduated(cfg), { positions });
  const r = await claimDammFees(env, cfg, kp, fence, 10_000, d);
  assert.equal(r.claim_damm, "sent");
  assert.equal(S.damm.pool.toBase58(), deriveDammV2PoolAddress(new PublicKey(DAMM_V2_MIGRATION_FEE_ADDRESS[6]), new PublicKey(cfg.mint), new PublicKey(USDC_MINT)).toBase58());
  assert.notEqual(S.damm.pool.toBase58(), deriveDammV2PoolAddress(new PublicKey(DAMM_V2_MIGRATION_FEE_ADDRESS[6]), new PublicKey(cfg.mint), new PublicKey(SOL_MINT)).toBase58(), "not the SOL pool's address");
  assert.equal(S.damm.claims[0].position.toBase58(), positions[1].position.toBase58(), "the position with the most USDC waiting");
  assert.equal((await kv("claim_damm")).amount, 2_500_000);
  assert.deepEqual(S.asked, [[ATA()]], "measured in the USDC account");
  await env.DB.prepare("DELETE FROM kv").run(); S.sent.length = 0;
  const small = withDamm(await graduated(cfg), { positions: [positionOf(349_999)] });
  assert.deepEqual(await claimDammFees(env, cfg, kp, fence, 20_000, small), {}, "under 0.35 USDC");
  assert.equal(S.sent.length, 0);
});

test("claim_damm: a pool whose second token is not the configured quote is nothing to claim, in either direction (nothing listed, nothing sent)", async () => {
  const cfg = usdcCfg({ DRY_RUN: "0", MINT: addr() });
  const sol = withDamm(await graduated(cfg), { positions: [positionOf(50_000_000)], tokenB: SOL_MINT });
  assert.deepEqual(await claimDammFees(env, cfg, kp, fence, 10_000, sol), {}, "a USDC deployment looking at a SOL pool");
  assert.equal(S.damm.reads, 1);
  assert.equal(S.damm.listed, 0);
  assert.equal(S.sent.length, 0);
  await env.DB.prepare("DELETE FROM kv").run();
  const solCfg = config({ MINT: addr(), DBC_CONFIG: addr(), PAYOUT_WALLET: PAYOUT, DRY_RUN: "0" });
  const d = fresh({ raised: 6_000_000_000, migrated: true }); d.client = () => ({ state: { getPool: async () => ({ poolState: { quoteReserve: bn(9), isMigrated: 1, migrationProgress: 3, sqrtPrice: SQRT, partnerQuoteFee: bn(0), partnerBaseFee: bn(0) } }), getPoolConfig: async () => usdcConf({ quoteMint: new PublicKey(SOL_MINT) }) } });
  await refreshCurve(env, solCfg, 1_000, d);
  const usdcPool = withDamm(d, { positions: [positionOf(50_000_000)], tokenB: USDC_MINT });
  assert.deepEqual(await claimDammFees(env, solCfg, kp, fence, 10_000, usdcPool), {}, "and a SOL deployment looking at a USDC pool");
  assert.equal(S.damm.listed, 0);
  assert.equal(S.sent.length, 0);
});

/* ---------------- the round ---------------- */

const holder = (tokens) => {
  const w = addr();
  S.balances.set(w, BigInt(tokens) * TOK);
  S.atas.add(usdcAta(w, env).toBase58());
  return w;
};
const threeHolders = () => [holder(100_000), holder(200_000), holder(300_000)];
const cultSwap = (x) => isSwap(x) && touches(x, TREASURY);
const solSwap = (x) => isSwap(x) && !touches(x, TREASURY);
const swapState = () => { threeHolders(); S.cult = 5_000n * TOK; S.swapOut = (_a, input) => (input === MINT ? 5_000_000n : 20_000_000n); }; // $5 of CULT, and a SOL leg that would pay $20

test("USDC quote: the round sells the treasury's CULT, does NOT sell SOL, and pays the wallet's whole USDC balance (the claimed curve fees included)", async () => {
  swapState();
  S.usdc = 20_000_000n; // the curve's fees, claimed as USDC
  S.sol = 2_000_000_000; // 2 SOL: far above the reserve, exactly what the SOL leg would sell
  const r = await tick(envU, T0);
  assert.equal(r.status, "paying", JSON.stringify(r));
  const swaps = S.sent.filter(isSwap);
  assert.equal(swaps.length, 1, "one swap");
  assert.ok(cultSwap(swaps[0]), "and it is the CULT leg");
  assert.equal(S.sent.filter(solSwap).length, 0, "no SOL swap");
  assert.equal(S.quotes.filter((q) => q.inputMint === SOL).length, 0, "SOL was not even priced");
  assert.equal(S.sol, 2_000_000_000, "the team's gas float is untouched");
  const d = await drop();
  assert.deepEqual([d.cult_sig === swaps[0].sig, d.swap_sig, d.swap_lamports], [true, "none", 0], "the CULT swap saved by signature; the SOL leg marked as nothing to do");
  assert.ok(d.usdc_micro >= 24_999_990 && d.usdc_micro <= 25_000_000, `pot = 20 USDC claimed + 5 USDC from the CULT sale: ${d.usdc_micro}`);
});

test("SOL quote (the default): the same state sells the CULT and then the spare SOL, as it always did", async () => {
  swapState();
  S.usdc = 20_000_000n; S.sol = 2_000_000_000;
  const r = await tick(envS, T0);
  assert.equal(r.status, "paying", JSON.stringify(r));
  const swaps = S.sent.filter(isSwap);
  assert.equal(swaps.length, 2);
  assert.ok(cultSwap(swaps[0]) && solSwap(swaps[1]), "the CULT leg first, then the SOL leg");
  assert.equal(S.quotes.filter((q) => q.inputMint === SOL).length, 1);
  assert.equal((await drop()).swap_sig, swaps[1].sig);
});

test("USDC quote with nothing to sell and no CULT: the round still pays the USDC the wallet holds, and sends no swap at all", async () => {
  threeHolders();
  S.usdc = 12_000_000n;
  const r = await tick(envU, T0);
  assert.equal(r.status, "paying", JSON.stringify(r));
  assert.equal(S.sent.filter(isSwap).length, 0);
  const d = await drop();
  assert.deepEqual([d.cult_sig, d.swap_sig], ["none", "none"]);
  assert.ok(d.usdc_micro >= 11_999_990 && d.usdc_micro <= 12_000_000, String(d.usdc_micro));
});

test("a QUOTE_MINT that is neither empty nor USDC: the tick refuses before anything, says why, and remembers nothing", async () => {
  swapState();
  const r = await quiet(() => tick({ ...envS, QUOTE_MINT: addr() }, T0));
  assert.match(r.skipped, /QUOTE_MINT must be empty \(SOL\) or the USDC mint/);
  assert.equal(S.sent.length, 0);
  assert.equal(await drop(), null, "no round was opened");
  assert.equal(await first("SELECT * FROM kv WHERE k = 'payout_check'"), null);
});

/* ---------------- trades, in quote units ---------------- */

test("a sell on a USDC curve is recorded with the quote's price (1) and the coin's price in USDC; the SOL columns are not used", async () => {
  const seller = addr();
  const hook = await postHook(worker, envU, [enhancedSell({ sig: "u1", wallet: seller, at: T0, gross: 1_000n * TOK, MINT, vault: VAULT })]);
  assert.equal(hook.status, 200);
  const t = await first("SELECT * FROM trades WHERE sig = 'u1'");
  assert.deepEqual([t.sol_usd, t.price_sol, t.price_usd, t.sol_lamports, t.fee_lamports], [1, 0.001, 0.001, 0, 0], "USDC per coin is the coin's USD price, because a USDC is a dollar");
  assert.equal(t.usd, 1, "1,000 coins at $0.001");
  const s = await first("SELECT * FROM sells WHERE sig = 'u1'");
  assert.deepEqual([s.sol_usd, s.sol_out, s.fee_lamports], [1, 0, 0]);
  assert.ok(Math.abs(s.fee_usd - 0.1) < 1e-12, "the 10% tax, 100 coins, $0.10");
});

test("the same sell on a SOL curve is recorded as it always was: SOL's USD price and the coin's price in SOL", async () => {
  await postHook(worker, envS, [enhancedSell({ sig: "s1", wallet: addr(), at: T0, gross: 1_000n * TOK, MINT, vault: VAULT })]);
  const t = await first("SELECT * FROM trades WHERE sig = 's1'");
  assert.equal(t.sol_usd, 200);
  assert.ok(Math.abs(t.price_sol - 0.001 / 200) < 1e-15);
  assert.equal((await first("SELECT sol_usd FROM sells WHERE sig = 's1'")).sol_usd, 200);
});

test("a USDC curve needs no SOL price to record a trade; a SOL curve with no SOL price still asks Helius to try again", async () => {
  S.solUsd = 0; // Jupiter has no SOL price today
  const u = await postHook(worker, envU, [enhancedSell({ sig: "u2", wallet: addr(), at: T0, gross: 1_000n * TOK, MINT, vault: VAULT })]);
  assert.equal(u.status, 200);
  assert.deepEqual([(await u.json()).added, (await first("SELECT sol_usd, price_sol FROM trades WHERE sig = 'u2'")).sol_usd], [1, 1]);
  await env.DB.prepare("DELETE FROM kv WHERE k = 'price'").run();
  const s = await postHook(worker, envS, [enhancedSell({ sig: "s2", wallet: addr(), at: T0, gross: 1_000n * TOK, MINT, vault: VAULT })]);
  assert.equal(s.status, 503);
  assert.equal(await first("SELECT * FROM trades WHERE sig = 's2'"), null);
});

// A getTransaction (jsonParsed) of a sell: the wallet's token account loses `gross` raw, the vault gains it less the 10% withheld.
function rpcSell({ wallet, gross }) {
  const g = BigInt(gross), net = g - feeOn(g, 1000), account = addr();
  const tb = (accountIndex, owner, amount) => ({ accountIndex, mint: MINT, owner, uiTokenAmount: { amount: String(amount), decimals: 6 } });
  return { slot: 9, blockTime: Math.floor(T0 / 1000), meta: { err: null,
    preTokenBalances: [tb(1, wallet, g), tb(2, VAULT.owner, 5_000_000n * TOK)], postTokenBalances: [tb(1, wallet, 0n), tb(2, VAULT.owner, 5_000_000n * TOK + net)] },
  transaction: { signatures: ["x"], message: { accountKeys: [wallet, account, VAULT.account] } } };
}

test("the poller records a sell on a USDC curve without a SOL price too, and on a SOL curve it still waits for one", async () => {
  S.solUsd = 0;
  S.sigs = [{ signature: "p1", err: null }];
  S.getTx = () => rpcSell({ wallet: addr(), gross: 1_000n * TOK });
  const r = await pollMint(envU, config(envU), T0);
  assert.deepEqual([r.polled, r.added], [1, 1]);
  assert.equal((await first("SELECT sol_usd FROM trades WHERE sig = 'p1'")).sol_usd, 1);
  await env.DB.batch(CLEAR.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const w = await pollMint(envS, config(envS), T0);
  assert.equal(w.noPrice, true, "SOL curve, no SOL price: nothing recorded, the cursor stays");
  assert.equal(await first("SELECT * FROM trades"), null);
});

test("recordTrade takes the quote's USD value as its own argument: the stored price and value follow it, and a zero quote stores a zero price", async () => {
  const t = { sig: "r1", side: "sell", wallet: addr(), tokens: 1_000n * TOK, withheld: 100n * TOK };
  await recordTrade(env, t, T0, { sol: 0, token: 0.002 }, 6, 1);
  const row = await first("SELECT * FROM trades WHERE sig = 'r1'");
  assert.deepEqual([row.sol_usd, row.price_sol, row.price_usd, row.usd], [1, 0.002, 0.002, 2]);
  await recordTrade(env, { ...t, sig: "r2" }, T0, { sol: 0, token: 0.002 }, 6, 0);
  assert.equal((await first("SELECT price_sol FROM trades WHERE sig = 'r2'")).price_sol, 0, "never a division by zero");
});

/* ---------------- prices: the curve's own price for a coin Jupiter hasn't priced ---------------- */

const curveRecord = (priceSol, at, quote) => env.DB.prepare("INSERT INTO kv (k, v, at) VALUES ('curve', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify({ stage: "curve", priceSol, ...(quote ? { quote } : {}), at }), at).run();

test("prices on a USDC curve: the curve's price per coin IS its USD price (no SOL price in it); a record made under the other quote is no price", async () => {
  S.tokenUsd = 0;
  await curveRecord(0.000002, T0, "USDC");
  assert.deepEqual(await cachedPrices(envU, config(envU), T0 + 1_000), { sol: 200, token: 0.000002 });
  await env.DB.prepare("DELETE FROM kv WHERE k = 'price'").run();
  S.solUsd = 0;
  assert.deepEqual(await cachedPrices(envU, config(envU), T0 + 2_000), { sol: 0, token: 0.000002 }, "SOL's price unknown changes nothing");
  await env.DB.prepare("DELETE FROM kv WHERE k = 'price'").run();
  S.solUsd = 200;
  await curveRecord(0.000005, T0, null); // a record from the SOL days: 0.000005 SOL per coin
  assert.deepEqual(await cachedPrices(envU, config(envU), T0 + 3_000), { sol: 200, token: 0 }, "SOL per coin read as USDC per coin would be a price off by 200");
  await env.DB.prepare("DELETE FROM kv WHERE k = 'price'").run();
  await curveRecord(0.000002, T0, "USDC");
  assert.deepEqual(await cachedPrices(envS, config(envS), T0 + 4_000), { sol: 200, token: 0 }, "and the other way round");
});
