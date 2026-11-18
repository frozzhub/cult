// Graduate a curve pool into its DAMM v2 pool, once the curve is complete.
//
//   node scripts/migrate-curve.mjs --rpc <URL> --mint <MINT> --keypair <payer file> [--fee-keypair <file>] [--state-dir <dir>] [--go]
//
// Who migrates (from the program source, see docs/build-log-curve-scripts.md): the migration instruction is permissionless,
// its only signer is the payer, so anyone can send it once the curve is complete. Meteora runs a keeper that migrates
// eligible pools by itself (docs.meteora.ag core-products/dbc/migration-and-liquidity: SOL threshold 10 SOL, or a Jupiter
// Verified quote token with notional above 750 USD); whether it also takes a transfer-fee token on the Customizable fee
// option is not in any source. So this script is the manual path and also the check: if the pool is already migrated it
// sends nothing and reports what it finds. The payer pays the DAMM v2 accounts' rent (about 0.017 SOL).
//
// Dry run by default: reads the pool, says how far the curve is, and simulates the migration against the real programs.
// With --go: signs, saves the signature BEFORE sending, settles an unknown outcome from the signature, never resends, and
// reads back the new pool, the locked position and the vaults. Safe to run again at any time.
// With --fee-keypair (the fee wallet's key) it also withdraws the curve's leftover tokens, which the fee wallet must sign for
// when the mint charges a transfer fee (withdraw_leftover.rs:112-114).
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { DynamicBondingCurveClient, DAMM_V2_MIGRATION_FEE_ADDRESS, deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  SOL_MINT, Refuse, refuse, sol, parseArgs, loadKey, pubkeyOf, connect, clusterOf, tilde, readJson, writeJson, makeSender, readTokenAccounts, readMint,
} from "./lib/curve.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FLAGS = { value: ["rpc", "mint", "keypair", "fee-keypair", "state-dir"], flag: ["go"] };
const PAYER_MARGIN = 5_000_000n; // lamports on top of the rent, for fees

const bn = (x) => BigInt(x.toString());
// getPoolByBaseMint is a program-account scan (rate-limited on public RPCs); the pool's address never changes, so scan once.
const poolAddresses = new Map();
export async function loadPool(client, mint) {
  const known = poolAddresses.get(mint.toBase58());
  if (known) return { address: known, state: (await client.state.getPool(known)).poolState };
  const r = await client.state.getPoolByBaseMint(mint);
  if (!r) return null;
  const vp = r.account?.poolState ? r.account : r.account ? { poolState: r.account } : r;
  poolAddresses.set(mint.toBase58(), r.publicKey);
  return { address: r.publicKey, state: vp.poolState };
}

// What the curve's state says about where it is. Pure, so the tests can walk every case.
export function curveStatus(pool, config) {
  const migrated = Number(pool.isMigrated) === 1;
  const quote = bn(pool.quoteReserve), threshold = bn(config.migrationQuoteThreshold);
  const complete = quote >= threshold;
  return { migrated, complete, quote, threshold, remaining: complete ? 0n : threshold - quote, progress: Number(pool.migrationProgress) };
}

