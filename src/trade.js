// Trading for the site, through Jupiter. It works on the curve and after graduation: Jupiter routes to whichever pool
// holds the coin, and there is no pool code of ours.
//   GET  /api/quote?side=buy|sell&amount=<raw>&slippageBps=   what a trade would give, with the sell tax shown
//   POST /api/trade { wallet, side, amount, slippageBps, atomic? }   a base64 versioned transaction for the wallet to sign
//        and send itself. A buy also carries the refund of its own tax: "refund": "atomic" (in the same transaction,
//        signed by the fee key) or "after" (the refund engine sends it seconds later).
//   GET  /api/tx/:sig                      "sent" | "confirmed" | "failed"
//   POST /api/refund/hint { sig }          a confirmed signature: look at it now (the chain is read, not the browser)
// Everything Jupiter hands back is inspected before the wallet sees it (jupiter.js); a transaction we co-sign is
// inspected before our key signs.
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { ADDR, SOL_MINT } from "./config.js";
import { sigStatuses, toB64, payoutKeypair, getAccounts } from "./chain.js";
import * as jup from "./jupiter.js";
import { classify, feeOn, parseTokenAccount, refundIx, treasuryAta } from "./token22.js";
import { hintSignature, cachedPrices } from "./indexer.js";

const bad = (msg, status = 400) => Response.json({ error: msg }, { status });
const user = (msg, status = 400) => Object.assign(new Error(msg), { userFacing: true, status }); // shown to the visitor as it is
const T22 = TOKEN_2022_PROGRAM_ID.toBase58(), T1 = TOKEN_PROGRAM_ID.toBase58();
const MAX_AMOUNT = 2n ** 62n;

export const tradeReady = (cfg) => !!(cfg.mint && ADDR.test(cfg.payout));

function parseAmount(v) {
  let n; try { n = BigInt(v); } catch { throw user("Enter an amount."); }
  if (n <= 0n || n >= MAX_AMOUNT) throw user("Enter an amount.");
  return n;
}
const slippage = (v) => Math.min(Math.max(Math.round(Number(v)) || 100, 10), 2000);

// A buy sells SOL for the coin; a sell sells the coin for SOL.
const legs = (cfg, side) => (side === "buy" ? { inputMint: SOL_MINT, outputMint: cfg.mint } : { inputMint: cfg.mint, outputMint: SOL_MINT });

async function getQuote(env, cfg, side, amount, slippageBps) {
  let q;
  try { q = await jup.quote(env, cfg, { ...legs(cfg, side), amount: String(amount), slippageBps }); }
  catch (e) { const none = /no route|could not find any route/i.test(e.message); throw user(none ? "There's no route for that amount. Try a smaller one." : "Couldn't get a price just now. Try again in a moment.", none ? 400 : 503); }
  return q;
}

// The numbers the page shows. `out` is what Jupiter says you receive: the coin's tax is already inside it. A buy gets its tax
// back (the refund), so what the buyer ends with is out plus that refund; a sell has no refund and pays the tax.
async function describe(cfg, q, side, amount, slippageBps, prices) {
  const bps = cfg.sellTaxBps, out = BigInt(q.outAmount), min = BigInt(q.otherAmountThreshold ?? q.outAmount);
  const refund = side === "buy" ? (out * BigInt(bps)) / BigInt(10_000 - bps) : 0n; // gross = net / (1 - tax)
  return {
    side, amountIn: String(amount), outAmount: q.outAmount, minOut: String(min), slippageBps,
    priceImpactBps: jup.impactBps(q, bps),            // without the tax
    tax: side === "sell" ? { bps, amount: String(feeOn(amount, bps)) } : { bps: 0, amount: "0" }, // a sell's tax, in coin (raw)
    ...(side === "buy" ? { refund: { amount: String(refund) }, outAfterRefund: String(out + refund) } : {}),
    route: (q.routePlan || []).map((p) => p.swapInfo?.label).filter(Boolean).join(" > "),
    ...(prices?.token > 0 && side === "sell" ? { taxUsd: (Number(feeOn(amount, bps)) / 1e6) * prices.token } : {}),
  };
}

export async function handleTrade(req, env, cfg, path, ctx) {
  try { return await route(req, env, cfg, path, ctx); }
  catch (e) { if (e.userFacing) return bad(e.message, e.status); throw e; }
}

