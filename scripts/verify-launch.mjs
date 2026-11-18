// Read-only check of the coin that was launched, for T-0 (docs/LAUNCH-NIGHT.md step 2): run it on the mint Proxima made BEFORE MINT
// is set in the Worker. Nothing is sent and no key is needed.
//
//   node scripts/verify-launch.mjs --rpc <URL> --mint <MINT> [--config <DBC config>] [--creator <wallet>] [--fee-wallet <wallet>]
//                                  [--start-mcap 27.96 --grad-mcap 410.8 --pool-fee-bps 25]
//
// Defaults: the production config (3jUuW...UfK) and the payout wallet. The last three are the curve the config was made with (launch-curve.mjs's
// defaults, which the production config uses); the staging test config was made with --start-mcap 30 --grad-mcap 400. --creator is the wallet that made the coin (frz's): the DBC
// config is public, so anyone can launch their own token on it, and the pool's creator is the only thing that tells the real coin
// from a copy. Without --creator that line is printed but not checked.
// It prints every check and exits 1 on any mismatch. The checks are launch-curve.mjs's own read-back (mintMismatches, configMismatches)
// plus the pool: its base mint, its config, its creator.
import { pathToFileURL } from "node:url";
import { TOKEN_2022_PROGRAM_ID, getTokenMetadata } from "@solana/spl-token";
import { DynamicBondingCurveClient, DYNAMIC_BONDING_CURVE_PROGRAM_ID } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { FEE_WALLET, TOKEN_AUTHORITY, Refuse, refuse, parseArgs, positiveNumber, pubkeyOf, connect, clusterOf, readMint, buildCurve, curvePlan } from "./lib/curve.mjs";
import { mintMismatches, configMismatches } from "./launch-curve.mjs";

export const PROD_CONFIG = "3jUuWLhrdao4upGuvC3muRN9cZtP7bSAqDaXsY6QsUfK";
export const FLAGS = { value: ["rpc", "mint", "config", "creator", "fee-wallet", "start-mcap", "grad-mcap", "pool-fee-bps"], flag: [] };
const DEFAULTS = { startMcap: 27.96, gradMcap: 410.8, poolFeeBps: 25 }; // launch-curve.mjs's own defaults: what the production config was made with

// What the config account must say: the same fields launch-curve.mjs checks after a launch.
export function wantConfig(feeWallet, curve = DEFAULTS) {
  const cfg = buildCurve({ ...curve, tokenAuthority: "immutable" }), plan = curvePlan(cfg, { poolFeeBps: curve.poolFeeBps });
  return { feeWallet, poolFeeBps: curve.poolFeeBps, tokenAuthorityCode: TOKEN_AUTHORITY.immutable, thresholdLamports: plan.thresholdLamports, sqrtStartPrice: BigInt(cfg.sqrtStartPrice.toString()) };
}

// Pure: what was read -> [{ status: "ok" | "FAIL" | "note", what }]. `r` = { mi, meta, conf, pool, poolAddr } (null for what isn't there);
// `o` = { mint, config, creator|null, feeWallet } (PublicKeys), and optionally curve = { startMcap, gradMcap, poolFeeBps }.
export function launchChecks(r, o) {
  const out = [];
  const group = (what, bad) => out.push(...(bad.length ? bad.map((b) => ({ status: "FAIL", what: `${what}: ${b}` })) : [{ status: "ok", what }]));
  const m = r.meta && { name: r.meta.name, symbol: r.meta.symbol, uri: r.meta.uri, updateAuthority: r.meta.updateAuthority };
  // The coin's own name, symbol and uri are read back as given (this script can't know them); its update authority must be none.
  group("the mint: 6 decimals, 1,000,000,000 supply, no mint or freeze authority, 10% fee with no cap and no one who can change it, the fee wallet withdraws withheld tokens, metadata with no update authority",
    mintMismatches(r.mi, { feeWallet: o.feeWallet, name: m?.name, symbol: m?.symbol, uri: m?.uri, tokenAuthority: "immutable" }, m));
  group(`the config ${o.config}: fee wallet, 10% transfer fee, SOL quote, curve and migration settings`,
    r.conf ? configMismatches(r.conf, wantConfig(o.feeWallet, o.curve)) : ["it doesn't exist, or isn't owned by the bonding-curve program"]);
  if (!r.pool) { group("the curve pool", ["this mint has no bonding-curve pool"]); return out; }
  group("the pool's base mint is this mint", String(r.pool.baseMint) === String(o.mint) ? [] : [`it is ${r.pool.baseMint}`]);
  group(`the pool is on the config ${o.config}`, String(r.pool.config) === String(o.config) ? [] : [`it is on ${r.pool.config}: a different config, not ours`]);
  if (o.creator) group(`the pool was created by ${o.creator}`, String(r.pool.creator) === String(o.creator) ? [] : [`it was created by ${r.pool.creator}: not frz's wallet, so this may be a copy of the coin`]);
  else out.push({ status: "note", what: `the pool was created by ${r.pool.creator}. Not checked: give --creator <wallet> to check it` });
  return out;
}

