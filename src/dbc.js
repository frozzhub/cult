// Meteora's Dynamic Bonding Curve, as far as the Worker needs it (docs/ROUTE-CURVE.md):
//   stage      curve (progress to graduation) | graduating (curve full, not migrated yet) | graduated. Read once a minute by
//              the cron and kept in kv; /api/state only reads kv.
//   claim      the partner's trading fees (SOL) into the payout wallet, hourly; after graduation also the SOL fees of the locked
//              DAMM v2 position the payout wallet owns (src/damm.js, shared with scripts/fee-ops.mjs).
//   migrate    when the curve is full the pool must be migrated to DAMM v2. Meteora's keeper only migrates configs whose
//              threshold is on its list (10 SOL for SOL), ours is about 86 SOL, so we send the migration ourselves.
//              The instruction is permissionless (any payer): if the keeper or someone else gets there first, ours fails
//              on chain and the next read shows "graduated".
// The SDK builds the instructions (pinned in package.json); every sent transaction is saved by signature first and
// settled from the signature's status, like the payout batches.
import { Connection, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import {
  DynamicBondingCurveClient, deriveDbcPoolAddress, deriveDammV2PoolAddress, getPriceFromSqrtPrice, DAMM_V2_MIGRATION_FEE_ADDRESS, DYNAMIC_BONDING_CURVE_PROGRAM_ID,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";
import { positionsOf, claimPositionTx } from "./damm.js";
import * as chain from "./chain.js";
import { LockLost } from "./chain.js";
import { SOL_MINT } from "./config.js";

const kvGet = async (db, k) => { const r = await db.prepare("SELECT v, at FROM kv WHERE k = ?").bind(k).first(); return r ? { v: JSON.parse(r.v), at: r.at } : null; };
const kvSet = (db, k, v, at = Date.now()) => db.prepare("INSERT INTO kv (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at").bind(k, JSON.stringify(v), at).run();
const kvDel = (db, k) => db.prepare("DELETE FROM kv WHERE k = ?").bind(k).run();

// web3.js's Connection with our RPC list and failover behind it (the SDK reads accounts through a Connection).
export function connection(env) {
  const f = async (_url, init) => {
    const urls = chain.rpcUrls(env);
    let res;
    for (let i = 0; i < Math.max(3, urls.length); i++) {
      res = await fetch(urls[i % urls.length], init);
      if (res.status !== 429 && res.status !== 403) break;
    }
    return res;
  };
  return new Connection(chain.rpcUrl(env), { commitment: "confirmed", fetch: f });
}

export const realDbc = (env) => ({
  client: () => new DynamicBondingCurveClient(connection(env), "confirmed"),
  cp: () => new CpAmm(connection(env)),
  blockhash: () => chain.latestBlockhash(env),
  send: (tx) => chain.sendTx(env, tx),
  settle: (items) => chain.settleSent(env, items),
  simulate: (tx, accounts) => chain.simulate(env, tx, accounts),
  solBalance: (a) => chain.solBalance(env, a),
});

export const poolOf = (cfg) => deriveDbcPoolAddress(new PublicKey(SOL_MINT), new PublicKey(cfg.mint), new PublicKey(cfg.dbcConfig));

/* ---------------- stage ---------------- */

// Where the curve is: DBC_CONFIG is only a shortcut. With it unset the pool is found from the chain by its base mint (one
// getProgramAccounts) and its config read from the pool, then remembered in kv, so setting MINT and deploying is enough.
async function locate(env, cfg, client) {
  if (cfg.dbcConfig) return { pool: poolOf(cfg), config: cfg.dbcConfig }; // the address is derived from the config, so no other config can answer
  const saved = (await kvGet(env.DB, "curve_pool"))?.v;
  if (saved?.mint === cfg.mint && !poolRefusal(cfg, saved)) return { pool: new PublicKey(saved.pool), config: saved.config };
  const found = await client.state.getPoolByBaseMint(cfg.mint);
  if (!found) throw new Error("The curve pool isn't on chain yet.");
  const state = found.account.poolState, bad = poolRefusal(cfg, state);
  if (bad) throw new Error(bad); // never remembered
  const config = state.config.toBase58();
  await kvSet(env.DB, "curve_pool", { mint: cfg.mint, pool: found.publicKey.toBase58(), config, creator: state.creator?.toString() });
  return { pool: found.publicKey, config };
}

// DBC configs are public: anyone can launch their own token on ours, for free, and it would carry the same fee settings and the same
// payout wallet. The pool's creator is what tells the real coin from a copy. With DBC_CONFIG or CREATOR set, a pool that differs is
// refused; unset, that check is off. `state` is a pool's state (PublicKeys or base58 strings).
export function poolRefusal(cfg, state) {
  const config = state?.config?.toString(), creator = state?.creator?.toString();
  if (cfg.dbcConfig && config !== cfg.dbcConfig) return `The curve pool is on config ${config || "unknown"}, not the DBC_CONFIG in the settings. Check MINT.`;
  if (cfg.creator && creator !== cfg.creator) return `The curve pool was made by ${creator || "an unknown wallet"}, not the CREATOR in the settings. Check MINT.`;
  return null;
}

// The tick's start-up check (indexer.js payoutProblem): the pool this mint really has must be the one we launched. One read,
// asked only when DBC_CONFIG or CREATOR is set. Unknown means refuse. -> the reason, or null.
export async function poolProblem(env, cfg, deps = realDbc(env)) {
  if (!cfg.dbcConfig && !cfg.creator) return null;
  let found;
  try { found = await deps.client().state.getPoolByBaseMint(cfg.mint); }
  catch (e) { return `Couldn't read the curve pool to check who made it (${e.message}).`; }
  if (!found) return "The curve pool isn't on chain yet. Check MINT.";
  return poolRefusal(cfg, found.account.poolState);
}

// One read: the pool and its config. Returns what the site and the other steps use.
export async function readCurve(env, cfg, deps = realDbc(env)) {
  const client = deps.client();
  const { pool, config } = await locate(env, cfg, client);
  const vp = (await client.state.getPool(pool))?.poolState;
  if (!vp) throw new Error("The curve pool isn't on chain yet.");
  const conf = await client.state.getPoolConfig(config);
  if (!conf) throw new Error("The DBC config isn't on chain.");
  // Every figure here is in SOL: a curve quoted in anything else is not one we can read, so refuse rather than misread it.
  if (conf.quoteMint?.toBase58() !== SOL_MINT) throw new Error("The curve isn't quoted in SOL.");
  const raised = Number(vp.quoteReserve.toString()), threshold = Number(conf.migrationQuoteThreshold.toString());
  const migrated = Number(vp.isMigrated) > 0 || Number(vp.migrationProgress) >= 3;
  const complete = raised >= threshold;
  const decimals = Number(conf.tokenDecimal);
  return {
    pool: pool.toBase58(), stage: migrated ? "graduated" : complete ? "graduating" : "curve",
    raisedLamports: raised, thresholdLamports: threshold, progressBps: Math.min(10_000, Math.floor((raised * 10_000) / threshold)),
    priceSol: Number(getPriceFromSqrtPrice(vp.sqrtPrice, decimals, 9).toString()), // SOL per whole token, before the tax
    partnerQuoteFee: Number(vp.partnerQuoteFee.toString()), partnerBaseFee: Number(vp.partnerBaseFee.toString()),
    migrationFeeOption: Number(conf.migrationFeeOption), feeClaimer: conf.feeClaimer.toBase58(),
  };
}

// The cron calls this every tick; a failed read keeps the last good one (with its age) rather than guessing.
export async function refreshCurve(env, cfg, now = Date.now(), deps = realDbc(env)) {
  if (!cfg.mint) return null;
  try { const c = { ...(await readCurve(env, cfg, deps)), at: now }; await kvSet(env.DB, "curve", c, now); return c; }
  catch (e) { console.error("curve", e.message); return (await kvGet(env.DB, "curve"))?.v || null; }
}

// What /api/state shows. Only kv: no RPC per request. A stage older than 10 minutes is "unknown".
export async function publicStage(db, now = Date.now()) {
  const c = (await kvGet(db, "curve"))?.v;
  if (!c || now - c.at > 600_000) return { stage: "unknown" };
  return { stage: c.stage, progressBps: c.progressBps, raisedSol: c.raisedLamports / 1e9, thresholdSol: c.thresholdLamports / 1e9, pool: c.pool };
}

/* ---------------- shared: sign, save, send, settle ---------------- */

const FROM_SDK = new Set([DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58(), "ComputeBudget111111111111111111111111111111", "11111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"]);

// SDK transaction (legacy shape) -> a signed v0 transaction, after checking it only uses programs a claim or a
// migration uses and that nobody but the payout wallet and the signers we hold are required to sign.
function sign(tx, bh, kp, extra = []) {
  for (const ix of tx.instructions) if (!FROM_SDK.has(ix.programId.toBase58())) throw new Error("The SDK built an instruction for an unexpected program.");
  const need = new Set(tx.instructions.flatMap((ix) => ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())));
  const have = new Set([kp.publicKey.toBase58(), ...extra.map((k) => k.publicKey.toBase58())]);
  for (const n of need) if (!have.has(n)) throw new Error("The SDK transaction needs a signer we don't hold.");
  const v = new VersionedTransaction(new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: bh.blockhash, instructions: tx.instructions }).compileToV0Message());
  v.sign([kp, ...extra]);
  return v;
}