async function route(req, env, cfg, path, ctx) {
  const url = new URL(req.url);
  if (!tradeReady(cfg)) return bad("Trading opens at launch.", 503);

  if (path === "/api/quote" && req.method === "GET") {
    const side = url.searchParams.get("side");
    if (!["buy", "sell"].includes(side)) return bad("Pick buy or sell.");
    const amount = parseAmount(url.searchParams.get("amount")), slippageBps = slippage(url.searchParams.get("slippageBps"));
    const q = await getQuote(env, cfg, side, amount, slippageBps);
    return Response.json(await describe(cfg, q, side, amount, slippageBps, await cachedPrices(env, cfg).catch(() => null)));
  }

  if (path === "/api/trade" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    if (!ADDR.test(b.wallet || "") || b.wallet === cfg.payout) return bad("Connect your wallet first.");
    if (!["buy", "sell"].includes(b.side)) return bad("Pick buy or sell.");
    const amount = parseAmount(b.amount), slippageBps = slippage(b.slippageBps);
    const q = await getQuote(env, cfg, b.side, amount, slippageBps);
    if (BigInt(q.otherAmountThreshold ?? q.outAmount) <= 0n) return bad("That amount is too small.");
    const mints = { [cfg.mint]: T22, [SOL_MINT]: T1 };
    const base = { quoteResponse: q, user: b.wallet, mints, maxWrap: b.side === "buy" ? amount + 2_100_000n : 0n };
    const info = await describe(cfg, q, b.side, amount, slippageBps, await cachedPrices(env, cfg).catch(() => null));
    let built = null, refund = b.side === "buy" ? "after" : "none"; // a sell has no refund; a buy's is sent after unless built in
    try {
      if (b.side === "buy" && (b.atomic ?? cfg.atomicRefund)) { built = await atomicBuy(env, cfg, base, b.wallet); if (built) refund = built.refund; }
      if (!built) built = await jup.swapTx(env, cfg, base); // not atomic, or it couldn't be built that way: the plain swap
    } catch (e) {
      console.error("trade build", e.message);
      return bad(/doesn't fit/.test(e.message) ? "That route is too big for one transaction. Try a smaller amount." : "Couldn't build that trade just now. Try again in a moment.", 503);
    }
    const { refund: expected, ...numbers } = info; // the quote's `refund` is an amount; here `refund` is the mode, the amount is `refundAmount`
    return Response.json({ ...numbers, transaction: toB64(built.tx.serialize()), refund, ...(expected ? { refundAmount: expected.amount } : {}), lastValidBlockHeight: built.lvbh });
  }

  if (path === "/api/refund/hint" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    if (!/^[1-9A-HJ-NP-Za-km-z]{60,90}$/.test(String(b.sig || ""))) return bad("That isn't a signature.");
    return Response.json(await hintSignature(env, cfg, b.sig, ctx));
  }

  const m = path.match(/^\/api\/tx\/([1-9A-HJ-NP-Za-km-z]{60,90})$/);
  if (m) {
    const s = (await sigStatuses(env, [m[1]]))[m[1]];
    return Response.json({ status: s === "confirmed" || s === "failed" ? s : "sent" }); // "processed" is still on its way
  }
  return bad("Not found", 404);
}

// A buy with its refund in the same transaction. The buyer's own token account is refunded after the swap, by the fee key,
// which signs here. Returns null when it can't be built (the caller falls back to the plain swap and says "after"), and
// { refund: "none" } when the buyer's account is one the refund rules don't cover (delegate, close authority...): that
// account pays the tax, as every account of its kind does.
async function atomicBuy(env, cfg, base, wallet) {
  let kp;
  try { kp = payoutKeypair(env, cfg); } catch { return null; }
  const ata = getAssociatedTokenAddressSync(new PublicKey(cfg.mint), new PublicKey(wallet), false, TOKEN_2022_PROGRAM_ID);
  const existing = parseTokenAccount((await getAccounts(env, [ata.toBase58()])).get(ata.toBase58()));
  const ctx = { address: ata.toBase58(), mint: cfg.mint, payout: cfg.payout, treasury: treasuryAta(cfg.mint, cfg.payout).toBase58(), deny: new Set(cfg.refundDeny), minRefund: 0n };
  if (existing && classify({ ...existing, withheld: 1n }, ctx).action !== "refund") return { ...(await jup.swapTx(env, cfg, base)), refund: "none" };
  if (!existing && cfg.refundDeny.includes(wallet)) return { ...(await jup.swapTx(env, cfg, base)), refund: "none" };
  try {
    const r = await jup.swapTx(env, cfg, { ...base, forbid: [cfg.payout], extra: [refundIx(cfg.mint, ata, kp.publicKey)] });
    r.tx.sign([kp]); // the fee key signs its own refund instruction; the buyer's signature slot stays empty for the wallet
    return { ...r, refund: "atomic" };
  } catch (e) { console.error("atomic buy", e.message); return null; }
}
