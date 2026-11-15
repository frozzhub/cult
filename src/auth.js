// Sign In With Solana (adapted from fnf-app): the wallet signs a one-time message, we check the ed25519
// signature, and set a session cookie. No transaction, nothing spent. One profile per wallet.
import { ed25519 } from "@noble/curves/ed25519.js";
import { b58decode } from "./chain.js";
import { ADDR } from "./config.js";

const NONCE_TTL = 10 * 60_000;
const SESSION_TTL = 30 * 86_400_000;
export const COOKIE = "cult_session";

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const randomToken = (n = 32) => hex(crypto.getRandomValues(new Uint8Array(n)));
export async function sha256(s) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(s))); }

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

// The exact text the wallet signs, in the Sign In With Solana shape so wallets show it cleanly.
export function signInMessage({ domain, uri, wallet, nonce, issuedAt, expiresAt }) {
  return `${domain} wants you to sign in with your Solana account:\n${wallet}\n\nSign in to CULT. This is a signature, not a transaction, and costs nothing.\n\nURI: ${uri}\nVersion: 1\nNonce: ${nonce}\nIssued At: ${new Date(issuedAt).toISOString()}\nExpiration Time: ${new Date(expiresAt).toISOString()}`;
}

// Signatures arrive as base58 (most wallets) or base64.
export function decodeSignature(sig) {
  if (typeof sig !== "string") return null;
  try { const b = b58decode(sig); if (b.length === 64) return b; } catch {}
  try { const b = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0)); if (b.length === 64) return b; } catch {}
  return null;
}

export function verifySignature(message, signature, wallet) {
  const sig = decodeSignature(signature);
  if (!sig || !ADDR.test(wallet)) return false;
  try { return ed25519.verify(sig, enc.encode(message), b58decode(wallet)); } catch { return false; }
}

export async function createChallenge(env, url, wallet, now = Date.now()) {
  if (!ADDR.test(wallet || "")) throw new HttpError(400, "That isn't a Solana wallet address.");
  const nonce = randomToken(16), expiresAt = now + NONCE_TTL;
  const message = signInMessage({ domain: url.host, uri: url.origin, wallet, nonce, issuedAt: now, expiresAt });
  await env.DB.batch([
    env.DB.prepare("DELETE FROM nonces WHERE expires_at < ?").bind(now),
    env.DB.prepare("INSERT INTO nonces (nonce, wallet, message, expires_at) VALUES (?, ?, ?, ?)").bind(nonce, wallet, message, expiresAt),
  ]);
  return { nonce, message };
}

// Verify the signature (single use, even if it fails) and start a session.
export async function signIn(env, { wallet, nonce, signature }, now = Date.now()) {
  const row = await env.DB.prepare("SELECT * FROM nonces WHERE nonce = ?").bind(String(nonce || "")).first();
  if (!row || row.wallet !== wallet) throw new HttpError(400, "That sign-in request isn't valid. Start again.");
  await env.DB.prepare("DELETE FROM nonces WHERE nonce = ?").bind(row.nonce).run();
  if (row.expires_at < now) throw new HttpError(400, "That sign-in request expired. Start again.");
  if (!verifySignature(row.message, signature, wallet)) throw new HttpError(401, "The signature doesn't match this wallet.");
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("INSERT INTO sessions (token_hash, wallet, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), wallet, now + SESSION_TTL),
  ]);
  return { token, wallet };
}

export function readCookie(request, name) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// The signed-in wallet for a request, or null.
export async function getSession(env, request, now = Date.now()) {
  const token = readCookie(request, COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await env.DB.prepare("SELECT wallet, expires_at FROM sessions WHERE token_hash = ?").bind(await sha256(token)).first();
  return row && row.expires_at >= now ? { wallet: row.wallet } : null;
}

export async function signOut(env, request) {
  const token = readCookie(request, COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
}

export function sessionCookie(token, url, maxAgeSec = SESSION_TTL / 1000) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${url.protocol === "https:" ? "; Secure" : ""}`;
}
