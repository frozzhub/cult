// Buy/sell from our own page on the Meteora launch (terminals and Jupiter work too: this is just the
// friendly way, with the sell warning). Mainnet routes through Jupiter, which covers the bonding curve
// and the DAMM v2 pool after graduation; devnet has no Jupiter, so it builds the curve swap directly.
//   GET  /api/quote?side=buy|sell&amount=<raw units> -> { out, fee }
//   POST /api/trade { wallet, side, amount, slippageBps } -> { transaction } (unsigned, base64)
//   POST /api/send  { signed } -> { signature }       GET /api/tx/:sig -> { status }
import { PublicKey, VersionedTransaction, Connection } from "@solana/web3.js";
import { ADDR, SOL_MINT } from "./config.js";
import { rpc, rpcUrl, sigOf, sigStatuses } from "./chain.js";

const bad = (msg, status = 400) => Response.json({ error: msg }, { status });
const toB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const PROGRAMS = new Set(["dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"]);
const jupHeaders = (env) => (env.JUP_API_KEY ? { "x-api-key": env.JUP_API_KEY } : {});

const viaJupiter = (cfg) => cfg.cluster === "mainnet";
const mints = (cfg, side) => (side === "buy" ? [SOL_MINT, cfg.mint] : [cfg.mint, SOL_MINT]);
const feeOf = (cfg, side, amountIn, out) => (side === "buy" ? (amountIn * BigInt(cfg.feeBps)) / 10_000n : (out * BigInt(cfg.feeBps)) / BigInt(10_000 - cfg.feeBps));

