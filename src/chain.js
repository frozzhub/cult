// Solana + Jupiter calls for the indexer. The payout wallet's key is a Worker secret: it's the only way to
// pay holders every hour without someone signing by hand. Keep only an hour or two of fees in it.
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SOL_MINT, USDC_MINT } from "./config.js";

const USDC = new PublicKey(USDC_MINT);
// The payout token: real USDC unless USDC_MINT says otherwise (devnet uses a stand-in with the same layout).
export const payMint = (env) => (env?.USDC_MINT ? new PublicKey(env.USDC_MINT) : USDC);
export const ATA_RENT = 2_039_280; // lamports to open a USDC account for a new holder
export const TX_FEE = 15_000;      // base fee + priority, per payout transaction (generous)

// SOLANA_RPC_URL: one URL, a Helius key, or several URLs separated by commas (tried in order).
export function rpcUrls(env) {
  const list = String(env.SOLANA_RPC_URL || "").split(",").map((v) => v.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const helius = (k) => `https://${env.CLUSTER === "devnet" ? "devnet" : "mainnet"}.helius-rpc.com/?api-key=${k}`;
  const urls = list.map((v) => (/^https?:\/\//i.test(v) ? v : /^[A-Za-z0-9-]{20,80}$/.test(v) ? helius(v) : null)).filter(Boolean);
  if (/^[A-Za-z0-9-]{20,80}$/.test(env.HELIUS_KEY || "")) urls.unshift(helius(env.HELIUS_KEY)); // secret: tried first
  return urls.length ? urls : ["https://api.mainnet-beta.solana.com"];
}
export const rpcUrl = (env) => rpcUrls(env)[0];

// The cron gets its own RPC key so the site's traffic (/api/pool, /api/trade, /api/send, /api/tx) can't throttle
// payouts. HELIUS_KEY is the shared key, so it is dropped here: CRON_RPC_URL is the cron's only endpoint list.
export const cronEnv = (env) => (String(env.CRON_RPC_URL || "").trim() ? { ...env, SOLANA_RPC_URL: env.CRON_RPC_URL, HELIUS_KEY: "" } : env);

// Rate-limited or blocked: try the next endpoint, backing off once every endpoint has been tried.
const throttled = (status, msg) => status === 429 || status === 403 || /too many requests|rate limit|blocked/i.test(msg || "");

export async function rpc(env, method, params) {
  const urls = rpcUrls(env);
  let res, body;
  for (let i = 0; i < Math.max(8, urls.length * 3); i++) {
    res = await fetch(urls[i % urls.length], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    body = await res.json().catch(() => ({}));
    if (!throttled(res.status, body.error?.message)) break;
    if ((i + 1) % urls.length === 0) await new Promise((r) => setTimeout(r, Math.min(4000, 400 * 2 ** Math.floor(i / urls.length))));
  }
  if (!res.ok || body.error) throw new Error(`RPC ${method} failed: ${body.error?.message || res.status}`);
  return body.result;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(s) {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}

// PAYOUT_SECRET_KEY: base58 (Phantom export) or a JSON byte array (solana-keygen file).
export function payoutKeypair(env, cfg) {
  const raw = String(env.PAYOUT_SECRET_KEY || "").trim();
  if (!raw) throw new Error("PAYOUT_SECRET_KEY isn't set.");
  const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : b58decode(raw);
  const kp = Keypair.fromSecretKey(bytes);
  if (kp.publicKey.toBase58() !== cfg.payout) throw new Error("PAYOUT_SECRET_KEY doesn't match PAYOUT_WALLET.");
  return kp;
}

/* ---------- reads ---------- */

export async function mintInfo(env, mint) {
  const info = await rpc(env, "getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  const p = info?.value?.data?.parsed;
  if (!p || p.type !== "mint") throw new Error("MINT isn't a token mint.");
  return { decimals: p.info.decimals, program: info.value.owner };
}

export const jupHeaders = (env) => (env.JUP_API_KEY ? { "x-api-key": env.JUP_API_KEY } : {});

// USD prices for SOL and the coin.
export async function prices(env, cfg) {
  const ids = [SOL_MINT, cfg.mint].filter(Boolean).join(",");
  const res = await fetch(`${cfg.jup}/price/v3?ids=${ids}`, { headers: jupHeaders(env) });
  if (!res.ok) throw new Error("Jupiter price " + res.status);
  const j = await res.json();
  return { sol: Number(j[SOL_MINT]?.usdPrice || 0), token: Number(j[cfg.mint]?.usdPrice || 0) };
}

// Every holder of the coin: Map(owner -> raw balance). Helius DAS (getTokenAccounts, paged) when the RPC
// supports it, otherwise a standard getProgramAccounts filtered by mint.
export async function tokenHolders(env, mint, program) {
  // Helius names the param `mint`; Solana Foundation RPCs name it `mintAddress`; some RPCs lack the method.
  const noDas = /method not found|-32601|-32602|not supported|unknown field|invalid param/i;
  try { return await dasHolders(env, { mint, options: { showZeroBalance: false } }); }
  catch (e) {
    if (!noDas.test(e.message)) throw e;
    if (/unknown field `mint`/.test(e.message)) {
      try { return await dasHolders(env, { mintAddress: mint }); }
      catch (e2) { if (!noDas.test(e2.message)) throw e2; }
    }
  }
  const out = new Map();
  const r = await rpc(env, "getProgramAccounts", [program, { encoding: "jsonParsed", filters: [{ memcmp: { offset: 0, bytes: mint } }] }]);
  for (const a of r || []) {
    const info = a.account?.data?.parsed?.info;
    const amt = BigInt(info?.tokenAmount?.amount || 0);
    if (info?.owner && amt > 0n) out.set(info.owner, (out.get(info.owner) || 0n) + amt);
  }
  return out;
}

async function dasHolders(env, query) {
  const out = new Map();
  let cursor;
  for (let page = 0; page < 200; page++) {
    const r = await rpc(env, "getTokenAccounts", { ...query, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const a of r?.token_accounts || []) {
      const amt = BigInt(a.amount || 0);
      if (amt > 0n) out.set(a.owner, (out.get(a.owner) || 0n) + amt);
    }
    if (!r?.cursor || !(r.token_accounts || []).length) break;
    cursor = r.cursor;
  }
  return out;
}

export const usdcAta = (owner, env) => getAssociatedTokenAddressSync(payMint(env), new PublicKey(owner), true, TOKEN_PROGRAM_ID);

// Which of these wallets don't have a USDC account yet (we pay the rent to open one).
export async function missingUsdcAccounts(env, owners) {
  const missing = new Set();
  for (let i = 0; i < owners.length; i += 100) {
    const chunk = owners.slice(i, i + 100);
    const r = await rpc(env, "getMultipleAccounts", [chunk.map((o) => usdcAta(o, env).toBase58()), { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
    (r?.value || []).forEach((v, j) => { if (!v) missing.add(chunk[j]); });
  }
  return missing;
}

// Balances are read at "confirmed": the default (finalized) lags a swap that confirmed seconds ago, and the round
// would then pay without its own USDC.
const CONFIRMED = { commitment: "confirmed" };
export async function solBalance(env, owner) { return BigInt((await rpc(env, "getBalance", [owner, CONFIRMED]))?.value || 0); }

export async function usdcBalance(env, owner) {
  try { return BigInt((await rpc(env, "getTokenAccountBalance", [usdcAta(owner, env).toBase58(), CONFIRMED]))?.value?.amount || 0); }
  catch (e) { if (/could not find account|Invalid param/i.test(e.message)) return 0n; throw e; }
}

// Many accounts at once (100 per call): Map(address -> Uint8Array | null), read at "confirmed". A failed read throws:
// callers decide from what they read, so a missing answer must never look like "the account is empty".
export async function getAccounts(env, addresses) {
  const out = new Map();
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const r = await rpc(env, "getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed" }]);
    if (!Array.isArray(r?.value) || r.value.length !== chunk.length) throw new Error("getMultipleAccounts gave an unexpected answer");
    r.value.forEach((v, j) => out.set(chunk[j], v ? fromB64(v.data[0]) : null));
  }
  return out;
}

// simulateTransaction on a signed or unsigned tx. `accounts`: addresses whose state after the run is returned
// (Map(address -> { lamports, data: Uint8Array } | null)). Throws when the RPC can't simulate; a failed run has err set.
export async function simulate(env, tx, accounts = []) {
  const r = await rpc(env, "simulateTransaction", [toB64(tx.serialize()), {
    encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed",
    ...(accounts.length ? { accounts: { encoding: "base64", addresses: accounts } } : {}),
  }]);
  const v = r?.value || {};
  const after = new Map((v.accounts || []).map((a, i) => [accounts[i], a ? { lamports: BigInt(a.lamports), data: fromB64(a.data[0]) } : null]));
  return { err: v.err || null, logs: v.logs || [], units: Number(v.unitsConsumed || 0), after };
}

export async function blockHeight(env) { return Number(await rpc(env, "getBlockHeight", [{ commitment: "confirmed" }])); }
export async function latestBlockhash(env) { return (await rpc(env, "getLatestBlockhash", [{ commitment: "confirmed" }])).value; }

// A compute-unit price (micro-lamports) that lands a transaction writing `accounts` now: the 75th percentile of what landed on them
// in the last ~150 slots, never below `floor` and never above `cap`. A node that can't answer gives the floor, never a guess upward.
export async function priorityFee(env, accounts, floor, cap) {
  try {
    const r = await rpc(env, "getRecentPrioritizationFees", [accounts]);
    const v = (Array.isArray(r) ? r : []).map((x) => Number(x?.prioritizationFee)).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
    return v.length ? Math.max(floor, Math.min(cap, v[Math.floor((v.length - 1) * 0.75)])) : floor;
  } catch (e) { console.error("priority fee", e.message); return floor; }
}

// sig -> "confirmed" | "processed" (in a block, not confirmed yet) | "failed" (landed with an error) | null (not seen).
// "processed" is its own answer: a transaction that is in a block can still confirm, so it is never re-sent.
export async function sigStatuses(env, sigs) {
  const out = {};
  for (let i = 0; i < sigs.length; i += 256) {
    const chunk = sigs.slice(i, i + 256);
    const r = await rpc(env, "getSignatureStatuses", [chunk, { searchTransactionHistory: true }]);
    (r?.value || []).forEach((st, j) => {
      out[chunk[j]] = !st ? null : st.err ? "failed" : (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") ? "confirmed" : "processed";
    });
  }
  return out;
}

// The transaction itself, for a signature the status call doesn't know: "confirmed" | "failed" | null (not found).
// Used to double-check before a batch whose blockhash expired is re-sent. Version 1 transactions need the 1.
export async function txOutcome(env, sig) {
  const tx = await rpc(env, "getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
  return !tx ? null : tx.meta?.err ? "failed" : "confirmed";
}

export const toB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const sigOf = (tx) => { const s = tx.signatures[0]; let n = 0n; for (const b of s) n = n * 256n + BigInt(b); let o = ""; while (n > 0n) { o = B58[Number(n % 58n)] + o; n /= 58n; } for (const b of s) { if (b) break; o = "1" + o; } return o; };

export async function sendTx(env, tx) {
  // No maxRetries: the node then keeps re-broadcasting until the blockhash expires. With 3, a refund dropped once sat unseen
  // for over two minutes before it could be sent again (staging, 17 Nov). The same signature can only land once.
  const raw = toB64(tx.serialize()), opts = { encoding: "base64", skipPreflight: true };
  const r = await rpc(env, "sendTransaction", [raw, opts]);
  // REBROADCAST_MS (set on the live deploys, off in tests): re-send the same signed transaction every 2 s until it is seen in a
  // block or the time is up. fnf’s launch (17 Nov) lost single sends even at a high priority fee; a re-send can’t pay twice.
  const sig = sigOf(tx);
  for (const end = Date.now() + Number(env.REBROADCAST_MS || 0); Date.now() < end;) {
    await new Promise((res) => setTimeout(res, 2000));
    if ((await sigStatuses(env, [sig]).catch(() => ({})))[sig]) break; // in a block, confirmed or failed: nothing more to send
    await rpc(env, "sendTransaction", [raw, { ...opts, maxRetries: 0 }]).catch(() => {});
  }
  return r;
}

/* ---------- writes ---------- */

// One payout transaction: USDC to each wallet. Every payee gets an idempotent "create account" first (a no-op when
// it exists), so a holder who closed their account after the snapshot can't make the whole batch fail. The rent for
// a new account was already taken out of that holder's own payout in `allocate`.
export function buildPayoutTx(kp, blockhash, items, mint = USDC) {
  const payer = kp.publicKey;
  const src = getAssociatedTokenAddressSync(mint, payer, false, TOKEN_PROGRAM_ID);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 10_000 + items.length * 32_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  ];
  for (const it of items) {
    const owner = new PublicKey(it.wallet);
    const dst = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(payer, dst, owner, mint, TOKEN_PROGRAM_ID));
    ixs.push(createTransferCheckedInstruction(src, mint, dst, payer, BigInt(it.micro), 6, [], TOKEN_PROGRAM_ID));
  }
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  tx.sign([kp]);
  return tx;
}

// What happened to transactions we sent: sig -> "confirmed" | "failed" | "lost" | "wait".
//   - the block height is read BEFORE the statuses, so a transaction that lands in between can't look expired;
//   - "processed" and "not seen yet" both wait: only a failed transaction, or one still unseen after its blockhash
//     expired by a margin AND getTransaction can't find it, is final ("lost" = safe to send again);
//   - a missing lvbh means no bound, so it waits (never a clock).
export const EXPIRY_MARGIN = 150; // blocks past the last valid height before an unseen transaction counts as lost
export async function settleSent(env, items) {
  const out = {};
  if (!items.length) return out;
  const height = await blockHeight(env);
  const st = await sigStatuses(env, items.map((i) => i.sig));
  for (const it of items) {
    let s = st[it.sig];
    if (s === null && Number.isFinite(it.lvbh) && height > it.lvbh + EXPIRY_MARGIN) s = (await txOutcome(env, it.sig)) ?? "lost";
    out[it.sig] = s === "confirmed" || s === "failed" || s === "lost" ? s : "wait";
  }
  return out;
}

export class LockLost extends Error {}