// Settle a transaction saved in kv under `key`. -> "confirmed" | "failed" | "lost" | "wait" | null (nothing saved).
async function settleKey(db, key, deps) {
  const s = (await kvGet(db, key))?.v;
  if (!s?.sig || s.state !== "sent") return null;
  return (await deps.settle([{ sig: s.sig, lvbh: s.lvbh }]))[s.sig];
}

/* ---------------- migration ---------------- */

export async function migrate(env, cfg, kp, fence, now = Date.now(), deps = realDbc(env)) {
  const cur = (await kvGet(env.DB, "curve"))?.v;
  const saved = (await kvGet(env.DB, "migrate"))?.v;
  if (saved?.state === "sent") {
    const st = await settleKey(env.DB, "migrate", deps);
    if (st === "wait") return { migrate: "waiting" };
    if (st === "confirmed") { await kvSet(env.DB, "migrate", { ...saved, state: "done" }, now); return { migrate: "done", sig: saved.sig }; }
    await kvDel(env.DB, "migrate"); // failed or lost: build a new one (new position keypairs) below
  } else if (saved?.state === "done") return { migrate: "done" };
  if (!cur || cur.stage !== "graduating") return {};
  if (!cfg.autoMigrate) return { migrate: "AUTO_MIGRATE is off: waiting for an operator" };
  if (cfg.dryRun) return { migrate: "dry-run: would migrate now" };
  if ((await deps.solBalance(cfg.payout)) < BigInt(cfg.migrateMinLamports)) { console.error("migration waits: the payout wallet needs more SOL"); return { migrate: "needs SOL" }; }

  const client = deps.client();
  const dammConfig = new PublicKey(DAMM_V2_MIGRATION_FEE_ADDRESS[cur.migrationFeeOption]);
  const m = await client.migration.migrateToDammV2({ payer: kp.publicKey, pool: new PublicKey(cur.pool), dammConfig });
  m.transaction.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
  const bh = await deps.blockhash();
  const tx = sign(m.transaction, bh, kp, [m.firstPositionNftKeypair, m.secondPositionNftKeypair]);
  const sim = await deps.simulate(tx, []); // a migration that would fail is not sent
  if (sim.err) { console.error("migration simulation failed", JSON.stringify(sim.err)); return { migrate: "simulation failed" }; }
  const sig = chain.sigOf(tx);
  await fence();
  // Saved before it is sent. A second run sees state "sent" and only ever settles it.
  const claim = await env.DB.prepare("INSERT INTO kv (k, v, at) VALUES ('migrate', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at WHERE kv.at < 0")
    .bind(JSON.stringify({ state: "sent", sig, lvbh: bh.lastValidBlockHeight, first: m.firstPositionNftKeypair.publicKey.toBase58(), second: m.secondPositionNftKeypair.publicKey.toBase58() }), now).run();
  if (!claim.meta.changes) return { migrate: "another run has it" };
  try { await deps.send(tx); } catch (e) { console.error("send migration", e.message); }
  return { migrate: "sent", sig };
}

