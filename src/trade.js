// Buy / sell against the $PAPER pool (programs/paper-pool). Same pattern as Clipped: the Worker builds the
// transaction, the user's wallet signs it in the browser, the Worker relays it. No keys involved.
//   GET  /api/pool            -> reserves + fee, so the page can quote as you type
//   POST /api/trade           -> { wallet, side: "buy"|"sell", amount (raw units), slippageBps } -> unsigned tx
//   POST /api/send            -> { signed } -> signature (only relays transactions that call the pool)
//   GET  /api/tx/:sig         -> "sent" | "confirmed" | "failed"
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ADDR } from "./config.js";
import { rpc, latestBlockhash, sigStatuses, sigOf } from "./chain.js";

const enc = new TextEncoder();
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const bad = (msg, status = 400) => Response.json({ error: msg }, { status });

export const tradeReady = (cfg) => !!(cfg.mint && cfg.poolProgram && cfg.hookProgram);

// Anchor instruction discriminator: first 8 bytes of sha256("global:<name>").
async function disc(name) { return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode("global:" + name))).slice(0, 8); }
const u64le = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };

// Addresses the page needs to read the pool itself (derived, no RPC).
export function poolAccounts(cfg) {
  const pool = poolAddress(cfg);
  return { pool: pool.toBase58(), vault: getAssociatedTokenAddressSync(new PublicKey(cfg.mint), pool, true, TOKEN_2022_PROGRAM_ID).toBase58() };
}

export function poolAddress(cfg) {
  return PublicKey.findProgramAddressSync([enc.encode("pool"), new PublicKey(cfg.mint).toBytes()], new PublicKey(cfg.poolProgram))[0];
}

// Pool, its vault and the mint in ONE call (free RPC tiers rate-limit hard), cached for 10s per isolate.
//   pool:  8 disc | mint 32 | vault 32 | payout 32 | fee_bps u16 | sol_reserve u64 | bump u8
//   vault: Token-2022 account, amount u64 at offset 64
//   mint:  decimals u8 at offset 44
let poolCache = null;
export async function readPool(env, cfg, { fresh = false } = {}) {
  if (!fresh && poolCache && poolCache.key === cfg.mint && Date.now() - poolCache.at < 10_000) return poolCache.value;
  const pool = poolAddress(cfg);
  const mint = new PublicKey(cfg.mint);
  const vault = getAssociatedTokenAddressSync(mint, pool, true, TOKEN_2022_PROGRAM_ID);
  let r;
  try { r = await rpc(env, "getMultipleAccounts", [[pool.toBase58(), vault.toBase58(), mint.toBase58()], { encoding: "base64" }]); }
  catch (e) { // RPC throttled: a quote from up to 5 min ago beats an error (trades still re-read fresh)
    if (!fresh && poolCache?.key === cfg.mint && Date.now() - poolCache.at < 300_000) return poolCache.value;
    throw e;
  }
  const [p, va, m] = (r?.value || []).map((a) => (a ? fromB64(a.data[0]) : null));
  const poolLamports = BigInt(r?.value?.[0]?.lamports || 0);
  if (!p || !va || !m) throw new Error("Pool not created yet.");
  const v = new DataView(p.buffer, p.byteOffset);
  const value = {
    pool, vault, payout: new PublicKey(p.slice(72, 104)),
    feeBps: v.getUint16(104, true),
    solReserve: v.getBigUint64(106, true),
    tokenReserve: new DataView(va.buffer, va.byteOffset).getBigUint64(64, true),
    decimals: m[44],
  };
  value.rent = poolLamports - value.solReserve; // the pool account's rent: lamports beyond the curve's SOL
  if (!new PublicKey(p.slice(40, 72)).equals(vault)) throw new Error("Pool vault doesn't match.");
  poolCache = { key: cfg.mint, at: Date.now(), value };
  return value;
}

const quote = (amountIn, reserveIn, reserveOut) => (amountIn * reserveOut) / (reserveIn + amountIn);

// Reserves the browser read itself. Addresses are derived here, never taken from the client.
function clientPool(cfg, q) {
  const pool = poolAddress(cfg);
  const solReserve = BigInt(q.solReserve), tokenReserve = BigInt(q.tokenReserve), feeBps = Number(q.feeBps);
  if (solReserve <= 0n || tokenReserve <= 0n || !(feeBps >= 0 && feeBps <= 2000) || !ADDR.test(cfg.payout) || !ADDR.test(String(q.blockhash || ""))) return null;
  return { pool, vault: getAssociatedTokenAddressSync(new PublicKey(cfg.mint), pool, true, TOKEN_2022_PROGRAM_ID), payout: new PublicKey(cfg.payout), feeBps, solReserve, tokenReserve };
}

