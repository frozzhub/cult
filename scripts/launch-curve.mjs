// Launch $CULT on Meteora's Dynamic Bonding Curve: one Token-2022 mint with a 10% transfer fee, a SOL-quoted curve with
// virtual reserves (no SOL from us), graduating into a DAMM v2 pool whose liquidity is permanently locked.
// Spec: docs/ROUTE-CURVE.md. Source-backed choices and their file:line: docs/build-log-curve-scripts.md.
//
//   node scripts/launch-curve.mjs --rpc <URL> --keypair <file> --uri https://<domain>/token.json \
//     [--name Cult --symbol CULT] [--fee-wallet <addr>] [--fee-keypair <file>] [--token-authority immutable|creator|partner] \
//     [--start-mcap 27.96 --grad-mcap 410.8 --pool-fee-bps 25] [--team-buy <SOL>] [--state-dir <dir>] [--go]
//
// The creator is whoever owns --keypair (a solana-keygen JSON array file, a Phantom-exported base58 file) or the CREATOR_KEY
// env var. It pays for everything and is the pool creator. The fee wallet (default the payout wallet) is the curve's
// feeClaimer, the withdraw-withheld authority, the leftover receiver and the owner of the locked liquidity position.
//
// Without --go it prints the plan, simulates the first transaction against the real programs (nothing is sent) and runs
// every refusal. With --go:
//   - the mint key and the config key are saved to <state-dir> BEFORE anything is sent, and read back;
//   - every transaction is signed and its signature saved (<state-dir>/launch-curve.pending.json) BEFORE it is sent;
//   - an unknown outcome is settled only from that signature's status, never by sending again;
//   - re-running after a crash finds the keys and the state file, reads what exists on chain and does only what is left;
//   - it ends with a read-back from chain of every property the design depends on.
// A finished launch in the state dir is never repeated; add --new-mint to launch another coin on purpose.
//
// Reuse: step grouping, key/state/pending-file handling and the settle loop come from scripts/launch.mjs (via lib/curve.mjs);
// the curve and fee settings from spikes/fee-test/dbc.mjs, which created, bought, refunded and sold on mainnet.
import { existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import BN from "bn.js";
import { Keypair, PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getTokenMetadata } from "@solana/spl-token";
import {
  DynamicBondingCurveClient, deriveDbcPoolAddress, DYNAMIC_BONDING_CURVE_PROGRAM_ID, DAMM_V2_PROGRAM_ID,
  TransferFeeWithheldAuthority, MigratedTransferFeeAuthorityOption,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  FEE_WALLET, FEE_WALLET_MIN_LAMPORTS, SOL_MINT, SUPPLY_TOKENS, DECIMALS, TRANSFER_FEE_BPS, TX_MAX, TOKEN_AUTHORITY,
  Refuse, refuse, sol, parseArgs, lamportsOf, positiveNumber, loadKey, pubkeyOf, connect, clusterOf, tilde, readJson, writeJson, saveSecret,
  parseSecret, buildCurve, curvePlan, ata, readMint, readTokenAccounts, refundIx, makeSender, sizeOf, checkUri,
} from "./lib/curve.mjs";
import { readFileSync } from "node:fs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FLAGS = {
  value: ["rpc", "keypair", "uri", "name", "symbol", "fee-wallet", "fee-keypair", "token-authority", "start-mcap", "grad-mcap", "pool-fee-bps", "team-buy", "state-dir"],
  flag: ["go", "new-mint", "allow-missing-uri"],
};
const U64_MAX = (1n << 64n) - 1n;
const LAUNCH_TYPICAL_LAMPORTS = 15_000_000n; // the spike's config + curve pool cost about 0.015 SOL
const LAUNCH_ESTIMATE_LAMPORTS = 25_000_000n; // what the balance check requires for it
const FEE_MARGIN = 3_000_000n;
const PRICE_IX_BYTES = 50; // the sender adds a compute-unit-price instruction (program key 32 + instruction 13)
// --allow-missing-uri exists for the rehearsal only: it is accepted for this one throwaway name and never for CULT.
export const REHEARSAL_NAME = "Tithe Rehearsal";

