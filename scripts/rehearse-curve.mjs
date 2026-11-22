// End-to-end rehearsal of the curve launch with a throwaway token ("Tithe Rehearsal", never CULT), through the REAL code paths:
// scripts/launch-curve.mjs, scripts/fee-ops.mjs and scripts/migrate-curve.mjs are imported and called, not copied.
//
//   node scripts/rehearse-curve.mjs --rpc <URL> [--quote sol|usdc] [--deployer-keypair f] [--trader-keypair f] [--state-dir d] [--cap-sol 0.075] [--go]
//
// The deployer is creator, fee wallet, fee key and migration payer; the trader buys and sells. Defaults are the two mainnet test
// wallets in program-keys/mainnet/ (throwaway test wallets, used only for this).
// Steps: launch (with a team buy and its refund) -> buy -> refund -> sell -> sweep the curve vault -> buy through to graduation ->
// migrate -> buy and sell on the DAMM v2 pool -> refund -> sweep after graduation -> claim. Every step asserts balances from chain.
// A SOL budget guard runs before every step: the spend so far (both wallets, from chain) must stay under --cap-sol, or it stops.
// Dry run without --go (balances, the plan, a simulation of the launch, nothing sent). Re-running resumes: finished steps are
// skipped (state in <state-dir>/rehearsal.json) and every send settles from its saved signature.
//
// --quote usdc (default sol) rehearses a USDC-quoted curve: the market caps, the graduation threshold, every buy and sell, the DAMM v2
// pool and the claim are in USDC, and every balance assertion reads USDC from chain. There is no team buy (the creator holds no USDC).
// Step 0 first swaps some of the trader's SOL to USDC on Jupiter (api.jup.ag; the key is read from ~/.cult/prod.vars inside this script
// and never printed), sized to what the rehearsal needs plus 20%, through the Worker's own swap code (src/jupiter.js: the quote, the
// instructions inspected, the transaction compiled here, simulated against the quote, then signed). The swap's signature is saved
// BEFORE it is broadcast and a re-run settles it from that signature: it never swaps twice. The SOL spent on the swap counts in --cap-sol.
// The default state dir is program-keys/mainnet/rehearsal-usdc, never the SOL rehearsal's.
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import BN from "bn.js";
import { PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getMint, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { DynamicBondingCurveClient, SwapMode, getCurrentPoint, getSwapQuoteTransferFees } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { SOL_MINT, USDC_MINT, Refuse, refuse, sol, money, quoteOf, parseArgs, loadKey, connect, clusterOf, lamportsOf, amountOf, tilde, readJson, writeJson, settle, makeSender, ata, readTokenAccounts, fetchJson, buildCurve, curvePlan } from "./lib/curve.mjs";
import { runLaunch, REHEARSAL_NAME } from "./launch-curve.mjs";
import { runMigrate, loadPool } from "./migrate-curve.mjs";
import { sweep, refund, claim, gather } from "./fee-ops.mjs";
import { treasurySwap, quote as jupQuote } from "../src/jupiter.js"; // the Worker's own Jupiter code: inspect, simulate against the quote, sign

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FLAGS = { value: ["rpc", "quote", "deployer-keypair", "trader-keypair", "state-dir", "cap-sol", "team-buy", "trader-buy", "start-mcap", "grad-mcap"], flag: ["go", "skip-markets"] };
const bn = (x) => BigInt(x.toString());
const tok = (x) => (Number(x) / 1e6).toLocaleString("en", { maximumFractionDigits: 3 });
const feeOf = (g) => (g * 1000n + 9999n) / 10000n; // Token-2022 rounds the fee up

// Per quote: the curve (market caps, in the quote token), the budget, the trader's first buy and the two DAMM buys (raw units). The USDC
// curve is the SOL one's shape (1.1x) at a threshold of about 3.2 USDC: the DBC curve builder makes threshold ~ 0.54 x start market cap.
const DEFAULTS = {
  sol: { start: 0.03, grad: 0.033, cap: "0.075", traderBuy: "0.004", dammBuy: 2_000_000n, dammBuy2: 1_000_000n },
  usdc: { start: 6, grad: 6.6, cap: "0.13", traderBuy: "0.4", dammBuy: 400_000n, dammBuy2: 200_000n }, // cap: the swap's SOL (0.06 at 1 SOL = 69 USDC) + about 0.045 + headroom for the price
};
// USDC mode only. The swap uses the keyed API; the dry run's price estimate needs no key, so a dry run never reads the vars file.
const JUP = "https://api.jup.ag", JUP_FREE = "https://lite-api.jup.ag", SWAP_SLIPPAGE_BPS = 100, PROBE_LAMPORTS = 10_000_000n;
const INFRA_LAMPORTS = 45_000_000n; // the SOL rehearsal's spend without its trading was 0.031 SOL; two more USDC accounts and the swap's priority fee, with margin
const TRADER_SOL_EXTRA = 10_000_000n; // beside the swap: its priority fee and USDC account (the Worker allows 0.006), the coin's account (0.002), fees

// USDC (raw) the rehearsal trades: what the curve's buyers pay to graduate (2.5% room for the partial fill) and the two DAMM buys.
export const usdcNeed = (plan, d) => (plan.buyersPayAtGraduationLamports * 41n) / 40n + d.dammBuy + d.dammBuy2 + 50_000n;
export const usdcWanted = (need) => (need * 12n) / 10n; // what step 0 buys: the need plus 20% (price moves, fees, rounding)
// Lamports that buy `usdc` raw USDC at a probe quote's rate (probeIn lamports gave probeOut), rounded up.
export const solFor = (usdc, probeIn, probeOut) => (usdc * probeIn + probeOut - 1n) / probeOut;

// JUP_API_KEY from the vars file. The key goes only into the request header; nothing here prints or returns it in a message.
export function jupKey(file = join(homedir(), ".cult", "prod.vars")) {
  let text; try { text = readFileSync(file, "utf8"); } catch { return refuse(`Can't read ${file} for the Jupiter key.`); }
  const key = /^JUP_API_KEY\s*=\s*(.*)$/m.exec(text)?.[1]?.trim().replace(/^["']|["']$/g, "");
  return key || refuse(`${file} has no JUP_API_KEY.`);
}

// Step 0: the trader's USDC. `swap()` quotes, inspects, simulates and signs a Jupiter swap and returns { sig, lvbh, raw }; `have()` reads
// the trader's USDC. A swap signed by an earlier run is settled from its saved signature first, so a crash after the send never swaps twice.
export async function getUsdc({ conn, sender, S, save, have, need, swap, say }) {
  await sender.resolvePending();
  if (S.v.swap) {
    const r = await settle(conn, S.v.swap.sig, S.v.swap.lvbh);
    if (r.status === "landed") return say(`    the swap ${S.v.swap.sig} landed in an earlier run`);
    say(`    the earlier swap ${r.status === "failed" ? "failed on chain" : "never landed (its blockhash expired)"}; swapping again`);
    delete S.v.swap; save();
  }
  if ((await have()) >= need) return say("    the trader already holds enough USDC; no swap");
  const s = await swap();
  if (!(s.lvbh > 0)) refuse("Jupiter's swap carries no last-valid block height, so its outcome could not be settled safely. Nothing was sent.");
  S.v.swap = { sig: s.sig, lvbh: s.lvbh }; save(); // BEFORE broadcast
  const r = await sender.sendSigned("swap SOL for USDC", s.sig, s.raw, s.lvbh);
  if (r.status !== "landed") { delete S.v.swap; save(); refuse("The swap expired without landing, so nothing was spent. Run the same command again."); }
}

export async function rehearse(o, say = console.log) {
  const { conn } = o;
  const cluster = await clusterOf(conn);
  const dir = resolve(o.stateDir); mkdirSync(dir, { recursive: true });
  const stateFile = join(dir, "rehearsal.json");
  const quote = o.quote ?? "sol", Q = quoteOf(quote), usdc = quote === "usdc", D = DEFAULTS[quote];
  const fmt = (x) => money(x, quote);
  const S = readJson(stateFile, { done: {}, checks: [], markets: {}, v: {} });
  if (S.mint && (S.quote ?? "sol") !== quote) refuse(`${stateFile} is a ${S.quote ?? "sol"} rehearsal; this run is --quote ${quote}. Use its own --state-dir.`);
  S.quote = quote;
  const save = () => { if (o.go) writeJson(stateFile, S); };
  const dep = o.deployer, trd = o.trader;
  const lam = async (pk) => BigInt(await conn.getBalance(pk, "confirmed"));
  // The USDC account of a wallet, 0 when it has none yet; any other failure is thrown, never read as 0.
  const usdcOf = async (pk) => {
    try { return BigInt((await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(USDC_MINT, pk, true, TOKEN_PROGRAM_ID), "confirmed")).value.amount); }
    catch (e) { if (/could not find account|Invalid param/i.test(String(e.message))) return 0n; throw e; }
  };
  const qb = (pk) => (usdc ? usdcOf(pk) : lam(pk)); // the wallet's balance of the curve's quote token
  const nowTotal = async () => (await lam(dep.publicKey)) + (await lam(trd.publicKey));
  const nowUsdc = async () => (await usdcOf(dep.publicKey)) + (await usdcOf(trd.publicKey));
  if (o.go && S.startLamports === undefined) { S.startLamports = (await nowTotal()).toString(); S.startDeployer = (await lam(dep.publicKey)).toString(); S.startTrader = (await lam(trd.publicKey)).toString(); if (usdc) S.startUsdc = (await nowUsdc()).toString(); save(); }
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

  const cfg = buildCurve({ startMcap: o.startMcap, gradMcap: o.gradMcap, quote });
  const plan = curvePlan(cfg, { quote });
  say(`
Rehearsal (${o.go ? "LIVE" : "dry run, add --go to send"}) on ${conn.rpcEndpoint} (${cluster}); token "${REHEARSAL_NAME}"
  deployer ${dep.publicKey} (creator, fee wallet, fee key, migration payer) holds ${sol(await lam(dep.publicKey))}
  trader   ${trd.publicKey} holds ${sol(await lam(trd.publicKey))}${usdc ? ` and ${money(await usdcOf(trd.publicKey), quote)}` : ""}
  budget   cap ${sol(cap)} total spend across both wallets (spent so far ${sol(await spent())})
  curve    start mcap ${o.startMcap} ${Q.sym}, graduation mcap ${o.gradMcap} ${Q.sym} -> graduation needs ${fmt(plan.thresholdLamports)} raised; team buy ${usdc ? "none" : sol(o.teamBuy)}, trader first buy ${fmt(o.traderBuy)}`);

  // USDC: what the trader needs, what step 0 swaps for it and what that costs in SOL. Anything unknown is a refusal, never a guess.
  const problems = [];
  const jupEnv = { SOLANA_RPC_URL: conn.rpcEndpoint };
  const jupCfg = { jup: o.jupUrl ?? (o.go ? JUP : JUP_FREE), slippageBps: SWAP_SLIPPAGE_BPS };
  let need = 0n, solIn = 0n;
  const swap = async () => { // quote, inspect, simulate against the quote, sign: nothing is sent
    const s = await (o.treasurySwap ?? treasurySwap)(jupEnv, jupCfg, trd, { inputMint: SOL_MINT.toBase58(), inputProgram: TOKEN_PROGRAM_ID.toBase58(), outputMint: USDC_MINT.toBase58(), outputProgram: TOKEN_PROGRAM_ID.toBase58(), amount: solIn.toString() });
    return { ...s, raw: s.tx.serialize() };
  };
  const STEP0 = "0 swap SOL for USDC";
  // A resumed run whose swap is done plans nothing here: the trader's USDC is partly spent by now, and that is no reason to swap again.
  if (usdc && S.done[STEP0]) say("  USDC     step 0 (the swap) is done; the trader's USDC is read from chain at each step");
  else if (usdc) {
    if (o.go) jupEnv.JUP_API_KEY = jupKey(o.jupVars); // read here, before anything is sent, and never printed
    need = usdcNeed(plan, D);
    const have = await usdcOf(trd.publicKey), traderSol = await lam(trd.publicKey);
    let out = 0n, why = "no answer";
    try { out = BigInt((await jupQuote(jupEnv, jupCfg, { inputMint: SOL_MINT.toBase58(), outputMint: USDC_MINT.toBase58(), amount: PROBE_LAMPORTS.toString(), slippageBps: SWAP_SLIPPAGE_BPS })).outAmount); } catch (e) { why = String(e.message).slice(0, 120); }
    const buy = have >= need ? 0n : usdcWanted(need) - have;
    if (buy > 0n && out <= 0n) problems.push(`Jupiter gave no SOL price (${why}), so the swap can't be sized. Nothing was sent.`);
    else {
      solIn = buy > 0n ? solFor(buy, PROBE_LAMPORTS, out) : 0n;
      const estimate = solIn + INFRA_LAMPORTS;
      say(`  USDC     the rehearsal trades about ${money(need, quote)} (the curve's buyers pay ${money(plan.buyersPayAtGraduationLamports, quote)} to graduate, the two DAMM buys ${money(D.dammBuy + D.dammBuy2, quote)}); the trader holds ${money(have, quote)}
           ${buy > 0n ? `step 0 buys ${money(buy, quote)} (the need plus 20%) with ${sol(solIn)} of the trader's SOL on Jupiter at 1 SOL = ${(Number(out) / Number(PROBE_LAMPORTS) * 1000).toFixed(2)} USDC (${o.go ? "api.jup.ag" : "keyless estimate"}); what is not traded stays in the trader wallet` : "the trader holds enough: no swap"}
  budget   SOL ${sol(solIn)} for the swap + about ${sol(INFRA_LAMPORTS)} for rent and fees = about ${sol(estimate)} of the ${sol(cap)} cap; USDC ${money(buy, quote)} bought, ${money(need, quote)} expected to be traded`);
      if (estimate > cap) problems.push(`BUDGET: the plan needs about ${sol(estimate)} of SOL and the cap is ${sol(cap)}. Raise --cap-sol only if you accept that. Nothing was sent.`);
      if (traderSol < solIn + TRADER_SOL_EXTRA) problems.push(`The trader ${trd.publicKey} holds ${sol(traderSol)}; the swap and its accounts and fees need ${sol(solIn + TRADER_SOL_EXTRA)}. Send at least ${sol(solIn + TRADER_SOL_EXTRA - traderSol)} more to it.`);
      else if (!o.go && buy > 0n) {
        try { const s = await swap(); say(`  swap     simulated against the real programs: ok, pays out at least ${money(BigInt(s.minOut), quote)} (instructions inspected; not sent)`); } catch (e) { problems.push(`The swap is refused: ${e.message}`); }
      }
    }
  }
  if (o.go && problems.length) throw new Refuse(problems.join("\n"));
  if (problems.length) { console.error(problems.map((x) => "REFUSING: " + x).join("\n")); process.exitCode = 1; }

  const launchOpts = {
    conn, creator: dep, feeKey: dep, feeWallet: dep.publicKey, name: REHEARSAL_NAME, symbol: "TITHE", uri: "", allowMissingUri: true, tokenAuthority: "immutable",
    startMcap: o.startMcap, gradMcap: o.gradMcap, poolFeeBps: 25, teamBuyLamports: o.teamBuy, quote, stateDir: dir, go: o.go, newMint: false,
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
      inAmount: amountIn, inputTokenMint: buying ? Q.mint : mintPk(), slippage: 1, poolState, currentTime: time, currentSlot: slot,
      ...(buying ? { outputTokenInfo: info } : { inputTokenInfo: info }), tokenADecimal: 6, tokenBDecimal: Q.decimals,
    });
    const tx = await cp.swap({
      payer: who.publicKey, pool: dammPool, inputTokenMint: buying ? Q.mint : mintPk(), outputTokenMint: buying ? mintPk() : Q.mint, amountIn, minimumAmountOut: q.minSwapOutAmount,
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
    const jq = await fetchJson(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${Q.mint}&outputMint=${m}&amount=${usdc ? 100_000 : 1_000_000}&slippageBps=100`); // 0.1 USDC or 0.001 SOL
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

  // 0. USDC for the trader (USDC only) --------------------------------------------------------------------------------------
  if (usdc) await step(STEP0, solIn + 6_000_000n, async () => {
    await getUsdc({ conn, sender, S, save, need, have: () => usdcOf(trd.publicKey), swap, say });
    const have = await usdcOf(trd.publicKey);
    check("swap", "the trader holds the USDC the rehearsal needs, read from chain", have >= need, `${money(have, quote)} (needs ${money(need, quote)})`);
  });

  // The SOL a step may move on top of its fees and rents: the amount it trades. A USDC step trades USDC, not SOL.
  const solTrade = (x) => (usdc ? 0n : x);

  // 1. launch ----------------------------------------------------------------------------------------------------------
  await step(usdc ? "1 launch" : "1 launch (team buy + refund)", o.teamBuy + 20_000_000n, async () => {
    const r = await runLaunch(launchOpts, say);
    if (!r) throw new Refuse("The launch was refused (see above); nothing more was sent.");
    S.mint = r.mint.toBase58(); S.config = r.config.toBase58(); S.pool = r.pool.toBase58(); S.v.mint = S.mint; save();
    const g = await gather(fopts());
    check("launch", `the curve is quoted in ${Q.sym}`, g.quote === quote && g.config.quoteMint.equals(Q.mint), `${g.config.quoteMint}`);
    check("launch", "transfer fee 10%, no config authority, withdraw authority = fee wallet", g.mi.fee.bps === 1000 && g.mi.fee.configAuthority === null && g.mi.fee.withdrawAuthority?.equals(dep.publicKey), `bps ${g.mi.fee.bps}, config ${g.mi.fee.configAuthority}, withdraw ${g.mi.fee.withdrawAuthority}`);
    check("launch", "mint authority and freeze authority are gone", g.mi.mintAuthority === null && g.mi.freezeAuthority === null, `${g.mi.mintAuthority} / ${g.mi.freezeAuthority}`);
    check("launch", "stored config threshold, swap base amount and migration base match the plan", bn(g.config.migrationQuoteThreshold) === plan.thresholdLamports && bn(g.config.swapBaseAmount) === plan.soldTokensRaw && bn(g.config.migrationBaseThreshold) === plan.migrationBaseRaw, `threshold ${g.config.migrationQuoteThreshold}, swap ${g.config.swapBaseAmount}, migration ${g.config.migrationBaseThreshold}`);
    if (!usdc) {
      const a = await account(dep.publicKey);
      check("launch", "team buy tokens are in the creator's account with the 10% released by the refund step", a.amount > 0n && a.withheld === 0n, `${tok(a.amount)} tokens, ${tok(a.withheld)} withheld`);
      S.v.teamBuyTokens = a.amount.toString(); save();
    }
    await markets("after launch");
  });

  // 2. buy on the curve -----------------------------------------------------------------------------------------------
  await step("2 buy on the curve", solTrade(o.traderBuy) + 5_000_000n, async () => {
    const b = await account(trd.publicKey), sb = await qb(trd.publicKey);
    await curveSwap(trd, false, new BN(o.traderBuy.toString()), "buy on the curve");
    const a = await account(trd.publicKey), sa = await qb(trd.publicKey);
    const gross = a.amount + a.withheld - b.amount - b.withheld;
    check("buy", `${Q.sym} left the trader and tokens arrived`, (usdc ? sb - sa === o.traderBuy : sa < sb) && gross > 0n, `${fmt(sb)} -> ${fmt(sa)}${usdc ? ` (exactly the ${fmt(o.traderBuy)} bought with)` : ""}, gross tokens ${tok(gross)}`);
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
    const b = await account(trd.publicKey), sb = await qb(trd.publicKey), g0 = await gather(fopts());
    const amount = b.amount / 2n;
    const { q } = await curveSwap(trd, true, new BN(amount.toString()), "sell on the curve");
    const a = await account(trd.publicKey), sa = await qb(trd.publicKey), g1 = await gather(fopts());
    check("sell", `tokens left the seller and ${Q.sym} came back`, a.amount === b.amount - amount && sa > sb && (!usdc || sa - sb >= BigInt(q.minimumAmountOut.toString())), `tokens ${tok(b.amount)} -> ${tok(a.amount)}, ${fmt(sb)} -> ${fmt(sa)}${usdc ? ` (the quote's floor was ${fmt(BigInt(q.minimumAmountOut.toString()))})` : ""}`);
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
  await step("6 buy through to graduation", usdc ? 5_000_000n : 30_000_000n, async () => {
    const p = await pool(), g = await gather(fopts());
    const remaining = g.cs.remaining;
    const buyWith = (remaining * 10_000n) / 9_975n + remaining / 50n + 20_000n; // the curve fee is on top; 2% of room, the rest is refunded by PartialFill
    // USDC: only the trader holds any, so it must hold enough (read from chain) or nothing is sent.
    const trader = usdc ? trd : (await lam(trd.publicKey)) >= buyWith + 6_000_000n ? trd : dep;
    if (usdc && (await usdcOf(trd.publicKey)) < buyWith) throw new Refuse(`The trader holds ${fmt(await usdcOf(trd.publicKey))}; buying through to graduation needs up to ${fmt(buyWith)}. Nothing was sent.`);
    say(`    ${fmt(remaining)} to go; the ${trader === trd ? "trader" : "deployer"} buys with up to ${fmt(buyWith)}`);
    await curveSwap(trader, false, new BN(buyWith.toString()), "buy through to graduation", true);
    const g1 = await gather(fopts());
    check("graduation", "the curve is complete (raised at least the threshold)", g1.cs.complete, `${fmt(g1.cs.quote)} of ${fmt(g1.cs.threshold)}`);
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
    check("migrate", `the DAMM v2 pool is the coin against ${Q.sym}: the coin is side A, ${Q.sym} is side B`, g.dp.tokenAMint.equals(mintPk()) && g.dp.tokenBMint.equals(Q.mint), `${g.dp.tokenAMint} / ${g.dp.tokenBMint}`);
    check("migrate", `the DAMM v2 pool's ${Q.sym} is about the plan (the curve's raise less the 10% scale-down)`, near(reserveB, plan.poolDepositQuoteLamports, 300n), `pool ${Q.sym} ${reserveB} raw vs plan ${plan.poolDepositQuoteLamports} (raise ${g.cs.quote})`);
    check("migrate", "withheld in the DAMM vault at migration is about 10% of the deposit", near(g.dammVaultA.withheld, plan.withheldAtMigrationRaw, 150n), `${g.dammVaultA.withheld} vs plan ${plan.withheldAtMigrationRaw}`);
    check("migrate", `the unused ${Q.sym} was booked to Meteora's protocol fee, as the source says`, near(bn(vp.protocolMigrationQuoteFeeAmount), plan.unusedQuoteBookedToProtocolLamports + plan.protocolMigrationFeeQuoteLamports, 500n), `booked ${vp.protocolMigrationQuoteFeeAmount} vs plan ${plan.unusedQuoteBookedToProtocolLamports + plan.protocolMigrationFeeQuoteLamports}`);
    check("migrate", "withdraw-withheld authority is still the fee wallet and the rate is still 10%", g.mi.fee.withdrawAuthority.equals(dep.publicKey) && g.mi.fee.bps === 1000 && g.mi.fee.configAuthority === null, `${g.mi.fee.withdrawAuthority} / ${g.mi.fee.bps} / ${g.mi.fee.configAuthority}`);
    await markets("after migration");
  });

  // 9. trade on the graduated pool -------------------------------------------------------------------------------------------
  await step("9 buy and sell on the DAMM v2 pool, refund", solTrade(D.dammBuy) + 6_000_000n, async () => {
    const buyIn = D.dammBuy; // 0.002 SOL, or 0.4 USDC
    const b = await account(trd.publicKey), sb = await qb(trd.publicKey);
    await dammSwap(trd, true, new BN(buyIn.toString()), "buy on the DAMM v2 pool");
    const a = await account(trd.publicKey), sa = await qb(trd.publicKey);
    const gross = a.amount + a.withheld - b.amount - b.withheld;
    check("damm buy", `${Q.sym} left the trader and tokens arrived with 10% withheld in the buyer's account`, (usdc ? sb - sa === buyIn : sa < sb) && gross > 0n && a.withheld - b.withheld === feeOf(gross), `${fmt(sb)} -> ${fmt(sa)}${usdc ? ` (exactly the ${fmt(buyIn)} bought with)` : ""}, gross ${tok(gross)}, withheld +${a.withheld - b.withheld} vs ${feeOf(gross)}`);
    const r = await refund(fopts(), trd.publicKey.toBase58(), say);
    const a2 = await account(trd.publicKey);
    check("damm refund", "the buyer is whole again", a2.withheld === 0n && a2.amount === a.amount + a.withheld, `usable ${tok(a.amount)} -> ${tok(a2.amount)}`);
    const g0 = await gather(fopts());
    const amount = a2.amount / 3n, s2 = await qb(trd.publicKey);
    const { q: dq } = await dammSwap(trd, false, new BN(amount.toString()), "sell on the DAMM v2 pool");
    const a3 = await account(trd.publicKey), s3 = await qb(trd.publicKey), g1 = await gather(fopts());
    // SOL pays the transaction fee in the same balance; USDC does not, so its gain must reach the quote's floor.
    check("damm sell", `tokens left the seller and ${Q.sym} came back`, a3.amount === a2.amount - amount && (usdc ? s3 - s2 >= BigInt(dq.minSwapOutAmount.toString()) && s3 > s2 : s3 + 50_000n > s2), `tokens ${tok(a2.amount)} -> ${tok(a3.amount)}, ${fmt(s2)} -> ${fmt(s3)}${usdc ? ` (the quote's floor was ${fmt(BigInt(dq.minSwapOutAmount.toString()))})` : ""}`);
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
    await dammSwap(trd, true, new BN(D.dammBuy2.toString()), "buy on the DAMM v2 pool after the sweep");
    check("sweep after graduation", "the pool still trades after the sweep", true, "buy landed");
    await refund(fopts(), trd.publicKey.toBase58(), say);
  });

  // 11. claim --------------------------------------------------------------------------------------------------------------------
  await step("11 claim partner fees", usdc ? 6_000_000n : 3_000_000n, async () => { // USDC: the fee wallet's USDC account may be opened by the claim (0.002)
    const g0 = await gather(fopts()), u0 = usdc ? await usdcOf(dep.publicKey) : 0n;
    const r = await claim(fopts(), say);
    check("claim", `the claim transactions put ${Q.sym} in the fee wallet (read from each transaction)`, r.steps >= 1 && r.received > 0n, `${r.steps} claim transaction(s), fee wallet received ${fmt(r.received)}${usdc ? "" : " before their fees"}`);
    // The fee wallet's USDC account takes nothing but these claims, so its balance must have risen by at least what the transactions showed.
    if (usdc) { const u1 = await usdcOf(dep.publicKey); check("claim", "the fee wallet's USDC balance rose by what the claims paid, read from chain", u1 - u0 >= r.received, `${fmt(u0)} -> ${fmt(u1)} vs ${fmt(r.received)}`); }
  });

  // result -------------------------------------------------------------------------------------------------------------------------
  const spentEnd = await spent();
  const sigs = collectSigs(dir);
  const usdcEnd = usdc ? await nowUsdc() : 0n;
  S.result = { spentLamports: spentEnd.toString(), cap: cap.toString(), ...(usdc ? { usdcStart: S.startUsdc ?? "0", usdcEnd: usdcEnd.toString() } : {}), signatures: sigs, finishedAt: new Date().toISOString() }; save();
  say(`\nRehearsal finished: spent ${sol(spentEnd)} of the ${sol(cap)} cap across both wallets (start ${sol(start)}, end ${sol((await lam(dep.publicKey)) + (await lam(trd.publicKey)))}).${usdc ? `
USDC across both wallets: start ${money(BigInt(S.startUsdc ?? 0), quote)}, end ${money(usdcEnd, quote)} (what the swap bought less what the curve and the pool kept, plus the claimed fees).` : ""}
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
  const quote = args.quote ?? "sol", Q = quoteOf(quote), D = DEFAULTS[quote];
  // Amounts in the quote token: --trader-buy is SOL or USDC. A USDC curve has no team buy (the creator holds no USDC).
  if (Q.sym === "USDC" && args["team-buy"] !== undefined) refuse("--team-buy is SOL and can't be used with --quote usdc (the creator holds no USDC). The USDC rehearsal has none.");
  const amount = (v, flag) => (Q.sym === "USDC" ? amountOf(v, flag, Q.decimals) : lamportsOf(v, flag));
  return {
    conn: connect(args.rpc), quote, deployer: key("deployer-keypair", "deployer.json", "deployer-keypair"), trader: key("trader-keypair", "test-trader.json", "trader-keypair"),
    stateDir: typeof args["state-dir"] === "string" ? tilde(args["state-dir"]) : join(REPO, "program-keys", "mainnet", Q.sym === "USDC" ? "rehearsal-usdc" : "rehearsal-curve"),
    capLamports: lamportsOf(args["cap-sol"] ?? D.cap, "cap-sol"), teamBuy: Q.sym === "USDC" ? 0n : lamportsOf(args["team-buy"] ?? "0.003", "team-buy"), traderBuy: amount(args["trader-buy"] ?? D.traderBuy, "trader-buy"),
    startMcap: Number(args["start-mcap"] ?? D.start), gradMcap: Number(args["grad-mcap"] ?? D.grad), go: !!args.go, skipMarkets: !!args["skip-markets"],
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await rehearse(optsFromArgs(process.argv.slice(2))); } catch (e) { console.error(e instanceof Refuse ? "STOPPED: " + e.message : e.stack || String(e)); process.exitCode = 1; }
}