// Direct route without Jupiter: the bonding curve, or the DAMM v2 pool once the coin has graduated.
// Returns { out, fee, impactPct } and, when `wallet` is given, the unsigned transaction too.
async function direct(env, cfg, side, amount, slip, wallet) {
  const BN = (await import("bn.js")).default;
  const conn = new Connection(rpcUrl(env), "confirmed");
  const owner = wallet ? new PublicKey(wallet) : null;
  const g = await graduated(env);
  let tx, out, fee, impactPct = 0;
  if (!g) {
    const { DynamicBondingCurveClient, getCurrentPoint } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
    const client = new DynamicBondingCurveClient(conn, "confirmed");
    const pool = new PublicKey(cfg.pool);
    const virtualPool = await client.state.getPool(pool);
    const config = await client.state.getPoolConfig((virtualPool.poolState || virtualPool).config);
    const q = client.pool.swapQuote({ virtualPool, config, swapBaseForQuote: side === "sell", amountIn: new BN(amount.toString()), hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint: await getCurrentPoint(conn, config.activationType) });
    out = BigInt(q.outputAmount.toString()); fee = BigInt(q.tradingFee.toString()) + BigInt(q.protocolFee.toString());
    if (owner) tx = await client.pool.swap({ owner, pool, amountIn: new BN(amount.toString()), minimumAmountOut: new BN(((out * BigInt(10_000 - slip)) / 10_000n).toString()), swapBaseForQuote: side === "sell", referralTokenAccount: null });
  } else {
    const { CpAmm, getTokenProgram } = await import("@meteora-ag/cp-amm-sdk");
    const cp = new CpAmm(conn);
    const pool = new PublicKey(g.pool);
    const ps = await cp.fetchPoolState(pool);
    const [input, output] = side === "buy" ? [ps.tokenBMint, ps.tokenAMint] : [ps.tokenAMint, ps.tokenBMint];
    const slot = await conn.getSlot();
    const q = cp.getQuote({ inAmount: new BN(amount.toString()), inputTokenMint: input, slippage: slip / 100, poolState: ps, currentTime: Math.floor(Date.now() / 1000), currentSlot: slot, tokenADecimal: 6, tokenBDecimal: 9 });
    out = BigInt(q.swapOutAmount.toString()); fee = feeOf(cfg, side, amount, out); impactPct = Number(q.priceImpact || 0);
    if (owner) tx = await cp.swap({ payer: owner, pool, inputTokenMint: input, outputTokenMint: output, amountIn: new BN(amount.toString()), minimumAmountOut: q.minSwapOutAmount,
      tokenAMint: ps.tokenAMint, tokenBMint: ps.tokenBMint, tokenAVault: ps.tokenAVault, tokenBVault: ps.tokenBVault,
      tokenAProgram: getTokenProgram(ps.tokenAFlag), tokenBProgram: getTokenProgram(ps.tokenBFlag), referralTokenAccount: null, poolState: ps });
  }
  if (tx) { tx.feePayer = owner; tx.recentBlockhash = (await rpc(env, "getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash; }
  return { out, fee, impactPct, transaction: tx ? toB64(tx.serialize({ requireAllSignatures: false, verifySignatures: false })) : undefined };
}
async function graduated(env) {
  const r = await env.DB?.prepare("SELECT v FROM kv WHERE k = 'graduated'").first().catch(() => null);
  return r ? JSON.parse(r.v) : null;
}

async function jupQuote(env, cfg, side, amount, slippageBps) {
  const [inputMint, outputMint] = mints(cfg, side);
  const r = await fetch(`${cfg.jup}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`, { headers: jupHeaders(env) });
  if (!r.ok) throw Object.assign(new Error("No route yet. Try again in a moment."), { status: 503 });
  return r.json();
}

export async function handleMeteoraTrade(req, env, cfg, path, url) {
  if (!cfg.mint || !cfg.pool) return bad("Trading opens at launch.", 503);

  if (path === "/api/quote") {
    const side = url.searchParams.get("side");
    let amount; try { amount = BigInt(url.searchParams.get("amount")); } catch { return bad("Enter an amount."); }
    if (!["buy", "sell"].includes(side) || amount <= 0n) return bad("Enter an amount.");
    if (viaJupiter(cfg)) {
      const q = await jupQuote(env, cfg, side, amount, 100).catch(() => null); // no route yet in the first minutes: go direct
      if (q) { const out = BigInt(q.outAmount); return Response.json({ out: out.toString(), fee: feeOf(cfg, side, amount, out).toString(), impactPct: Number(q.priceImpactPct || 0) * 100 }); }
    }
    const d = await direct(env, cfg, side, amount, 100);
    return Response.json({ out: d.out.toString(), fee: d.fee.toString(), impactPct: d.impactPct });
  }

  if (path === "/api/trade" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    if (!ADDR.test(b.wallet || "")) return bad("Connect your wallet first.");
    if (!["buy", "sell"].includes(b.side)) return bad("Pick buy or sell.");
    let amount; try { amount = BigInt(b.amount); } catch { return bad("Enter an amount."); }
    if (amount <= 0n) return bad("Enter an amount.");
    const slip = Math.min(Math.max(Number(b.slippageBps) || 100, 10), 2000);
    const quoteResponse = viaJupiter(cfg) ? await jupQuote(env, cfg, b.side, amount, slip).catch(() => null) : null;
    if (quoteResponse) {
      const s = await fetch(`${cfg.jup}/swap/v1/swap`, {
        method: "POST", headers: { "content-type": "application/json", ...jupHeaders(env) },
        body: JSON.stringify({ quoteResponse, userPublicKey: b.wallet, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto" }),
      });
      if (!s.ok) return bad("Couldn't build the trade. Try again.", 503);
      const { swapTransaction } = await s.json();
      return Response.json({ transaction: swapTransaction, out: quoteResponse.outAmount });
    }
    const d = await direct(env, cfg, b.side, amount, slip, b.wallet);
    return Response.json({ transaction: d.transaction, out: d.out.toString() });
  }

  if (path === "/api/send" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    let tx; try { tx = VersionedTransaction.deserialize(fromB64(String(b.signed || ""))); } catch { return bad("The signed transaction couldn't be read."); }
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    if (!tx.message.compiledInstructions.some((ix) => PROGRAMS.has(keys[ix.programIdIndex]))) return bad("Only $CULT trades can be sent here.");
    try { await rpc(env, "sendTransaction", [toB64(tx.serialize()), { encoding: "base64", maxRetries: 3 }]); }
    catch (e) { return bad(/slippage|0x1771|0x1772|exceeded/i.test(e.message) ? "The price moved. Try again." : /insufficient/i.test(e.message) ? "Not enough SOL for this trade plus fees." : "Solana refused the trade. Nothing was sent."); }
    return Response.json({ signature: sigOf(tx) });
  }

  const m = path.match(/^\/api\/tx\/([1-9A-HJ-NP-Za-km-z]{60,90})$/);
  if (m) return Response.json({ status: (await sigStatuses(env, [m[1]]))[m[1]] || "sent" });
  return bad("Not found", 404);
}