// ---- pure rules ------------------------------------------------------------------------------------------------------

// Every refusal that can be decided from what was read. `i` is plain data so the tests can feed it anything.
export function launchProblems(i) {
  const p = [];
  if (!i.name || i.name.length > 32) p.push("--name is 1 to 32 characters.");
  if (!i.symbol || i.symbol.length > 10) p.push("--symbol is 1 to 10 characters.");
  if (i.uri.length > 200) p.push("--uri is longer than 200 characters.");
  if (i.allowMissingUri && i.name !== REHEARSAL_NAME) p.push(`--allow-missing-uri is only for the rehearsal coin "${REHEARSAL_NAME}". The real launch must have a working token.json.`);
  if (!i.allowMissingUri && !i.uri) p.push("--uri is required: the token's metadata file (name, symbol, image). It can't be changed after launch when the token is immutable.");
  if (i.uri && i.uriCheck && !i.uriCheck.ok) p.push(`The metadata file isn't usable: ${i.uriCheck.why}`);
  if (i.feeKey && !i.feeKey.publicKey.equals(i.feeWallet)) p.push(`--fee-keypair is ${i.feeKey.publicKey}, not the fee wallet ${i.feeWallet}.`);
  if (i.creatorLamports === null) p.push("Can't read the creator wallet.");
  else if (i.creatorLamports < i.neededLamports) p.push(`The creator wallet ${i.creator} holds ${sol(i.creatorLamports)}; the steps left need about ${sol(i.neededLamports)} (account rent and fees${i.teamBuyLamports ? `, and the ${sol(i.teamBuyLamports)} team buy` : ""}). Send at least ${sol(i.neededLamports - i.creatorLamports)} more.`);
  if (i.feeWalletLamports === null) p.push("Can't read the fee wallet.");
  else if (i.feeWalletLamports < FEE_WALLET_MIN_LAMPORTS) p.push(`The fee wallet ${i.feeWallet} holds ${sol(i.feeWalletLamports)}; it needs at least ${sol(FEE_WALLET_MIN_LAMPORTS)} to pay for sweeps, refunds and claims. Send ${sol(FEE_WALLET_MIN_LAMPORTS - i.feeWalletLamports)} more.`);
  if (i.programsMissing?.length) p.push(`Not deployed on this cluster: ${i.programsMissing.join(", ")}.`);
  if (i.finished) p.push(`Already launched here (${i.finished}); nothing was sent. To launch another coin on purpose, add --new-mint.`);
  if (i.cluster === "an unknown cluster") p.push("This RPC is on an unknown cluster (a local validator?).");
  return p;
}

