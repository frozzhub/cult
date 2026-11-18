// End-to-end rehearsal of the curve launch with a throwaway token ("Tithe Rehearsal", never CULT), through the REAL code paths:
// scripts/launch-curve.mjs, scripts/fee-ops.mjs and scripts/migrate-curve.mjs are imported and called, not copied.
//
//   node scripts/rehearse-curve.mjs --rpc <URL> [--deployer-keypair f] [--trader-keypair f] [--state-dir d] [--cap-sol 0.075] [--go]
//
// The deployer is creator, fee wallet, fee key and migration payer; the trader buys and sells. Defaults are the two mainnet test
// wallets in program-keys/mainnet/ (Kay authorised mainnet test transactions with exactly these two wallets for this).
// Steps: launch (with a team buy and its refund) -> buy -> refund -> sell -> sweep the curve vault -> buy through to graduation ->
// migrate -> buy and sell on the DAMM v2 pool -> refund -> sweep after graduation -> claim. Every step asserts balances from chain.
// A SOL budget guard runs before every step: the spend so far (both wallets, from chain) must stay under --cap-sol, or it stops.
// Dry run without --go (balances, the plan, a simulation of the launch, nothing sent). Re-running resumes: finished steps are
// skipped (state in <state-dir>/rehearsal.json) and every send settles from its saved signature.
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import BN from "bn.js";
import { PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getMint } from "@solana/spl-token";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { DynamicBondingCurveClient, SwapMode, getCurrentPoint, getSwapQuoteTransferFees } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { SOL_MINT, Refuse, refuse, sol, parseArgs, loadKey, connect, clusterOf, lamportsOf, tilde, readJson, writeJson, makeSender, ata, readTokenAccounts, fetchJson, buildCurve, curvePlan } from "./lib/curve.mjs";
import { runLaunch, REHEARSAL_NAME } from "./launch-curve.mjs";
import { runMigrate, loadPool } from "./migrate-curve.mjs";
import { sweep, refund, claim, gather } from "./fee-ops.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FLAGS = { value: ["rpc", "deployer-keypair", "trader-keypair", "state-dir", "cap-sol", "team-buy", "trader-buy", "start-mcap", "grad-mcap"], flag: ["go", "skip-markets"] };
const bn = (x) => BigInt(x.toString());
const tok = (x) => (Number(x) / 1e6).toLocaleString("en", { maximumFractionDigits: 3 });
const feeOf = (g) => (g * 1000n + 9999n) / 10000n; // Token-2022 rounds the fee up