// The chain reads. A mint that isn't Token-2022 is a Refuse (readMint); a missing mint reads as null and fails its check.
export async function readLaunch(conn, client, mint, config) {
  const mi = await readMint(conn, mint);
  let meta = null; try { meta = await getTokenMetadata(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID); } catch { /* reported by the mint check */ }
  const [cfgAcc] = await conn.getMultipleAccountsInfo([config], "confirmed");
  const conf = cfgAcc?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID) ? await client.state.getPoolConfig(config) : null;
  const found = await client.state.getPoolByBaseMint(mint); // whichever pool the mint really has, on whatever config
  return { mi, meta, conf, pool: found ? (found.account.poolState ?? found.account) : null, poolAddr: found?.publicKey ?? null };
}

export async function verify(o, say = console.log) {
  const client = new DynamicBondingCurveClient(o.conn, "confirmed");
  const cluster = await clusterOf(o.conn); // never print the RPC address: it carries the key
  const r = await readLaunch(o.conn, client, o.mint, o.config);
  const checks = launchChecks(r, o);
  say(`\nVerify ${o.mint} on ${cluster} (read only, nothing is sent)\n  config      ${o.config}\n  fee wallet  ${o.feeWallet}\n  creator     ${o.creator ?? "not given"}${r.meta ? `\n  coin        ${r.meta.name} / ${r.meta.symbol}  ${r.meta.uri}` : ""}${r.poolAddr ? `\n  pool        ${r.poolAddr}` : ""}\n`);
  for (const c of checks) say(`  ${c.status.padEnd(4)} ${c.what}`);
  const failed = checks.filter((c) => c.status === "FAIL").length;
  say(failed ? `\n${failed} check${failed === 1 ? "" : "s"} FAILED. Do not set MINT: this is not the coin we configured.` : "\nAll checks passed.");
  return { checks, failed };
}

export function optsFromArgs(argv) {
  const { args } = parseArgs(argv, FLAGS);
  const num = (k, d) => (args[k] === undefined ? d : positiveNumber(args[k], k));
  return {
    conn: connect(args.rpc), mint: pubkeyOf(args.mint ?? refuse("Give the coin with --mint <MINT>."), "mint"),
    config: pubkeyOf(args.config ?? PROD_CONFIG, "config"), feeWallet: pubkeyOf(args["fee-wallet"] ?? FEE_WALLET, "fee-wallet"),
    creator: args.creator === undefined ? null : pubkeyOf(args.creator, "creator"),
    curve: { startMcap: num("start-mcap", DEFAULTS.startMcap), gradMcap: num("grad-mcap", DEFAULTS.gradMcap), poolFeeBps: args["pool-fee-bps"] === undefined ? DEFAULTS.poolFeeBps : Number(args["pool-fee-bps"]) },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const r = await verify(optsFromArgs(process.argv.slice(2))); if (r.failed) process.exitCode = 1; }
  catch (e) { console.error(e instanceof Refuse ? "REFUSING: " + e.message : "FAILED: " + String(e.message).replace(/api-key=[^&\s"')]+/gi, "api-key=hidden")); process.exitCode = 1; }
}