// What the stored config must say. Used on resume (flags changed after the config landed?) and as the final read-back.
export function configMismatches(c, want) {
  const bad = [];
  const eq = (k, a, b) => { if (String(a) !== String(b)) bad.push(`config ${k} is ${a}, expected ${b}`); };
  eq("quoteMint", c.quoteMint, SOL_MINT);
  eq("feeClaimer", c.feeClaimer, want.feeWallet);
  eq("leftoverReceiver", c.leftoverReceiver, want.feeWallet);
  eq("tokenType (Token-2022)", c.tokenType, 1);
  eq("tokenDecimal", c.tokenDecimal, DECIMALS);
  eq("transferFeeFlag", c.transferFeeFlag, 1);
  eq("transferFeeBasisPoints", c.transferFeeBasisPoints, TRANSFER_FEE_BPS);
  eq("transferFeeWithheldAuthority (partner)", c.transferFeeWithheldAuthority, TransferFeeWithheldAuthority.Partner);
  eq("migratedTransferFeeAuthorityOption (immutable)", c.migratedTransferFeeAuthorityOption, MigratedTransferFeeAuthorityOption.Immutable);
  eq("fixedTokenSupplyFlag", c.fixedTokenSupplyFlag, 1);
  eq("migrationOption (DAMM v2)", c.migrationOption, 1);
  eq("migrationFeeOption (customizable)", c.migrationFeeOption, 6);
  eq("migratedCollectFeeMode (compounding)", c.migratedCollectFeeMode, 2);
  eq("migratedCompoundingFeeBps", c.migratedCompoundingFeeBps, 0);
  eq("migratedPoolFeeBps", c.migratedPoolFeeBps, want.poolFeeBps);
  eq("partnerPermanentLockedLiquidityPercentage", c.partnerPermanentLockedLiquidityPercentage, 100);
  eq("creatorTradingFeePercentage", c.creatorTradingFeePercentage, 0);
  eq("migrationFeePercentage", c.migrationFeePercentage, 0);
  eq("tokenUpdateAuthority", c.tokenUpdateAuthority, want.tokenAuthorityCode);
  eq("migrationQuoteThreshold", c.migrationQuoteThreshold, want.thresholdLamports);
  eq("sqrtStartPrice", c.sqrtStartPrice, want.sqrtStartPrice);
  eq("preMigrationTokenSupply", c.preMigrationTokenSupply, BigInt(SUPPLY_TOKENS) * 10n ** BigInt(DECIMALS));
  eq("postMigrationTokenSupply", c.postMigrationTokenSupply, BigInt(SUPPLY_TOKENS) * 10n ** BigInt(DECIMALS));
  return bad;
}

// The mint must be exactly what the design needs. `meta` is the on-chain token metadata (or null).
export function mintMismatches(m, want, meta) {
  const bad = [];
  if (!m) return ["The mint doesn't exist."];
  if (m.decimals !== DECIMALS) bad.push(`mint has ${m.decimals} decimals, expected ${DECIMALS}`);
  if (m.supply !== BigInt(SUPPLY_TOKENS) * 10n ** BigInt(DECIMALS)) bad.push(`mint supply is ${m.supply}, expected ${SUPPLY_TOKENS} tokens`);
  if (m.mintAuthority !== null) bad.push(`mint authority is ${m.mintAuthority}, expected none`);
  if (m.freezeAuthority !== null) bad.push(`freeze authority is ${m.freezeAuthority}, expected none`);
  if (!m.fee) bad.push("mint has no transfer fee");
  else {
    if (m.fee.bps !== TRANSFER_FEE_BPS) bad.push(`transfer fee is ${m.fee.bps} bps, expected ${TRANSFER_FEE_BPS}`);
    if (m.fee.max !== U64_MAX) bad.push("transfer fee has a maximum per transfer");
    if (m.fee.configAuthority !== null) bad.push(`fee-config authority is ${m.fee.configAuthority}, expected none (the rate could change)`);
    if (!m.fee.withdrawAuthority || !m.fee.withdrawAuthority.equals(want.feeWallet)) bad.push(`withdraw-withheld authority is ${m.fee.withdrawAuthority}, expected the fee wallet ${want.feeWallet}`);
  }
  if (meta) {
    if (meta.name !== want.name) bad.push(`metadata name is "${meta.name}", expected "${want.name}"`);
    if (meta.symbol !== want.symbol) bad.push(`metadata symbol is "${meta.symbol}", expected "${want.symbol}"`);
    if (meta.uri !== want.uri) bad.push(`metadata uri is "${meta.uri}", expected "${want.uri}"`);
    const ua = meta.updateAuthority ?? null;
    if (want.tokenAuthority === "immutable" && ua !== null) bad.push(`metadata update authority is ${ua}, expected none`);
  } else bad.push("the mint has no on-chain metadata");
  return bad;
}

// ---- chain reads ------------------------------------------------------------------------------------------------------