export async function handleTrade(req, env, cfg, path) {
  if (!tradeReady(cfg)) return bad("Trading opens at launch.", 503);

  if (path === "/api/pool") {
    const p = await readPool(env, cfg);
    return Response.json({ solReserve: p.solReserve.toString(), tokenReserve: p.tokenReserve.toString(), feeBps: p.feeBps, decimals: p.decimals });
  }

  if (path === "/api/trade" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    if (!ADDR.test(b.wallet || "")) return bad("Connect your wallet first.");
    if (!["buy", "sell"].includes(b.side)) return bad("Pick buy or sell.");
    let amount; try { amount = BigInt(b.amount); } catch { return bad("Enter an amount."); }
    if (amount <= 0n) return bad("Enter an amount.");
    const slip = BigInt(Math.min(Math.max(Number(b.slippageBps) || 100, 10), 2000));
    // Price on current reserves. With CLIENT_RPC on, the browser may send the reserves and a blockhash it read
    // itself (free RPCs block Cloudflare). That only sets the caller's own slippage floor; the program checks the rest.
    const c = cfg.clientRpc && b.pool && b.blockhash ? clientPool(cfg, { ...b.pool, blockhash: b.blockhash }) : null;
    const p = c || (await readPool(env, cfg, { fresh: true }));
    let out = b.side === "buy" ? quote(amount, p.solReserve, p.tokenReserve) : quote(amount, p.tokenReserve, p.solReserve);
    if (b.side === "sell") out -= (out * BigInt(p.feeBps)) / 10_000n;
    const minOut = (out * (10_000n - slip)) / 10_000n;
    if (minOut <= 0n) return bad("That amount is too small.");

    const user = new PublicKey(b.wallet), mint = new PublicKey(cfg.mint), hook = new PublicKey(cfg.hookProgram);
    const metas = PublicKey.findProgramAddressSync([enc.encode("extra-account-metas"), mint.toBytes()], hook)[0];
    const keys = [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: p.pool, isSigner: false, isWritable: true },
      { pubkey: p.vault, isSigner: false, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(mint, user, false, TOKEN_2022_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: p.payout, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // Transfer hook accounts, passed through to Token-2022.
      { pubkey: hook, isSigner: false, isWritable: false },
      { pubkey: metas, isSigner: false, isWritable: false },
    ];
    const data = new Uint8Array([...(await disc(b.side)), ...u64le(amount), ...u64le(minOut)]);
    const ix = new TransactionInstruction({ programId: new PublicKey(cfg.poolProgram), keys, data });
    const blockhash = c ? String(b.blockhash) : (await latestBlockhash(env)).blockhash;
    const msg = new TransactionMessage({
      payerKey: user, recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }), ix],
    }).compileToV0Message();
    return Response.json({ transaction: toB64(new VersionedTransaction(msg).serialize()), out: out.toString(), minOut: minOut.toString() });
  }

  if (path === "/api/send" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    let tx; try { tx = VersionedTransaction.deserialize(fromB64(String(b.signed || ""))); } catch { return bad("The signed transaction couldn't be read."); }
    const program = cfg.poolProgram;
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    if (!tx.message.compiledInstructions.some((ix) => keys[ix.programIdIndex] === program)) return bad("Only $PAPER trades can be sent here.");
    try { await rpc(env, "sendTransaction", [toB64(tx.serialize()), { encoding: "base64", maxRetries: 3 }]); }
    catch (e) { return bad(/slippage|0x1772/i.test(e.message) ? "The price moved. Try again." : /insufficient/i.test(e.message) ? "Not enough SOL for this trade plus fees." : "Solana refused the trade. Nothing was sent."); }
    return Response.json({ signature: sigOf(tx) });
  }

  const m = path.match(/^\/api\/tx\/([1-9A-HJ-NP-Za-km-z]{60,90})$/);
  if (m) {
    const s = (await sigStatuses(env, [m[1]]))[m[1]];
    return Response.json({ status: s || "sent" });
  }
  return bad("Not found", 404);
}