/* ---------------- partner fees ---------------- */

const MIN_CLAIM_LAMPORTS = 5_000_000; // 0.005 SOL: below this a claim isn't worth its fee

// One hourly claim, saved by signature before it is sent and settled from the signature, like every send here. `key` is its kv row
// and its answer's name; `plan(cur)` -> { build: SDK transaction, amount }, undefined (not applicable: nothing is written) or null
// (looked at the chain and found nothing: the next look is claimMinutes away, so an idle minute costs no RPC). Whatever the SDK
// builds is checked (sign), and simulated to raise the payout wallet's SOL, before it is signed and sent.
async function claimOne(env, cfg, kp, fence, now, deps, key, plan) {
  const db = env.DB;
  const saved = (await kvGet(db, key))?.v;
  if (saved?.state === "sent") {
    const st = await settleKey(db, key, deps);
    if (st === "wait") return { [key]: "waiting" };
    await kvSet(db, key, { state: "done", sig: saved.sig, at: now, ok: st === "confirmed" }, now);
    return { [key]: st };
  }
  const last = (await kvGet(db, key))?.v;
  if (last && now - last.at < cfg.claimMinutes * 60_000) return {};
  const cur = (await kvGet(db, "curve"))?.v;
  if (!cur || cfg.dryRun) return {};
  const p = await plan(cur);
  if (p === undefined) return {};
  if (p === null) { await kvSet(db, key, { state: "done", at: now, ok: null }, now); return {}; }
  const r = await p.build();
  const bh = await deps.blockhash();
  const tx = sign(r, bh, kp);
  const before = await deps.solBalance(cfg.payout);
  const sim = await deps.simulate(tx, [cfg.payout]);
  const gain = (sim.after.get(cfg.payout)?.lamports ?? 0n) - before;
  if (sim.err || gain <= 0n) { console.error(key, "simulation", JSON.stringify(sim.err), String(gain)); return { [key]: "simulation failed" }; }
  const sig = chain.sigOf(tx);
  await fence();
  await kvSet(db, key, { state: "sent", sig, lvbh: bh.lastValidBlockHeight, at: now, amount: p.amount }, now);
  try { await deps.send(tx); } catch (e) { console.error("send", key, e.message); }
  return { [key]: "sent", sig };
}