async function readLaunch(conn, client, mint, config, creator) {
  const poolAddr = deriveDbcPoolAddress(SOL_MINT, mint, config);
  const [cfgAcc, poolAcc] = await conn.getMultipleAccountsInfo([config, poolAddr], "confirmed");
  const st = { poolAddr, configExists: false, poolExists: false, creatorWithheld: 0n, creatorBalance: 0n };
  if (cfgAcc) {
    if (!cfgAcc.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) refuse(`The config address ${config} is owned by another program.`);
    st.configExists = true; st.config = await client.state.getPoolConfig(config);
  }
  if (poolAcc) {
    if (!poolAcc.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) refuse(`The pool address ${poolAddr} is owned by another program.`);
    const vp = await client.state.getPool(poolAddr);
    st.poolExists = true; st.pool = vp.poolState ?? vp;
    const a = ata(mint, creator);
    const t = (await readTokenAccounts(conn, mint, [a])).get(a.toBase58());
    if (t) { st.creatorWithheld = t.withheld; st.creatorBalance = t.amount; }
  }
  return st;
}
const stripBudget = (ixs) => ixs.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));

// ---- the launch -------------------------------------------------------------------------------------------------------
// o = { conn, creator: Keypair, feeWallet: PublicKey, feeKey?: Keypair, name, symbol, uri, tokenAuthority, startMcap, gradMcap,
//       poolFeeBps, teamBuyLamports, stateDir, go, newMint, allowMissingUri }
export async function runLaunch(o, say = console.log) {
  const { conn, creator, feeWallet } = o;
  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const cfg = buildCurve({ startMcap: o.startMcap, gradMcap: o.gradMcap, poolFeeBps: o.poolFeeBps, tokenAuthority: o.tokenAuthority });
  const plan = curvePlan(cfg, { poolFeeBps: o.poolFeeBps });
  const teamBuy = o.teamBuyLamports ?? 0n;
  const stateDir = resolve(o.stateDir);
  const cluster = await clusterOf(conn);

  // Which launch: a saved unfinished one (resume), none (new keys), or a finished one (refuse).
  const stateFiles = existsSync(stateDir) ? readdirSync(stateDir).filter((f) => /^launch-curve-.+\.json$/.test(f) && !f.endsWith(".pending.json")) : [];
  const states = stateFiles.map((f) => ({ f: join(stateDir, f), s: readJson(join(stateDir, f)) })).filter((x) => x.s && x.s.creator === creator.publicKey.toBase58() && x.s.symbol === o.symbol);
  const unfinished = o.newMint ? [] : states.filter((x) => !x.s.finished), finished = o.newMint ? [] : states.filter((x) => x.s.finished);
  if (unfinished.length > 1) refuse(`More than one unfinished launch in ${stateDir}:\n${unfinished.map((x) => "  " + x.f).join("\n")}\nRemove the ones you don't want.`);
  let mintKp, configKp, resumeNote = "new keys, saved before the first send", stateFile = null, S;
  if (unfinished.length === 1) {
    S = unfinished[0].s; stateFile = unfinished[0].f;
    mintKp = parseSecret(readFileSync(join(stateDir, `mint-${S.mint}.json`), "utf8")) ?? refuse(`The mint key for ${S.mint} is missing from ${stateDir}.`);
    configKp = parseSecret(readFileSync(join(stateDir, `config-${S.config}.json`), "utf8")) ?? refuse(`The config key for ${S.config} is missing from ${stateDir}.`);
    resumeNote = `RESUMING the unfinished launch in ${stateFile}`;
  } else { mintKp = Keypair.generate(); configKp = Keypair.generate(); }
  const mint = mintKp.publicKey, config = configKp.publicKey;

  // Reads. Anything unreadable becomes a refusal below, never a guess.
  let creatorLamports = null, feeWalletLamports = null, programsMissing = [], st = null, uriCheck = null;
  try {
    [creatorLamports, feeWalletLamports] = (await conn.getMultipleAccountsInfo([creator.publicKey, feeWallet], "confirmed")).map((a) => BigInt(a?.lamports ?? 0));
    const progs = await conn.getMultipleAccountsInfo([DYNAMIC_BONDING_CURVE_PROGRAM_ID, DAMM_V2_PROGRAM_ID], "confirmed");
    if (!progs[0]?.executable) programsMissing.push(`the bonding-curve program ${DYNAMIC_BONDING_CURVE_PROGRAM_ID}`);
    if (!progs[1]?.executable) programsMissing.push(`the DAMM v2 program ${DAMM_V2_PROGRAM_ID}`);
    st = await readLaunch(conn, client, mint, config, creator.publicKey);
  } catch (e) { if (e instanceof Refuse) throw e; creatorLamports = null; }
  if (o.uri) uriCheck = await checkUri(o.uri);

  // Resuming: what already landed must be what these flags would have made.
  const want = { feeWallet, poolFeeBps: o.poolFeeBps, tokenAuthorityCode: TOKEN_AUTHORITY[o.tokenAuthority], thresholdLamports: plan.thresholdLamports, sqrtStartPrice: BigInt(cfg.sqrtStartPrice.toString()) };
  if (st?.configExists) {
    const bad = configMismatches(st.config, want);
    if (bad.length) refuse(`The config already on chain differs from these flags (change the flags back, or remove the state file and use --new-mint):\n  ${bad.join("\n  ")}`);
  }

  // Steps, from what exists on chain. The first buy rides in the pool's transaction (price known, nobody can trade in between).
  let built = null;
  const build = async () => {
    const buyer = teamBuy > 0n ? creator.publicKey : null;
    let minOut = new BN(1);
    if (buyer) {
      const q = client.pool.getQuoteFromInputAmount({ config: cfg, swapBaseForQuote: false, amountIn: new BN(teamBuy.toString()), slippageBps: 100, baseTransferFeeBasisPoints: TRANSFER_FEE_BPS });
      minOut = q.minimumAmountOut ?? new BN(1);
      built = { ...built, teamQuote: q };
    }
    const r = await client.partner.createConfigAndPoolWithFirstBuy({
      payer: creator.publicKey, config, feeClaimer: feeWallet, leftoverReceiver: feeWallet, quoteMint: SOL_MINT, ...cfg,
      transferFeeParameters: { transferFeeBasisPoints: TRANSFER_FEE_BPS, withheldAuthority: TransferFeeWithheldAuthority.Partner, migratedTransferFeeAuthorityOption: MigratedTransferFeeAuthorityOption.Immutable },
      preCreatePoolParam: { baseMint: mint, name: o.name, symbol: o.symbol, uri: o.uri || "", poolCreator: creator.publicKey },
      ...(buyer ? { firstBuyParam: { buyer, buyAmount: new BN(teamBuy.toString()), minimumAmountOut: minOut, referralTokenAccount: null } } : {}),
    });
    return { configIxs: stripBudget(r.createConfigTx.instructions), poolIxs: stripBudget(r.createPoolWithFirstBuyTx.instructions) };
  };
  const stepsLeft = (state, ixs) => {
    const s = [];
    if (!state.configExists) s.push({ name: "config", ixs: ixs.configIxs, signers: [creator, configKp] });
    if (!state.poolExists) s.push({ name: teamBuy > 0n ? "pool + team buy" : "pool", ixs: ixs.poolIxs, signers: [creator, mintKp] });
    if (state.poolExists && teamBuy > 0n && o.feeKey && state.creatorWithheld > 0n) s.push({ name: "refund the team buy's withheld 10%", solo: true, ixs: [refundIx({ mint, feeWallet, account: ata(mint, creator.publicKey) })], signers: [o.feeKey] });
    return s;
  };
  // As few transactions as fit, in order.
  const group = (steps) => {
    const g = [];
    for (const s of steps) {
      const last = g[g.length - 1];
      const merged = last && !s.solo ? [...last.ixs, ...s.ixs] : null;
      if (merged && sizeOf(merged, creator.publicKey) + PRICE_IX_BYTES <= TX_MAX) { last.names.push(s.name); last.ixs = merged; for (const k of s.signers) if (!last.signers.some((x) => x.publicKey.equals(k.publicKey))) last.signers.push(k); }
      else g.push({ names: [s.name], ixs: [...s.ixs], signers: [...s.signers] });
    }
    return g;
  };

  const sender = makeSender({ conn, dir: stateDir, name: "launch-curve", say });
  let groups = [], simulated = null;
  if (st && !programsMissing.length && !(creatorLamports === null)) {
    const ixs = await build();
    groups = group(stepsLeft(st, ixs));
    if (groups.length) {
      try { simulated = await sender.simulate(groups[0].ixs, groups[0].signers, [creator.publicKey]); } catch (e) { simulated = { err: String(e.message), logs: [] }; }
    }
  }
  const simCost = simulated?.accounts?.[0]?.lamports !== undefined && creatorLamports !== null ? creatorLamports - BigInt(simulated.accounts[0].lamports) : null;
  const rentLeft = st && !st.poolExists ? LAUNCH_ESTIMATE_LAMPORTS : 0n;
  const whole = simCost !== null && groups.length === 1; // the simulation covered everything that is left
  const neededLamports = (whole ? simCost : rentLeft + teamBuy) + FEE_MARGIN;
  const costLine = whole
    ? `simulated against the real programs: ${sol(simCost)} in all (about ${sol(simCost - teamBuy)} rent and fees${teamBuy ? ` + the ${sol(teamBuy)} team buy` : ""})`
    : `${simCost !== null ? `simulated tx 1 (${groups[0].names.join(" + ")}): ${sol(simCost)}; ` : ""}${st && !st.poolExists ? `about ${sol(LAUNCH_TYPICAL_LAMPORTS)} in all for rent and fees (what the mainnet spike cost; the balance check uses ${sol(rentLeft)} to be safe)${teamBuy ? ` + ${sol(teamBuy)} team buy` : ""}` : "nothing more to pay"}`;

  const problems = launchProblems({
    name: o.name, symbol: o.symbol, uri: o.uri || "", allowMissingUri: !!o.allowMissingUri, uriCheck, feeKey: o.feeKey, feeWallet, creator: creator.publicKey,
    creatorLamports, feeWalletLamports, neededLamports, teamBuyLamports: teamBuy, programsMissing, cluster,
    finished: finished.length ? finished[0].f : null, tokenAuthority: o.tokenAuthority,
  });
  if (simulated?.err) problems.push(`The first transaction fails when simulated against the real programs: ${JSON.stringify(simulated.err)}\n    ${simulated.logs.slice(-5).join("\n    ")}`);

  const pct = (x) => `${(Number(x * 10000n / (BigInt(SUPPLY_TOKENS) * 10n ** BigInt(DECIMALS))) / 100).toFixed(1)}%`;
  const tok = (x) => (Number(x / 10n ** BigInt(DECIMALS))).toLocaleString("en");
  const tq = built?.teamQuote;
  say(`
Plan (${o.go ? "LIVE" : "dry run, add --go to send"}) on ${conn.rpcEndpoint} (${cluster})
  creator      ${creator.publicKey}  holds ${creatorLamports === null ? "?" : sol(creatorLamports)}; pays for everything and is the pool creator (put it in EXCLUDE in wrangler.jsonc)
  fee wallet   ${feeWallet}  holds ${feeWalletLamports === null ? "?" : sol(feeWalletLamports)} (needs ${sol(FEE_WALLET_MIN_LAMPORTS)}): curve feeClaimer, withdraw-withheld authority, leftover receiver, owner of the locked LP position
  mint         ${mint}  (${o.name} / $${o.symbol}, ${DECIMALS} decimals, ${SUPPLY_TOKENS.toLocaleString("en")} supply)  ${resumeNote}
  token        Token-2022, ${TRANSFER_FEE_BPS / 100}% transfer fee for good (no fee-config authority), no mint or freeze authority, metadata update authority ${o.tokenAuthority === "immutable" ? "none (name, symbol and uri can never change)" : o.tokenAuthority}
  uri          ${o.uri || "(none, rehearsal only)"}  ${uriCheck ? (uriCheck.ok ? "reachable, has name, symbol, image" : "NOT USABLE") : ""}
  curve        starts at ${plan.startPriceSol.toExponential(3)} SOL per token (market cap ${o.startMcap} SOL), graduates at ${plan.graduationPriceSol.toExponential(3)} (market cap ${o.gradMcap} SOL); pool fee ${o.poolFeeBps / 100}% in SOL
  on the curve ${tok(plan.soldTokensRaw)} tokens (${pct(plan.soldTokensRaw)}) are sold; graduation needs ${sol(plan.thresholdLamports)} raised (buyers pay about ${sol(plan.buyersPayAtGraduationLamports)} with the curve fee on top)
  graduated    ${tok(plan.migrationBaseRaw)} tokens (${pct(plan.migrationBaseRaw)}) go to the DAMM v2 pool; the 10% fee on that transfer leaves ${tok(plan.withheldAtMigrationRaw)} withheld in the pool vault for the fee wallet
               the SOL side is scaled down by the same 10%: about ${sol(plan.poolDepositQuoteLamports)} goes into the pool and about ${sol(plan.unusedQuoteBookedToProtocolLamports + plan.protocolMigrationFeeQuoteLamports)} is booked to Meteora's protocol fee (see the build log)
               100% of the graduated liquidity is permanently locked; the fee wallet owns the position and claims its SOL fees
  team buy     ${teamBuy ? `${sol(teamBuy)} by the creator in the pool's own transaction${tq ? `: about ${tok(BigInt(tq.outputAmount.toString()))} tokens, of which 10% are withheld in the creator's account${o.feeKey ? " and released again by a refund step (--fee-keypair)" : " until the Worker (or fee-ops refund) releases them"}` : ""}` : "none"}
  cost         ${costLine}
  sends        ${groups.length ? groups.map((g, i) => `tx ${i + 1}: ${g.names.join(" + ")}`).join("\n               ") : st ? "nothing, everything exists already" : "(not planned: see the refusals)"}
`);
  if (problems.length) { console.error(problems.map((x) => "REFUSING: " + x).join("\n")); process.exitCode = 1; return null; }
  if (!o.go) return { dryRun: true, mint, plan };

  // From here on it is real. Keys and state are saved before anything is sent.
  if (!stateFile) {
    saveSecret(join(stateDir, `mint-${mint.toBase58()}.json`), mintKp);
    saveSecret(join(stateDir, `config-${config.toBase58()}.json`), configKp);
    stateFile = join(stateDir, `launch-curve-${mint.toBase58()}.json`);
    S = { mint: mint.toBase58(), config: config.toBase58(), pool: st.poolAddr.toBase58(), creator: creator.publicKey.toBase58(), feeWallet: feeWallet.toBase58(), name: o.name, symbol: o.symbol, uri: o.uri || "", startedAt: new Date().toISOString(), finished: false, txs: [] };
    writeJson(stateFile, S);
    say(`  mint key and config key saved in ${stateDir}`);
  }
  let expired = 0;
  for (;;) {
    await sender.resolvePending();
    st = await readLaunch(conn, client, mint, config, creator.publicKey);
    const ixs = await build();
    const g = group(stepsLeft(st, ixs));
    if (!g.length) break;
    const r = await sender.send(g[0].names.join(" + "), g[0].ixs, g[0].signers);
    S.txs.push({ label: g[0].names.join(" + "), sig: r.sig, status: r.status }); writeJson(stateFile, S);
    if (r.status === "expired") { if (++expired >= 3) refuse("The transaction expired three times. Check the RPC and run the same command again."); } else expired = 0;
  }

  // The read-back: everything the design depends on, from chain.
  const fin = await readLaunch(conn, client, mint, config, creator.publicKey);
  const mi = await readMint(conn, mint);
  let meta = null; try { meta = await getTokenMetadata(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID); } catch { /* reported below */ }
  const wantMint = { feeWallet, name: o.name, symbol: o.symbol, uri: o.uri || "", tokenAuthority: o.tokenAuthority };
  const bad = [...mintMismatches(mi, wantMint, meta && { name: meta.name, symbol: meta.symbol, uri: meta.uri, updateAuthority: meta.updateAuthority }), ...(fin.configExists ? configMismatches(fin.config, want) : ["the config doesn't exist"]), ...(fin.poolExists ? [] : ["the curve pool doesn't exist"])];
  if (fin.poolExists) {
    if (String(fin.pool.baseMint) !== String(mint)) bad.push("pool base mint differs");
    if (String(fin.pool.creator) !== String(creator.publicKey)) bad.push("pool creator differs");
    if (String(fin.pool.config) !== String(config)) bad.push("pool config differs");
  }
  if (bad.length) { S.verifyFailed = bad; writeJson(stateFile, S); refuse(`The launch ended in an unexpected state:\n  ${bad.join("\n  ")}\nRead ${join(stateDir, "launch-curve.log")}.`); }
  S.finished = true; S.finishedAt = new Date().toISOString(); writeJson(stateFile, S);
  say(`
Done, and checked on chain: the mint has a ${TRANSFER_FEE_BPS / 100}% transfer fee with no fee-config authority, the withdraw-withheld authority is the fee wallet, no mint or freeze authority, the curve pool and its config match.
Curve pool ${fin.poolAddr}  (config ${config})
Put these in wrangler.jsonc:
  "MINT": "${mint}",
  "EXCLUDE": "<existing wallets>,${creator.publicKey}"
Also not for airdrops (program-owned, they hold tokens): the curve pool's base vault ${fin.pool.baseVault ?? "?"}. After graduation add the DAMM v2 pool's vaults (scripts/migrate-curve.mjs prints them).
Next: scripts/fee-ops.mjs status --mint ${mint}; after graduation scripts/migrate-curve.mjs --mint ${mint}.
`);
  return { mint, config, pool: fin.poolAddr, txs: S.txs, plan };
}

// ---- CLI --------------------------------------------------------------------------------------------------------------

export function optsFromArgs(argv) {
  const { args } = parseArgs(argv, FLAGS);
  const creator = loadKey({ file: args.keypair, envName: "CREATOR_KEY", label: "keypair" }) ?? refuse("Give the creator's key with --keypair <file> or the CREATOR_KEY environment variable.");
  const feeKey = args["fee-keypair"] ? loadKey({ file: args["fee-keypair"], label: "fee-keypair" }) : null;
  const num = (k, d) => (args[k] === undefined ? d : positiveNumber(args[k], k));
  return {
    conn: connect(args.rpc), creator, feeKey, feeWallet: pubkeyOf(args["fee-wallet"] ?? FEE_WALLET, "fee-wallet"),
    name: args.name ?? "Cult", symbol: args.symbol ?? "CULT", uri: args.uri ?? "", tokenAuthority: args["token-authority"] ?? "immutable",
    startMcap: num("start-mcap", 27.96), gradMcap: num("grad-mcap", 410.8), poolFeeBps: args["pool-fee-bps"] === undefined ? 25 : Number(args["pool-fee-bps"]),
    teamBuyLamports: args["team-buy"] === undefined ? 0n : lamportsOf(args["team-buy"], "team-buy"),
    stateDir: typeof args["state-dir"] === "string" ? tilde(args["state-dir"]) : join(REPO, "program-keys", "mainnet"),
    go: !!args.go, newMint: !!args["new-mint"], allowMissingUri: !!args["allow-missing-uri"],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runLaunch(optsFromArgs(process.argv.slice(2))); } catch (e) { console.error(e instanceof Refuse ? "REFUSING: " + e.message : e.stack || String(e)); process.exitCode = 1; }
}