export async function runMigrate(o, say = console.log) {
  const { conn, payer, mint } = o;
  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const cp = new CpAmm(conn);
  const cluster = await clusterOf(conn);
  const pool = await loadPool(client, mint);
  if (!pool) refuse(`No bonding-curve pool found for ${mint} on ${cluster}.`);
  const config = await client.state.getPoolConfig(pool.state.config);
  if (Number(config.migrationOption) !== 1) refuse("This pool doesn't migrate to DAMM v2.");
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[Number(config.migrationFeeOption)];
  const dammPool = deriveDammV2PoolAddress(dammConfig, mint, SOL_MINT);
  const feeWallet = new PublicKey(config.feeClaimer);
  const stateDir = resolve(o.stateDir);
  const sender = makeSender({ conn, dir: stateDir, name: `migrate-curve-${pool.address.toBase58().slice(0, 8)}`, say });
  const stateFile = join(stateDir, `migrate-curve-${mint.toBase58()}.json`);
  const S = readJson(stateFile, { mint: mint.toBase58(), pool: pool.address.toBase58(), dammPool: dammPool.toBase58(), txs: [] });

  await sender.resolvePending(); // a signature from a crashed run is settled before anything is read as truth
  let cur = await loadPool(client, mint);
  let cs = curveStatus(cur.state, config);

  say(`
Migration (${o.go ? "LIVE" : "dry run, add --go to send"}) on ${conn.rpcEndpoint} (${cluster})
  mint         ${mint}
  curve pool   ${pool.address}  ${cs.migrated ? "MIGRATED" : cs.complete ? "complete, not migrated" : `not complete: ${sol(cs.quote)} of ${sol(cs.threshold)} raised, ${sol(cs.remaining)} to go`}
  DAMM v2 pool ${dammPool}  (config ${dammConfig}, customizable fee option)
  payer        ${payer ? payer.publicKey : "(none given: read-only)"}  fee wallet (owns the locked position) ${feeWallet}`);

  if (!cs.migrated && !cs.complete) { console.error("REFUSING: the curve isn't complete yet, nothing to migrate. Buys on the curve take it there."); process.exitCode = 1; return { status: "not-complete", ...cs }; }

  if (!cs.migrated) {
    if (!payer) refuse("Give the payer's key with --keypair <file>.");
    const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await client.migration.migrateToDammV2({ payer: payer.publicKey, pool: pool.address, dammConfig });
    const ixs = transaction.instructions.filter((ix) => !(ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3));
    const signers = [payer, firstPositionNftKeypair, secondPositionNftKeypair];
    const payerLamports = BigInt(await conn.getBalance(payer.publicKey, "confirmed"));
    const sim = await sender.simulate(ixs, signers, [payer.publicKey]);
    const cost = sim.accounts?.[0] ? payerLamports - BigInt(sim.accounts[0].lamports) : null;
    say(`  simulated    ${sim.err ? "FAILS " + JSON.stringify(sim.err) + "\n    " + sim.logs.slice(-6).join("\n    ") : `ok, costs the payer ${cost === null ? "?" : sol(cost)} (DAMM v2 pool, vaults and position rent), ${sim.units ?? "?"} compute units`}`);
    if (sim.err) { console.error("REFUSING: the migration fails when simulated against the real programs."); process.exitCode = 1; return { status: "sim-failed", err: sim.err }; }
    if (cost !== null && payerLamports < cost + PAYER_MARGIN) { console.error(`REFUSING: the payer holds ${sol(payerLamports)}, the migration needs about ${sol(cost + PAYER_MARGIN)}.`); process.exitCode = 1; return { status: "payer-short" }; }
    if (!o.go) return { status: "ready", dammPool };

    S.attempts = [...(S.attempts || []), { firstPositionNft: firstPositionNftKeypair.publicKey.toBase58(), secondPositionNft: secondPositionNftKeypair.publicKey.toBase58(), at: new Date().toISOString() }];
    writeJson(stateFile, S);
    try {
      const r = await sender.send("migrate to DAMM v2", ixs, signers);
      S.txs.push({ label: "migrate", sig: r.sig, status: r.status }); writeJson(stateFile, S);
    } catch (e) {
      // The keeper (or someone else) may have migrated between our read and our send: the program refuses a second migration.
      cs = curveStatus((await loadPool(client, mint)).state, config);
      if (!cs.migrated) throw e;
      say("  someone else migrated it first (the program allows it once); reading the result");
    }
    cs = curveStatus((await loadPool(client, mint)).state, config);
    if (!cs.migrated) refuse("The migration didn't land (the transaction expired or was dropped). Run the same command again; nothing was sent twice.");
  }

  // Read-back: the new pool, the position, the vaults, who got what.
  const dp = await cp.fetchPoolState(dammPool).catch(() => null);
  if (!dp) refuse(`The curve says migrated but the DAMM v2 pool ${dammPool} can't be read yet. Run the same command again in a moment.`);
  const vp = (await loadPool(client, mint)).state;
  const vaultA = (await readTokenAccounts(conn, mint, [dp.tokenAVault])).get(dp.tokenAVault.toBase58());
  const vaultB = BigInt((await conn.getTokenAccountBalance(dp.tokenBVault, "confirmed")).value.amount);
  const positions = await cp.getUserPositionByPool(dammPool, feeWallet);
  const locked = positions.reduce((n, p) => n + bn(p.positionState.permanentLockedLiquidity), 0n);
  const unlocked = positions.reduce((n, p) => n + bn(p.positionState.unlockedLiquidity), 0n);
  const mi = await readMint(conn, mint);
  const bad = [];
  if (!positions.length) bad.push(`no liquidity position owned by the fee wallet ${feeWallet} in the new pool`);
  if (locked === 0n) bad.push("the fee wallet's position holds no permanently locked liquidity");
  if (unlocked !== 0n) bad.push(`the fee wallet's position holds ${unlocked} unlocked liquidity (expected all locked)`);
  if (!mi?.fee?.withdrawAuthority || !mi.fee.withdrawAuthority.equals(feeWallet)) bad.push("the withdraw-withheld authority is no longer the fee wallet");
  if (mi?.fee?.configAuthority !== null) bad.push("the mint has a fee-config authority");
  if (mi?.fee?.bps !== 1000) bad.push(`the transfer fee is ${mi?.fee?.bps} bps`);
  say(`
  DAMM v2 pool ${dammPool}: vault A (tokens) holds ${vaultA?.amount ?? "?"} raw with ${vaultA?.withheld ?? "?"} raw withheld for the fee wallet; vault B holds ${sol(vaultB)}
  position     ${positions.map((p) => p.position.toBase58()).join(", ") || "none"}  owned by ${feeWallet}; permanently locked liquidity ${locked}, unlocked ${unlocked}
  booked to Meteora's protocol fee at migration: ${sol(bn(vp.protocolMigrationQuoteFeeAmount))} SOL side, ${bn(vp.protocolMigrationBaseFeeAmount)} raw tokens
  token        ${mi ? `${mi.fee?.bps} bps fee, config authority ${mi.fee?.configAuthority ?? "none"}, withdraw-withheld authority ${mi.fee?.withdrawAuthority ?? "none"}` : "?"}
  add to EXCLUDE (program-owned, they hold tokens): the DAMM v2 vaults ${dp.tokenAVault}, ${dp.tokenBVault}`);

  // Leftover tokens left in the curve's base vault after migration: the fee wallet must sign for them.
  const baseVault = new PublicKey(vp.baseVault);
  const bv = (await readTokenAccounts(conn, mint, [baseVault])).get(baseVault.toBase58());
  const leftover = bv ? bv.amount - bn(vp.protocolBaseFee) - bn(vp.partnerBaseFee) - bn(vp.creatorBaseFee) - bn(vp.protocolMigrationBaseFeeAmount) : 0n;
  if (Number(vp.isWithdrawLeftover) === 0 && leftover > 0n) {
    if (!o.feeKey) say(`  leftover     ${leftover} raw tokens wait in the curve's vault for ${feeWallet}; run again with --fee-keypair to withdraw them`);
    else if (!o.feeKey.publicKey.equals(feeWallet)) refuse(`--fee-keypair is ${o.feeKey.publicKey}, not the fee wallet ${feeWallet}.`);
    else {
      const tx = await client.migration.withdrawLeftover({ payer: o.feeKey.publicKey, pool: pool.address });
      const ixs = tx.instructions.filter((ix) => !(ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3));
      if (!o.go) say(`  leftover     ${leftover} raw tokens would be withdrawn to ${feeWallet} (--go)`);
      else { const r = await sender.send("withdraw leftover", ixs, [o.feeKey]); S.txs.push({ label: "leftover", sig: r.sig, status: r.status }); writeJson(stateFile, S); }
    }
  } else say(`  leftover     ${Number(vp.isWithdrawLeftover) === 1 ? "already withdrawn" : "none"}`);

  if (bad.length) refuse(`The migration finished but the result isn't what the design needs:\n  ${bad.join("\n  ")}`);
  S.migrated = true; writeJson(stateFile, S);
  say("\nDone, and checked on chain: the pool is migrated, 100% of the liquidity is permanently locked in a position the fee wallet owns, and the fee wallet is still the withdraw-withheld authority.");
  return { status: "migrated", dammPool, positions: positions.map((p) => p.position), vaults: [dp.tokenAVault, dp.tokenBVault] };
}

export function optsFromArgs(argv) {
  const { args } = parseArgs(argv, FLAGS);
  return {
    conn: connect(args.rpc), mint: pubkeyOf(args.mint ?? refuse("Give the coin with --mint <MINT>."), "mint"),
    payer: loadKey({ file: args.keypair, envName: "MIGRATE_PAYER_KEY", label: "keypair" }), feeKey: args["fee-keypair"] ? loadKey({ file: args["fee-keypair"], label: "fee-keypair" }) : null,
    stateDir: typeof args["state-dir"] === "string" ? tilde(args["state-dir"]) : join(REPO, "program-keys", "mainnet"), go: !!args.go,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runMigrate(optsFromArgs(process.argv.slice(2))); } catch (e) { console.error(e instanceof Refuse ? "REFUSING: " + e.message : e.stack || String(e)); process.exitCode = 1; }
}
