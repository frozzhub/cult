// Fee operations for the curve coin: the manual fallback if the Worker stalls on launch night.
// Dry run by default; --go sends. Every command is safe to run twice (a second run finds nothing left to do).
//
//   node scripts/fee-ops.mjs status --rpc <URL> --mint <MINT>
//   node scripts/fee-ops.mjs sweep  --rpc <URL> --mint <MINT> --fee-keypair <file> [--go]
//   node scripts/fee-ops.mjs refund <tokenAccount|wallet> --rpc <URL> --mint <MINT> --fee-keypair <file> [--go]
//   node scripts/fee-ops.mjs claim  --rpc <URL> --mint <MINT> --fee-keypair <file> [--go]
//
// status  reads only: the 10% fee, who holds withheld tokens, the treasury, and what the fee wallet can claim.
// sweep   moves withheld tokens out of the program-owned vaults (the curve's base vault, the DAMM v2 token vault) and the mint
//         into the fee wallet's token account. Holders' accounts are never swept: they are refunded.
// refund  releases one account's own withheld tokens back into it, fee-free (the same rule the Worker applies: the owner is a
//         normal wallet, the account has no delegate and no close authority; a pool vault is refused, sweep it instead).
// claim   claims the partner trading fees on the curve (SOL), the partner's share of any SOL over the threshold, and, after
//         graduation, the SOL fees of the locked DAMM v2 position the fee wallet owns.
//
// The withdraw-withheld authority is independent of the fee-config authority, so it keeps working after graduation
// (token-2022 processor.rs:889-903, and DBC never touches it).
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import BN from "bn.js";
import { PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { DynamicBondingCurveClient, DAMM_V2_MIGRATION_FEE_ADDRESS, deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  Refuse, refuse, sol, money, quoteNameOf, parseArgs, loadKey, pubkeyOf, connect, clusterOf, tilde, makeSender, ata, readMint, readTokenAccounts, sweepIxs, refundIx,
} from "./lib/curve.mjs";
import { loadPool, curveStatus } from "./migrate-curve.mjs";
import { positionsOf as positionsIn, claimPositionTx } from "../src/damm.js"; // shared with the Worker's hourly claim

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FLAGS = { value: ["rpc", "mint", "fee-keypair", "state-dir"], flag: ["go"] };
const bn = (x) => BigInt(x.toString());
const tok = (x) => (Number(x) / 1e6).toLocaleString("en", { maximumFractionDigits: 6 });
const stripPrice = (ixs) => ixs.filter((ix) => !(ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3));

// The refund rule, pure: may this account's withheld tokens be released back into it? (an on-curve wallet owner,
// no delegate, no close authority. A program-owned account, such as any pool's vault, pays the fee.)
export function refundVerdict(acct) {
  if (!acct) return { ok: false, why: "that isn't a token account of this coin." };
  if (!PublicKey.isOnCurve(acct.owner.toBytes())) return { ok: false, why: `it is owned by ${acct.owner}, a program-owned address (a pool vault?). Its withheld tokens belong to the fee wallet: use sweep.` };
  if (acct.delegate) return { ok: false, why: `it has a delegate (${acct.delegate}); a program could be acting as a pool vault.` };
  if (acct.closeAuthority) return { ok: false, why: `it has a close authority (${acct.closeAuthority}).` };
  if (acct.withheld === 0n) return { ok: false, why: "it has nothing withheld.", nothing: true };
  return { ok: true };
}

// Everything the commands read, in one place.
export async function gather(o) {
  const { conn, mint } = o;
  const client = new DynamicBondingCurveClient(conn, "confirmed"), cp = new CpAmm(conn);
  const pool = await loadPool(client, mint);
  if (!pool) refuse(`No bonding-curve pool found for ${mint}.`);
  const config = await client.state.getPoolConfig(pool.state.config);
  const feeWallet = new PublicKey(config.feeClaimer);
  const cs = curveStatus(pool.state, config);
  const mi = await readMint(conn, mint);
  if (!mi?.fee) refuse(`${mint} has no transfer fee.`);
  const g = { client, cp, pool, config, feeWallet, cs, mi, treasury: ata(mint, feeWallet), quote: quoteNameOf(config.quoteMint) }; // quote: "sol" | "usdc", for reading amounts
  const baseVault = new PublicKey(pool.state.baseVault);
  g.baseVault = baseVault;
  g.dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[Number(config.migrationFeeOption)];
  g.dammPool = deriveDammV2PoolAddress(g.dammConfig, mint, config.quoteMint); // the quote token the config names (SOL or USDC)
  g.dp = cs.migrated ? await cp.fetchPoolState(g.dammPool).catch(() => null) : null;
  const accts = [baseVault, g.treasury, ...(g.dp ? [g.dp.tokenAVault] : [])];
  const t = await readTokenAccounts(conn, mint, accts);
  g.baseVaultAcct = t.get(baseVault.toBase58());
  g.treasuryAcct = t.get(g.treasury.toBase58());
  g.dammVaultA = g.dp ? t.get(g.dp.tokenAVault.toBase58()) : null;
  g.feeWalletLamports = BigInt(await conn.getBalance(feeWallet, "confirmed"));
  return g;
}

// Sources a sweep may take from: program-owned vaults of this coin, never a holder's account.
export function sweepPlan(g) {
  const sources = [g.baseVaultAcct, g.dammVaultA].filter((a) => a && a.withheld > 0n);
  const mintWithheld = g.mi.fee.withheld;
  return { sources, fromMint: mintWithheld > 0n, total: sources.reduce((n, a) => n + a.withheld, 0n) + mintWithheld };
}

const need = (g, o) => {
  if (!o.feeKey) refuse("Give the fee wallet's key with --fee-keypair <file>.");
  if (!o.feeKey.publicKey.equals(g.feeWallet)) refuse(`--fee-keypair is ${o.feeKey.publicKey}, not the fee wallet ${g.feeWallet}.`);
  if (!g.mi.fee.withdrawAuthority?.equals(g.feeWallet)) refuse(`The withdraw-withheld authority is ${g.mi.fee.withdrawAuthority}, not the fee wallet: nothing here can be swept or refunded.`);
};

const positionsOf = (g) => (g.dp ? positionsIn(g.cp, g.dammPool, g.dp, g.feeWallet) : Promise.resolve([])); // pending fees as of now, including what the pool has accrued since the last claim

// ---- commands ---------------------------------------------------------------------------------------------------------

export async function status(o, say = console.log) {
  const g = await gather(o);
  const cluster = await clusterOf(o.conn);
  const fb = await g.client.state.getPoolFeeBreakdown(g.pool.address);
  const sp = sweepPlan(g);
  const surplus = await partnerSurplus(g);
  const pos = await positionsOf(g);
  say(`
Status of ${o.mint} on ${cluster}
  token        ${g.mi.fee.bps / 100}% transfer fee, config authority ${g.mi.fee.configAuthority ?? "none"}, withdraw-withheld authority ${g.mi.fee.withdrawAuthority ?? "none"} ${g.mi.fee.withdrawAuthority?.equals(g.feeWallet) ? "(the fee wallet)" : "(NOT the fee wallet)"}; supply ${tok(g.mi.supply)}; mint authority ${g.mi.mintAuthority ?? "none"}
  curve        ${g.cs.migrated ? "migrated" : g.cs.complete ? "complete, waiting for migration" : `${money(g.cs.quote, g.quote)} of ${money(g.cs.threshold, g.quote)} raised`}; pool ${g.pool.address}
  curve vault  ${g.baseVaultAcct ? `${tok(g.baseVaultAcct.amount)} tokens, ${tok(g.baseVaultAcct.withheld)} withheld (from sells)` : "?"}
  DAMM v2      ${g.dp ? `pool ${g.dammPool}; token vault ${g.dammVaultA ? `${tok(g.dammVaultA.amount)} tokens, ${tok(g.dammVaultA.withheld)} withheld` : "?"}` : g.cs.migrated ? `pool ${g.dammPool} (can't be read yet)` : "not yet"}
  in the mint  ${tok(g.mi.fee.withheld)} withheld (harvested there by anyone; sweep takes it)
  treasury     ${g.feeWallet}: ${sol(g.feeWalletLamports)}; token account ${g.treasuryAcct ? `${tok(g.treasuryAcct.amount)} tokens, ${tok(g.treasuryAcct.withheld)} withheld in it` : "none yet (sweep creates it)"}
  sweepable    ${tok(sp.total)} tokens now (${sp.sources.length} vault${sp.sources.length === 1 ? "" : "s"}${sp.fromMint ? " + the mint" : ""})
  claimable    curve partner fees ${money(bn(fb.partner.unclaimedQuoteFee), g.quote)}${surplus > 0n ? `; ${money(surplus, g.quote)} from the surplus over the threshold (taken once)` : ""}${g.cs.migrated ? `; locked position fees ${pos.length ? pos.map((p) => `${money(p.feeB, g.quote)} + ${tok(p.feeA)} tokens`).join(", ") : "none (no position found)"}` : ""}`);
  // Top holders: the biggest accounts and any withheld tokens waiting in them.
  let largest;
  try { largest = (await o.conn.getTokenLargestAccounts(o.mint, "confirmed")).value.slice(0, 20); } catch (e) { say(`  top accounts: this RPC refused the lookup (${String(e.message).slice(0, 60)}); use a keyed RPC`); return { g, sweep: sp, rows: [] }; }
  const got = await readTokenAccounts(o.conn, o.mint, largest.map((l) => l.address));
  const rows = largest.map((l) => got.get(l.address.toBase58())).filter(Boolean);
  say("  top accounts (largest first; PROGRAM = owned by a program, i.e. a vault; the refund rule applies to the rest)");
  for (const a of rows) say(`    ${a.address}  ${tok(a.amount).padStart(18)}  withheld ${tok(a.withheld).padStart(14)}  owner ${a.owner}${PublicKey.isOnCurve(a.owner.toBytes()) ? "" : "  PROGRAM"}${a.delegate ? "  delegate" : ""}`);
  const refundable = rows.filter((a) => refundVerdict(a).ok);
  if (refundable.length) say(`  refundable now: ${refundable.length} of the top accounts hold ${tok(refundable.reduce((n, a) => n + a.withheld, 0n))} withheld tokens (refund <account>)`);
  return { g, sweep: sp, rows };
}

export async function sweep(o, say = console.log) {
  const g = await gather(o);
  need(g, o);
  const sp = sweepPlan(g);
  const before = g.treasuryAcct?.amount ?? 0n;
  say(`
Sweep (${o.go ? "LIVE" : "dry run, add --go to send"}): ${tok(sp.total)} tokens from ${sp.sources.map((s) => `${s.address} (${tok(s.withheld)})`).join(", ") || "no vault"}${sp.fromMint ? ` and the mint (${tok(g.mi.fee.withheld)})` : ""} to ${g.treasury}`);
  if (sp.total === 0n) { say("  nothing is withheld in a vault or the mint."); return { swept: 0n }; }
  const ixs = sweepIxs({ mint: o.mint, feeWallet: g.feeWallet, sources: sp.sources.map((s) => s.address), fromMint: sp.fromMint });
  const sender = makeSender({ conn: o.conn, dir: resolve(o.stateDir), name: "fee-ops", say });
  const sim = await sender.simulate(ixs, [o.feeKey]);
  say(`  simulated    ${sim.err ? "FAILS " + JSON.stringify(sim.err) + "\n    " + sim.logs.slice(-4).join("\n    ") : "ok"}`);
  if (sim.err) { process.exitCode = 1; return { swept: 0n, err: sim.err }; }
  if (!o.go) return { swept: 0n, planned: sp.total };
  await sender.send("sweep withheld to the fee wallet", ixs, [o.feeKey]);
  // Withheld amounts only grow while we work (new sells), so the treasury gains at least what we read.
  const after = (await readTokenAccounts(o.conn, o.mint, [g.treasury])).get(g.treasury.toBase58());
  const gained = (after?.amount ?? 0n) - before;
  if (gained < sp.total) refuse(`The sweep landed but the treasury gained ${tok(gained)}, less than the ${tok(sp.total)} read before. Check ${g.treasury}.`);
  const left = await readTokenAccounts(o.conn, o.mint, sp.sources.map((s) => s.address));
  say(`  done         treasury ${tok(before)} -> ${tok(after.amount)} tokens (+${tok(gained)}); still withheld in the vaults: ${[...left.values()].map((a) => tok(a.withheld)).join(", ") || "0"}`);
  return { swept: gained };
}

export async function refund(o, target, say = console.log) {
  const g = await gather(o);
  need(g, o);
  if (!target) refuse("Say which account: refund <token account or wallet address>.");
  const addr = pubkeyOf(target, "target");
  // A wallet address means its token account; a token account of this coin is used as given.
  let acct = (await readTokenAccounts(o.conn, o.mint, [addr])).get(addr.toBase58());
  if (!acct) acct = (await readTokenAccounts(o.conn, o.mint, [ata(o.mint, addr)])).get(ata(o.mint, addr).toBase58());
  const v = refundVerdict(acct);
  say(`\nRefund (${o.go ? "LIVE" : "dry run, add --go to send"}): ${acct ? `${acct.address} owned by ${acct.owner}: ${tok(acct.amount)} usable, ${tok(acct.withheld)} withheld` : target}`);
  if (!v.ok) { say(`  ${v.nothing ? "nothing to do" : "REFUSING"}: ${v.why}`); if (!v.nothing) process.exitCode = 1; return { refunded: 0n }; }
  const ixs = [refundIx({ mint: o.mint, feeWallet: g.feeWallet, account: acct.address })];
  const sender = makeSender({ conn: o.conn, dir: resolve(o.stateDir), name: "fee-ops", say });
  const sim = await sender.simulate(ixs, [o.feeKey]);
  say(`  simulated    ${sim.err ? "FAILS " + JSON.stringify(sim.err) : "ok"}`);
  if (sim.err) { process.exitCode = 1; return { refunded: 0n, err: sim.err }; }
  if (!o.go) return { refunded: 0n, planned: acct.withheld };
  await sender.send("refund an account's own withheld tokens", ixs, [o.feeKey]);
  const after = (await readTokenAccounts(o.conn, o.mint, [acct.address])).get(acct.address.toBase58());
  if (after.withheld !== 0n || after.amount < acct.amount + acct.withheld) refuse(`The refund landed but the account reads ${tok(after.amount)} usable and ${tok(after.withheld)} withheld (expected at least ${tok(acct.amount + acct.withheld)} and 0).`);
  say(`  done         usable ${tok(acct.amount)} -> ${tok(after.amount)}, withheld ${tok(acct.withheld)} -> ${tok(after.withheld)}`);
  return { refunded: acct.withheld };
}

// The partner's share of what the buys left over the migration threshold, 0 once withdrawn. From the SDK's own breakdown (the
// rehearsal's first version used reserve minus threshold, which includes Meteora's share and sent a withdrawal that paid 0).
export async function partnerSurplus(g) {
  if (!g.cs.complete) return 0n;
  const s = await g.client.state.getPoolSurplus(g.pool.address);
  return s.partnerWithdrawn ? 0n : bn(s.partner);
}

// What a landed transaction put into a wallet, before its own fee: read from the transaction, never from two balance reads
// (the wallet pays fees and rents in the same minutes). Null when the node cannot show the transaction yet.
export async function grossGain(conn, sig, wallet) {
  const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 1 });
  if (!t?.meta) return null;
  const keys = t.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta.loadedAddresses }).keySegments().flat();
  const i = keys.findIndex((k) => k.equals(wallet));
  if (i < 0) return null;
  const net = BigInt(t.meta.postBalances[i]) - BigInt(t.meta.preBalances[i]);
  return keys[0].equals(wallet) ? net + BigInt(t.meta.fee) : net;
}

// The same for a USDC quote: what a landed transaction put into the wallet's token account, from the transaction's own token balances
// (the account is created by the claim when it is new, so a missing "pre" entry is 0). Null when the node cannot show it yet.
export async function grossTokenGain(conn, sig, owner, mint) {
  const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 1 });
  if (!t?.meta) return null;
  const mine = (list) => (list || []).find((b) => b.owner === owner.toBase58() && b.mint === mint.toBase58());
  const post = mine(t.meta.postTokenBalances);
  return post ? BigInt(post.uiTokenAmount.amount) - BigInt(mine(t.meta.preTokenBalances)?.uiTokenAmount.amount ?? 0) : null;
}

export async function claim(o, say = console.log) {
  const g = await gather(o);
  need(g, o);
  const sender = makeSender({ conn: o.conn, dir: resolve(o.stateDir), name: "fee-ops", say });
  const fb = await g.client.state.getPoolFeeBreakdown(g.pool.address);
  const steps = [];
  const curveFee = bn(fb.partner.unclaimedQuoteFee);
  if (curveFee > 0n) steps.push({ label: "claim curve partner fees", sol: curveFee, build: async () => g.client.partner.claimPartnerTradingFee({ feeClaimer: g.feeWallet, payer: g.feeWallet, pool: g.pool.address, maxBaseAmount: new BN(0), maxQuoteAmount: new BN(curveFee.toString()), receiver: g.feeWallet }) });
  const surplus = await partnerSurplus(g);
  if (g.cs.migrated && surplus > 0n) steps.push({ label: "withdraw the partner's share of the surplus", sol: surplus, build: async () => g.client.partner.partnerWithdrawSurplus({ feeClaimer: g.feeWallet, pool: g.pool.address }) });
  for (const p of await positionsOf(g)) {
    if (p.feeA === 0n && p.feeB === 0n) continue;
    steps.push({ label: `claim locked position fees ${p.position}`, sol: p.feeB, build: async () => claimPositionTx(g.cp, { owner: g.feeWallet, pool: g.dammPool, dp: g.dp, p }) });
  }
  say(`\nClaim (${o.go ? "LIVE" : "dry run, add --go to send"}): ${steps.length ? steps.map((s) => s.label + (s.sol ? ` (${money(s.sol, g.quote)})` : "")).join("; ") : "nothing to claim"}`);
  let got = 0n;
  for (const s of steps) {
    const tx = await s.build();
    const ixs = stripPrice(tx.instructions);
    const sim = await sender.simulate(ixs, [o.feeKey]);
    say(`  ${s.label}: simulated ${sim.err ? "FAILS " + JSON.stringify(sim.err) + " " + sim.logs.slice(-3).join(" | ") : "ok"}`);
    if (sim.err) { process.exitCode = 1; continue; }
    if (!o.go) continue;
    const r = await sender.send(s.label, ixs, [o.feeKey]);
    const gain = r.status !== "landed" ? null : g.quote === "sol" ? await grossGain(o.conn, r.sig, g.feeWallet) : await grossTokenGain(o.conn, r.sig, g.feeWallet, g.config.quoteMint);
    if (gain === null) say(`    sent; the amount received could not be read from the transaction yet (look at ${r.sig})`);
    else { got += gain; say(`    the fee wallet received ${money(gain, g.quote)}${g.quote === "sol" ? " (before this transaction's fee)" : ""}`); }
  }
  return { steps: steps.length, received: got };
}

// ---- CLI --------------------------------------------------------------------------------------------------------------
export function optsFromArgs(argv) {
  const { args, pos } = parseArgs(argv, FLAGS);
  const cmd = pos[0];
  if (!["status", "sweep", "refund", "claim"].includes(cmd)) refuse("Say what to do: status | sweep | refund <account> | claim.");
  return {
    cmd, target: pos[1], conn: connect(args.rpc), mint: pubkeyOf(args.mint ?? refuse("Give the coin with --mint <MINT>."), "mint"),
    feeKey: loadKey({ file: args["fee-keypair"], envName: "FEE_KEY", label: "fee-keypair" }),
    stateDir: typeof args["state-dir"] === "string" ? tilde(args["state-dir"]) : join(REPO, "program-keys", "mainnet"), go: !!args.go,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const o = optsFromArgs(process.argv.slice(2));
    if (o.cmd === "status") await status(o); else if (o.cmd === "sweep") await sweep(o); else if (o.cmd === "refund") await refund(o, o.target); else await claim(o);
  } catch (e) { console.error(e instanceof Refuse ? "REFUSING: " + e.message : e.stack || String(e)); process.exitCode = 1; }
}