// Hourly: the partner's share of the curve's trading fees (SOL) into the payout wallet.
export const claimFees = (env, cfg, kp, fence, now = Date.now(), deps = realDbc(env)) => claimOne(env, cfg, kp, fence, now, deps, "claim", (cur) =>
  cur.partnerQuoteFee < MIN_CLAIM_LAMPORTS ? undefined : {
    amount: cur.partnerQuoteFee,
    build: () => deps.client().partner.claimPartnerTradingFeeToReceiver({
      feeClaimer: kp.publicKey, payer: kp.publicKey, pool: new PublicKey(cur.pool), receiver: kp.publicKey,
      maxBaseAmount: new BN(cur.partnerBaseFee), maxQuoteAmount: new BN(cur.partnerQuoteFee),
    }),
  });

// Hourly, after graduation: the SOL fees of the locked DAMM v2 position the payout wallet owns. The curve is gone by then, and this
// is the wallet's only income (it pays every refund, sweep, swap and new holder's USDC account). One position a claim, the one with
// the most SOL waiting; any pool or position we can't read is "nothing to claim", never a guess. The coin's own share of the fees
// arrives in the treasury account (and pays the 10% there: docs/reviews/2026-11-16-money-2-curve.md N3).
export const claimDammFees = (env, cfg, kp, fence, now = Date.now(), deps = realDbc(env)) => claimOne(env, cfg, kp, fence, now, deps, "claim_damm", async (cur) => {
  if (cur.stage !== "graduated") return undefined;
  const cp = deps.cp(), pool = deriveDammV2PoolAddress(new PublicKey(DAMM_V2_MIGRATION_FEE_ADDRESS[cur.migrationFeeOption]), new PublicKey(cfg.mint), new PublicKey(SOL_MINT));
  try {
    const dp = await cp.fetchPoolState(pool);
    const p = dp && (await positionsOf(cp, pool, dp, kp.publicKey)).filter((x) => x.feeB >= BigInt(MIN_CLAIM_LAMPORTS)).sort((a, b) => (a.feeB < b.feeB ? 1 : -1))[0];
    return p ? { amount: Number(p.feeB), build: async () => claimPositionTx(cp, { owner: kp.publicKey, pool, dp, p }) } : null;
  } catch (e) { console.error("damm claim read", e.message); return null; }
});

// The cron's one call. Everything here is best effort: a failure is logged and never blocks the round.
export async function dbcTick(env, cfg, kp, fence, now, deps = realDbc(env)) {
  const out = {};
  const cur = await refreshCurve(env, cfg, now, deps);
  if (cur) out.stage = cur.stage;
  for (const step of [() => migrate(env, cfg, kp, fence, now, deps), () => claimFees(env, cfg, kp, fence, now, deps), () => claimDammFees(env, cfg, kp, fence, now, deps)]) {
    try { Object.assign(out, await step()); } catch (e) { if (e instanceof LockLost) throw e; console.error("dbc", e.message); }
  }
  return out;
}