export async function rehearse(o, say = console.log) {
  const { conn } = o;
  const cluster = await clusterOf(conn);
  const dir = resolve(o.stateDir); mkdirSync(dir, { recursive: true });
  const stateFile = join(dir, "rehearsal.json");
  const S = readJson(stateFile, { done: {}, checks: [], markets: {}, v: {} });
  const save = () => { if (o.go) writeJson(stateFile, S); };
  const dep = o.deployer, trd = o.trader;
  const lam = async (pk) => BigInt(await conn.getBalance(pk, "confirmed"));
  const nowTotal = async () => (await lam(dep.publicKey)) + (await lam(trd.publicKey));
  if (o.go && S.startLamports === undefined) { S.startLamports = (await nowTotal()).toString(); S.startDeployer = (await lam(dep.publicKey)).toString(); S.startTrader = (await lam(trd.publicKey)).toString(); save(); }
  const start = BigInt(S.startLamports ?? (await nowTotal()));
  const spent = async () => start - (await nowTotal());
  const cap = o.capLamports;
  const guard = async (label, extra = 0n) => {
    const s = await spent();
    if (s + extra > cap) throw new Refuse(`BUDGET: before "${label}" the rehearsal has spent ${sol(s)} and the step needs up to ${sol(extra)} more; the cap is ${sol(cap)}. Stopping; nothing more was sent. Re-run with a higher --cap-sol only if you accept that.`);
    return s;
  };
  const check = (step, name, pass, detail) => {
    S.checks.push({ step, name, pass: !!pass, detail: String(detail) }); save();
    say(`    ${pass ? "PASS" : "FAIL"}  ${name}  ${detail}`);
    if (!pass) throw new Refuse(`Assertion failed in "${step}": ${name} (${detail}). Stopping; read ${stateFile}.`);
  };
  const step = async (name, extra, fn) => {
    if (S.done[name]) { say(`\n[skip] ${name} (done)`); return; }
    const s = await guard(name, extra);
    say(`\n[${name}]  spent so far ${sol(s)} of ${sol(cap)}`);
    await fn();
    S.done[name] = true; save();
  };

  const cfg = buildCurve({ startMcap: o.startMcap, gradMcap: o.gradMcap });
  const plan = curvePlan(cfg);
  say(`
Rehearsal (${o.go ? "LIVE" : "dry run, add --go to send"}) on ${conn.rpcEndpoint} (${cluster}); token "${REHEARSAL_NAME}"
  deployer ${dep.publicKey} (creator, fee wallet, fee key, migration payer) holds ${sol(await lam(dep.publicKey))}
  trader   ${trd.publicKey} holds ${sol(await lam(trd.publicKey))}
  budget   cap ${sol(cap)} total spend across both wallets (spent so far ${sol(await spent())})
  curve    start mcap ${o.startMcap} SOL, graduation mcap ${o.gradMcap} SOL -> graduation needs ${sol(plan.thresholdLamports)} raised; team buy ${sol(o.teamBuy)}, trader first buy ${sol(o.traderBuy)}`);

  const launchOpts = {
    conn, creator: dep, feeKey: dep, feeWallet: dep.publicKey, name: REHEARSAL_NAME, symbol: "TITHE", uri: "", allowMissingUri: true, tokenAuthority: "immutable",
    startMcap: o.startMcap, gradMcap: o.gradMcap, poolFeeBps: 25, teamBuyLamports: o.teamBuy, stateDir: dir, go: o.go, newMint: false,
  };
  if (!o.go) { await runLaunch(launchOpts, say); say("\nDry run only. Add --go to send."); return; }

  const client = new DynamicBondingCurveClient(conn, "confirmed"), cp = new CpAmm(conn);
  const sender = makeSender({ conn, dir, name: "rehearse-curve", say });
  const fopts = () => ({ conn, mint: new PublicKey(S.mint), feeKey: dep, stateDir: dir, go: true });
  const mintPk = () => new PublicKey(S.mint);
  const account = async (owner) => { const a = ata(mintPk(), owner); return (await readTokenAccounts(conn, mintPk(), [a])).get(a.toBase58()) ?? { amount: 0n, withheld: 0n }; };
  const pool = () => loadPool(client, mintPk());

  // ---- curve swaps (the same SDK calls the site and the spike use) ----
  const curveSwap = async (who, sell, amountIn, label, partial = false) => {
    const mode = partial ? SwapMode.PartialFill : SwapMode.ExactIn;
    const p = await client.state.getPool((await pool()).address), config = await client.state.getPoolConfig(p.poolState.config);
    const q = client.pool.swapQuote2({
      virtualPool: p, config, swapBaseForQuote: sell, amountIn, slippageBps: 100, hasReferral: false, eligibleForFirstSwapWithMinFee: false,
      currentPoint: await getCurrentPoint(conn, config.activationType), swapMode: mode, ...(await getSwapQuoteTransferFees(conn, config, { baseMint: mintPk() })),
    });
    const tx = await client.pool.swap2({ owner: who.publicKey, pool: (await pool()).address, swapBaseForQuote: sell, referralTokenAccount: null, swapMode: mode, amountIn, minimumAmountOut: q.minimumAmountOut });
    const r = await sender.send(label, tx.instructions.filter((ix) => !(ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3)), [who]);
    S.v[label] = r.sig; save();
    return { q, sig: r.sig };
  };
  // DAMM v2 swaps, fee-aware like Meteora's SDK (and Jupiter): the quote nets the transfer fee on both legs.
  const dammSwap = async (who, buying, amountIn, label) => {
    const dammPool = new PublicKey(S.dammPool);
    const poolState = await cp.fetchPoolState(dammPool);
    const info = { mint: await getMint(conn, mintPk(), "confirmed", TOKEN_2022_PROGRAM_ID), currentEpoch: (await conn.getEpochInfo("confirmed")).epoch };
    const slot = await conn.getSlot("confirmed"), time = (await conn.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
    const q = cp.getQuote({
      inAmount: amountIn, inputTokenMint: buying ? SOL_MINT : mintPk(), slippage: 1, poolState, currentTime: time, currentSlot: slot,
      ...(buying ? { outputTokenInfo: info } : { inputTokenInfo: info }), tokenADecimal: 6, tokenBDecimal: 9,
    });
    const tx = await cp.swap({
      payer: who.publicKey, pool: dammPool, inputTokenMint: buying ? SOL_MINT : mintPk(), outputTokenMint: buying ? mintPk() : SOL_MINT, amountIn, minimumAmountOut: q.minSwapOutAmount,
      tokenAMint: poolState.tokenAMint, tokenBMint: poolState.tokenBMint, tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault,
      tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
    });
    const r = await sender.send(label, tx.instructions.filter((ix) => !(ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3)), [who]);
    S.v[label] = r.sig; save();
    return { q, sig: r.sig };
  };

  // ---- what DexScreener and Jupiter show ----
  const markets = async (label) => {
    if (o.skipMarkets) return;
    const m = S.v.mint;
    const dx = await fetchJson(`https://api.dexscreener.com/tokens/v1/solana/${m}`);
    const jt = await fetchJson(`https://lite-api.jup.ag/tokens/v2/search?query=${m}`);
    const jq = await fetchJson(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${m}&amount=1000000&slippageBps=100`);
    const jtok = Array.isArray(jt.json) ? jt.json.find((t) => t.id === m) : null;
    S.markets[label] = {
      at: new Date().toISOString(),
      dexscreener: { status: dx.status, pairs: Array.isArray(dx.json) ? dx.json.map((p) => ({ dexId: p.dexId, pair: p.pairAddress, priceNative: p.priceNative, liquidity: p.liquidity, marketCap: p.marketCap })) : dx.text.slice(0, 120) },
      jupiterToken: { status: jt.status, found: !!jtok, launchpad: jtok?.launchpad, liquidity: jtok?.liquidity, mcap: jtok?.mcap, organicScore: jtok?.organicScore, audit: jtok?.audit, holderCount: jtok?.holderCount },
      jupiterQuote: { status: jq.status, routes: jq.json?.routePlan?.map((p) => p.swapInfo.label), out: jq.json?.outAmount, error: jq.json?.error },
    };
    save();
    say(`    markets (${label}): ${JSON.stringify(S.markets[label])}`);
  };

  // 1. launch ----------------------------------------------------------------------------------------------------------
  await step("1 launch (team buy + refund)", o.teamBuy + 20_000_000n, async () => {
    const r = await runLaunch(launchOpts, say);
    if (!r) throw new Refuse("The launch was refused (see above); nothing more was sent.");
    S.mint = r.mint.toBase58(); S.config = r.config.toBase58(); S.pool = r.pool.toBase58(); S.v.mint = S.mint; save();
    const g = await gather(fopts());
    check("launch", "transfer fee 10%, no config authority, withdraw authority = fee wallet", g.mi.fee.bps === 1000 && g.mi.fee.configAuthority === null && g.mi.fee.withdrawAuthority?.equals(dep.publicKey), `bps ${g.mi.fee.bps}, config ${g.mi.fee.configAuthority}, withdraw ${g.mi.fee.withdrawAuthority}`);
    check("launch", "mint authority and freeze authority are gone", g.mi.mintAuthority === null && g.mi.freezeAuthority === null, `${g.mi.mintAuthority} / ${g.mi.freezeAuthority}`);
    check("launch", "stored config threshold, swap base amount and migration base match the plan", bn(g.config.migrationQuoteThreshold) === plan.thresholdLamports && bn(g.config.swapBaseAmount) === plan.soldTokensRaw && bn(g.config.migrationBaseThreshold) === plan.migrationBaseRaw, `threshold ${g.config.migrationQuoteThreshold}, swap ${g.config.swapBaseAmount}, migration ${g.config.migrationBaseThreshold}`);
    const a = await account(dep.publicKey);
    check("launch", "team buy tokens are in the creator's account with the 10% released by the refund step", a.amount > 0n && a.withheld === 0n, `${tok(a.amount)} tokens, ${tok(a.withheld)} withheld`);
    S.v.teamBuyTokens = a.amount.toString(); save();
    await markets("after launch");
  });

  // 2. buy on the curve -----------------------------------------------------------------------------------------------
  await step("2 buy on the curve", o.traderBuy + 5_000_000n, async () => {
    const b = await account(trd.publicKey), sb = await lam(trd.publicKey);
    await curveSwap(trd, false, new BN(o.traderBuy.toString()), "buy on the curve");
    const a = await account(trd.publicKey), sa = await lam(trd.publicKey);
    const gross = a.amount + a.withheld - b.amount - b.withheld;
    check("buy", "SOL left the trader and tokens arrived", sa < sb && gross > 0n, `SOL ${sol(sb)} -> ${sol(sa)}, gross tokens ${tok(gross)}`);
    check("buy", "10% of what arrived is withheld in the buyer's account", a.withheld - b.withheld === feeOf(gross), `withheld ${a.withheld - b.withheld} vs 10% of ${gross} rounded up = ${feeOf(gross)}`);
  });

  // 3. refund ----------------------------------------------------------------------------------------------------------
  await step("3 refund the buyer", 3_000_000n, async () => {
    const b = await account(trd.publicKey);
    const r = await refund(fopts(), trd.publicKey.toBase58(), say);
    const a = await account(trd.publicKey);
    check("refund", "buyer ends with every token, nothing withheld, and signed nothing", a.withheld === 0n && a.amount === b.amount + b.withheld && r.refunded === b.withheld, `usable ${tok(b.amount)} -> ${tok(a.amount)}, withheld ${tok(b.withheld)} -> ${tok(a.withheld)}`);
  });

  // 4. sell ------------------------------------------------------------------------------------------------------------
  await step("4 sell on the curve", 3_000_000n, async () => {
    const b = await account(trd.publicKey), sb = await lam(trd.publicKey), g0 = await gather(fopts());
    const amount = b.amount / 2n;
    await curveSwap(trd, true, new BN(amount.toString()), "sell on the curve");
    const a = await account(trd.publicKey), sa = await lam(trd.publicKey), g1 = await gather(fopts());
    check("sell", "tokens left the seller and SOL came back", a.amount === b.amount - amount && sa > sb, `tokens ${tok(b.amount)} -> ${tok(a.amount)}, SOL ${sol(sb)} -> ${sol(sa)}`);
    check("sell", "10% of the sold tokens is withheld in the curve's vault (so a sell into any pool pays 10%)", g1.baseVaultAcct.withheld - g0.baseVaultAcct.withheld === feeOf(amount), `vault withheld +${g1.baseVaultAcct.withheld - g0.baseVaultAcct.withheld} vs ${feeOf(amount)}`);
  });

  // 5. sweep the curve vault ---------------------------------------------------------------------------------------------
  await step("5 sweep the curve vault to the treasury", 3_000_000n, async () => {
    const g0 = await gather(fopts()), before = g0.treasuryAcct?.amount ?? 0n, w = g0.baseVaultAcct.withheld;
    const r = await sweep(fopts(), say);
    const g1 = await gather(fopts());
    check("sweep", "vault withheld is zero and the treasury gained exactly what was withheld", g1.baseVaultAcct.withheld === 0n && (g1.treasuryAcct?.amount ?? 0n) - before === w && r.swept === w, `vault ${tok(w)} -> ${tok(g1.baseVaultAcct.withheld)}, treasury ${tok(before)} -> ${tok(g1.treasuryAcct?.amount ?? 0n)}`);
  });

  // 6. buy through to graduation -----------------------------------------------------------------------------------------
  await step("6 buy through to graduation", 30_000_000n, async () => {
    const p = await pool(), g = await gather(fopts());
    const remaining = g.cs.remaining;
    const need = (remaining * 10_000n) / 9_975n + remaining / 50n + 20_000n; // the curve fee is on top; 2% of room, the rest is refunded by PartialFill
    const trader = (await lam(trd.publicKey)) >= need + 6_000_000n ? trd : dep;
    say(`    ${sol(remaining)} to go; the ${trader === trd ? "trader" : "deployer"} buys with up to ${sol(need)}`);
    await curveSwap(trader, false, new BN(need.toString()), "buy through to graduation", true);
    const g1 = await gather(fopts());
    check("graduation", "the curve is complete (raised at least the threshold)", g1.cs.complete, `${sol(g1.cs.quote)} of ${sol(g1.cs.threshold)}`);
    check("graduation", "it isn't migrated yet", !g1.cs.migrated, `isMigrated ${p.state.isMigrated}`);
    S.v.gradBuyer = trader.publicKey.toBase58(); save();
    await markets("curve complete, before migration");
  });

  // 7. refund the graduating buyer, so no tokens sit withheld in a wallet ------------------------------------------------
  await step("7 refund the graduating buyer", 3_000_000n, async () => {
    const who = new PublicKey(S.v.gradBuyer), b = await account(who);
    if (b.withheld === 0n) return say("    nothing withheld");
    const r = await refund(fopts(), who.toBase58(), say);
    const a = await account(who);
    check("refund", "refunded in full", a.withheld === 0n && a.amount === b.amount + b.withheld && r.refunded === b.withheld, `${tok(b.amount)} + ${tok(b.withheld)} -> ${tok(a.amount)}`);
  });

  // 8. migrate -------------------------------------------------------------------------------------------------------------
  await step("8 migrate to DAMM v2", 25_000_000n, async () => {
    const r = await runMigrate({ conn, mint: mintPk(), payer: dep, feeKey: dep, stateDir: dir, go: true }, say);
    check("migrate", "migrated, with the position locked and owned by the fee wallet", r?.status === "migrated" && r.positions.length >= 1, JSON.stringify({ status: r?.status, dammPool: String(r?.dammPool), positions: r?.positions?.map(String) }));
    S.dammPool = r.dammPool.toBase58(); S.v.dammVaults = r.vaults.map(String); save();
    const g = await gather(fopts());
    const vp = (await pool()).state;
    const reserveB = BigInt((await conn.getTokenAccountBalance(g.dp.tokenBVault, "confirmed")).value.amount);
    const near = (a, b, tolBps = 150n) => (a > b ? a - b : b - a) * 10_000n <= b * tolBps; // 1.5%
    check("migrate", "the DAMM v2 pool's SOL is about the plan (the curve's raise less the 10% scale-down)", near(reserveB, plan.poolDepositQuoteLamports, 300n), `pool SOL ${reserveB} vs plan ${plan.poolDepositQuoteLamports} (raise ${g.cs.quote})`);
    check("migrate", "withheld in the DAMM vault at migration is about 10% of the deposit", near(g.dammVaultA.withheld, plan.withheldAtMigrationRaw, 150n), `${g.dammVaultA.withheld} vs plan ${plan.withheldAtMigrationRaw}`);
    check("migrate", "the unused SOL was booked to Meteora's protocol fee, as the source says", near(bn(vp.protocolMigrationQuoteFeeAmount), plan.unusedQuoteBookedToProtocolLamports + plan.protocolMigrationFeeQuoteLamports, 500n), `booked ${vp.protocolMigrationQuoteFeeAmount} vs plan ${plan.unusedQuoteBookedToProtocolLamports + plan.protocolMigrationFeeQuoteLamports}`);
    check("migrate", "withdraw-withheld authority is still the fee wallet and the rate is still 10%", g.mi.fee.withdrawAuthority.equals(dep.publicKey) && g.mi.fee.bps === 1000 && g.mi.fee.configAuthority === null, `${g.mi.fee.withdrawAuthority} / ${g.mi.fee.bps} / ${g.mi.fee.configAuthority}`);
    await markets("after migration");
  });

  // 9. trade on the graduated pool -------------------------------------------------------------------------------------------
  await step("9 buy and sell on the DAMM v2 pool, refund", 8_000_000n, async () => {
    const buyIn = 2_000_000n; // 0.002 SOL
    const b = await account(trd.publicKey), sb = await lam(trd.publicKey);
    await dammSwap(trd, true, new BN(buyIn.toString()), "buy on the DAMM v2 pool");
    const a = await account(trd.publicKey), sa = await lam(trd.publicKey);
    const gross = a.amount + a.withheld - b.amount - b.withheld;
    check("damm buy", "SOL left the trader and tokens arrived with 10% withheld in the buyer's account", sa < sb && gross > 0n && a.withheld - b.withheld === feeOf(gross), `SOL ${sol(sb)} -> ${sol(sa)}, gross ${tok(gross)}, withheld +${a.withheld - b.withheld} vs ${feeOf(gross)}`);
    const r = await refund(fopts(), trd.publicKey.toBase58(), say);
    const a2 = await account(trd.publicKey);
    check("damm refund", "the buyer is whole again", a2.withheld === 0n && a2.amount === a.amount + a.withheld, `usable ${tok(a.amount)} -> ${tok(a2.amount)}`);
    const g0 = await gather(fopts());
    const amount = a2.amount / 3n, s2 = await lam(trd.publicKey);
    await dammSwap(trd, false, new BN(amount.toString()), "sell on the DAMM v2 pool");
    const a3 = await account(trd.publicKey), s3 = await lam(trd.publicKey), g1 = await gather(fopts());
    check("damm sell", "tokens left the seller and SOL came back", a3.amount === a2.amount - amount && s3 + 50_000n > s2, `tokens ${tok(a2.amount)} -> ${tok(a3.amount)}, SOL ${sol(s2)} -> ${sol(s3)}`);
    check("damm sell", "10% of the sold tokens is withheld in the DAMM vault", g1.dammVaultA.withheld - g0.dammVaultA.withheld === feeOf(amount), `+${g1.dammVaultA.withheld - g0.dammVaultA.withheld} vs ${feeOf(amount)}`);
    await markets("after DAMM trades");
  });

  // 10. sweep after graduation: the key proof ------------------------------------------------------------------------------------
  await step("10 sweep after graduation", 3_000_000n, async () => {
    const g0 = await gather(fopts()), before = g0.treasuryAcct?.amount ?? 0n, w = g0.dammVaultA.withheld + g0.mi.fee.withheld + (g0.baseVaultAcct?.withheld ?? 0n);
    check("sweep after graduation", "there is withheld to sweep (from the migration and the sell)", g0.dammVaultA.withheld > 0n, `DAMM vault ${tok(g0.dammVaultA.withheld)}, curve vault ${tok(g0.baseVaultAcct?.withheld ?? 0n)}, mint ${tok(g0.mi.fee.withheld)}`);
    const r = await sweep(fopts(), say);
    const g1 = await gather(fopts());
    check("sweep after graduation", "the fee wallet withdrew it from the graduated pool's vault: vault is zero, treasury gained exactly that", g1.dammVaultA.withheld === 0n && (g1.treasuryAcct?.amount ?? 0n) - before === w && r.swept === w, `vault ${tok(g0.dammVaultA.withheld)} -> ${tok(g1.dammVaultA.withheld)}, treasury ${tok(before)} -> ${tok(g1.treasuryAcct?.amount ?? 0n)}`);
    // The pool must be undisturbed: a trade after the sweep still works.
    await dammSwap(trd, true, new BN(1_000_000), "buy on the DAMM v2 pool after the sweep");
    check("sweep after graduation", "the pool still trades after the sweep", true, "buy landed");
    await refund(fopts(), trd.publicKey.toBase58(), say);
  });

  // 11. claim --------------------------------------------------------------------------------------------------------------------
  await step("11 claim partner fees", 3_000_000n, async () => {
    const g0 = await gather(fopts());
    const r = await claim(fopts(), say);
    check("claim", "the claim transactions put SOL in the fee wallet (read from each transaction)", r.steps >= 1 && r.received > 0n, `${r.steps} claim transaction(s), fee wallet received ${sol(r.received)} before their fees`);
  });

  // result -------------------------------------------------------------------------------------------------------------------------
  const spentEnd = await spent();
  const sigs = collectSigs(dir);
  S.result = { spentLamports: spentEnd.toString(), cap: cap.toString(), signatures: sigs, finishedAt: new Date().toISOString() }; save();
  say(`\nRehearsal finished: spent ${sol(spentEnd)} of the ${sol(cap)} cap across both wallets (start ${sol(start)}, end ${sol((await lam(dep.publicKey)) + (await lam(trd.publicKey)))}).
Mint ${S.mint}  curve pool ${S.pool}  DAMM v2 pool ${S.dammPool}
${sigs.length} transactions:\n${sigs.map((s) => `  ${s.label}  ${s.sig}`).join("\n")}`);
}

// Every landed transaction every sender in this folder logged, in order.
export function collectSigs(dir) {
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".log"))) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      const m = /^(\S+) (landed|resolved) (.+) ([1-9A-HJ-NP-Za-km-z]{80,90})( landed)?$/.exec(line);
      if (m && (m[2] === "landed" || m[5])) out.push({ at: m[1], label: m[3], sig: m[4] });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export function optsFromArgs(argv) {
  const { args } = parseArgs(argv, FLAGS);
  const key = (name, def, label) => loadKey({ file: args[name] ?? join(REPO, "program-keys", "mainnet", def), label }) ?? refuse(`No ${label}.`);
  return {
    conn: connect(args.rpc), deployer: key("deployer-keypair", "deployer.json", "deployer-keypair"), trader: key("trader-keypair", "test-trader.json", "trader-keypair"),
    stateDir: typeof args["state-dir"] === "string" ? tilde(args["state-dir"]) : join(REPO, "program-keys", "mainnet", "rehearsal-curve"),
    capLamports: lamportsOf(args["cap-sol"] ?? "0.075", "cap-sol"), teamBuy: lamportsOf(args["team-buy"] ?? "0.003", "team-buy"), traderBuy: lamportsOf(args["trader-buy"] ?? "0.004", "trader-buy"),
    startMcap: Number(args["start-mcap"] ?? 0.03), gradMcap: Number(args["grad-mcap"] ?? 0.033), go: !!args.go, skipMarkets: !!args["skip-markets"],
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await rehearse(optsFromArgs(process.argv.slice(2))); } catch (e) { console.error(e instanceof Refuse ? "STOPPED: " + e.message : e.stack || String(e)); process.exitCode = 1; }
}
