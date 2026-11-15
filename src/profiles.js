// Member profiles. Sign in with the wallet, link X (OAuth 2.0 + PKCE on X's own page), and the profile
// mirrors the X name, @handle and picture. A daily sync re-reads X so a new picture or name shows up
// without the member doing anything. Only wallets holding $CULT can link X.
//
//   POST /api/auth/challenge {wallet}            -> { nonce, message } to sign (free, not a transaction)
//   POST /api/auth/signin    {wallet, nonce, signature} -> session cookie
//   POST /api/auth/signout
//   GET  /api/me                                  -> { wallet, profile, holds }
//   GET  /api/x/connect      (signed in, holder)  -> redirect to X
//   GET  /api/x/callback     (from X)             -> back to /#profile with ?x=<result>
//   POST /api/x/disconnect   (signed in)
//   GET  /api/profile/:wallet                     -> public profile + stats
//
// Needs X_CLIENT_ID (+ X_CLIENT_SECRET for a confidential app) from developer.x.com, with the callback
// URL <site>/api/x/callback added to the app.
import { HttpError, createChallenge, signIn, signOut, getSession, sessionCookie } from "./auth.js";
import { ADDR, config, streakMult, nextStreak } from "./config.js";
import { rpc } from "./chain.js";

const AUTHORIZE = "https://x.com/i/oauth2/authorize";
const TOKEN = "https://api.x.com/2/oauth2/token";
const ME = "https://api.x.com/2/users/me?user.fields=profile_image_url,name,username";
const OAUTH_TTL = 10 * 60_000;
const SYNC_EVERY = 20 * 3_600_000; // re-read X about once a day
const DAY = 86_400_000;

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export const challengeFor = async (v) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
export const callbackUrl = (origin) => `${origin}/api/x/callback`;
export const xConfigured = (env) => !!env.X_CLIENT_ID;
// X's small "_normal" picture -> the 400x400 one.
export const biggerPfp = (url) => (url ? String(url).replace(/_normal(\.\w+)$/, "_400x400$1") : null);
export const publicX = (row) => (row?.x_handle ? { handle: row.x_handle, name: row.x_name || row.x_handle, pfp: row.x_pfp } : null);

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

// $CULT held by a wallet (raw units): our holder index first, then the chain.
export async function cultBalance(env, cfg, wallet) {
  const idx = await env.DB.prepare("SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS a, COUNT(*) AS n FROM token_accounts WHERE owner = ?").bind(wallet).first();
  if (idx?.n) return BigInt(idx.a);
  if (!cfg.mint) return 0n;
  try {
    const r = await rpc(env, "getTokenAccountsByOwner", [wallet, { mint: cfg.mint }, { encoding: "jsonParsed" }]);
    return (r?.value || []).reduce((a, x) => a + BigInt(x.account?.data?.parsed?.info?.tokenAmount?.amount || 0), 0n);
  } catch { return 0n; }
}

const tokenHeaders = (env) => {
  const h = { "content-type": "application/x-www-form-urlencoded" };
  if (env.X_CLIENT_SECRET) h.authorization = "Basic " + btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`);
  return h;
};

export async function connectUrl(env, wallet, origin, now = Date.now()) {
  if (!xConfigured(env)) throw new HttpError(503, "Linking X isn't switched on yet.");
  if ((await cultBalance(env, config(env), wallet)) <= 0n) throw new HttpError(403, "Hold some $CULT to create a profile.");
  const state = random(24), verifier = random(48);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM x_oauth WHERE created_at < ?").bind(now - OAUTH_TTL),
    env.DB.prepare("INSERT INTO x_oauth (state, wallet, verifier, created_at) VALUES (?, ?, ?, ?)").bind(state, wallet, verifier, now),
  ]);
  const q = new URLSearchParams({
    response_type: "code", client_id: env.X_CLIENT_ID, redirect_uri: callbackUrl(origin),
    scope: "users.read tweet.read offline.access", state, code_challenge: await challengeFor(verifier), code_challenge_method: "S256",
  });
  return `${AUTHORIZE}?${q}`;
}

// Back from X. Always ends at /#profile with ?x=connected or a short reason. The browser finishing the
// flow must be signed in as the wallet that started it, so nobody can bind their X to someone else.
export async function handleCallback(env, url, wallet, now = Date.now(), fetcher = fetch) {
  const back = (result) => Response.redirect(`${url.origin}/?x=${encodeURIComponent(result)}#profile`, 302);
  const state = url.searchParams.get("state"), code = url.searchParams.get("code");
  if (url.searchParams.get("error")) return back("cancelled");
  if (!state || !code) return back("failed");
  const row = await env.DB.prepare("SELECT * FROM x_oauth WHERE state = ?").bind(state).first();
  if (!row) return back("expired");
  await env.DB.prepare("DELETE FROM x_oauth WHERE state = ?").bind(state).run();
  if (now - row.created_at > OAUTH_TTL) return back("expired");
  if (!wallet || wallet !== row.wallet) return back("signin");

  const tok = await fetcher(TOKEN, { method: "POST", headers: tokenHeaders(env), body: new URLSearchParams({
    code, grant_type: "authorization_code", client_id: env.X_CLIENT_ID, redirect_uri: callbackUrl(url.origin), code_verifier: row.verifier,
  }) }).then((r) => r.json()).catch(() => null);
  if (!tok?.access_token) { console.error("x token exchange failed", JSON.stringify(tok)?.slice(0, 200)); return back("failed"); }
  const u = await readMe(tok.access_token, fetcher);
  if (!u) return back("failed");

  const taken = await env.DB.prepare("SELECT wallet FROM profiles WHERE x_id = ? AND wallet != ?").bind(u.id, wallet).first();
  if (taken) return back("taken");
  try {
    await env.DB.prepare(`INSERT INTO profiles (wallet, x_id, x_handle, x_name, x_pfp, x_refresh, x_synced_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet) DO UPDATE SET x_id = excluded.x_id, x_handle = excluded.x_handle, x_name = excluded.x_name, x_pfp = excluded.x_pfp,
        x_refresh = excluded.x_refresh, x_synced_at = excluded.x_synced_at`)
      .bind(wallet, u.id, u.username, u.name || u.username, biggerPfp(u.profile_image_url), tok.refresh_token || null, now, now).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) return back("taken");
    throw e;
  }
  return back("connected");
}

async function readMe(accessToken, fetcher) {
  const me = await fetcher(ME, { headers: { authorization: `Bearer ${accessToken}` } }).then((r) => r.json()).catch(() => null);
  const u = me?.data;
  if (!u?.id || !u?.username) { console.error("x users/me failed", JSON.stringify(me)?.slice(0, 200)); return null; }
  return u;
}

// Daily: re-read each linked X account so the profile keeps matching it. X rotates refresh tokens, so
// the new one is stored each time. A revoked link keeps the last name/picture and stops syncing.
export async function syncX(env, now = Date.now(), fetcher = fetch, limit = 25) {
  if (!xConfigured(env)) return { synced: 0 };
  const due = (await env.DB.prepare("SELECT wallet, x_id, x_refresh FROM profiles WHERE x_refresh IS NOT NULL AND COALESCE(x_synced_at, 0) < ? ORDER BY x_synced_at LIMIT ?")
    .bind(now - SYNC_EVERY, limit).all()).results;
  let synced = 0;
  for (const p of due) {
    const tok = await fetcher(TOKEN, { method: "POST", headers: tokenHeaders(env), body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: p.x_refresh, client_id: env.X_CLIENT_ID }) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })).catch(() => null);
    if (!tok?.body?.access_token) {
      if (tok && tok.status >= 400 && tok.status < 500) await env.DB.prepare("UPDATE profiles SET x_refresh = NULL, x_synced_at = ? WHERE wallet = ?").bind(now, p.wallet).run();
      continue; // network trouble: try again next time
    }
    const u = await readMe(tok.body.access_token, fetcher);
    if (!u || u.id !== p.x_id) continue;
    await env.DB.prepare("UPDATE profiles SET x_handle = ?, x_name = ?, x_pfp = ?, x_refresh = ?, x_synced_at = ? WHERE wallet = ?")
      .bind(u.username, u.name || u.username, biggerPfp(u.profile_image_url), tok.body.refresh_token || p.x_refresh, now, p.wallet).run();
    synced++;
  }
  return { synced, due: due.length };
}

// X names/pictures for a set of wallets (for leaderboards): { wallet: {handle, name, pfp} }.
export async function profilesFor(db, wallets) {
  const list = [...new Set(wallets.filter((w) => ADDR.test(w || "")))];
  if (!list.length) return {};
  const rows = (await db.prepare("SELECT p.wallet, p.x_handle, p.x_name, p.x_pfp FROM profiles p JOIN json_each(?) j ON j.value = p.wallet WHERE p.x_handle IS NOT NULL")
    .bind(JSON.stringify(list)).all()).results;
  return Object.fromEntries(rows.map((r) => [r.wallet, publicX(r)]));
}

// Public profile: X identity plus what the cult has paid them.
export async function profileOf(env, cfg, wallet, now = Date.now()) {
  const db = env.DB;
  const [p, h, s, got, mintRow] = await db.batch([
    db.prepare("SELECT x_handle, x_name, x_pfp FROM profiles WHERE wallet = ?").bind(wallet),
    db.prepare("SELECT balance, since FROM holders WHERE wallet = ?").bind(wallet),
    db.prepare("SELECT last_at, sells FROM sellers WHERE wallet = ?").bind(wallet),
    db.prepare(`SELECT COALESCE(SUM(p.micro), 0) AS m, COUNT(*) AS rounds FROM payouts p JOIN batches b ON b.drop_n = p.drop_n AND b.i = p.batch
      WHERE p.wallet = ? AND b.status = 'confirmed' AND p.micro > 0`).bind(wallet),
    db.prepare("SELECT v FROM kv WHERE k = 'mint'"),
  ]);
  const dec = mintRow.results[0] ? JSON.parse(mintRow.results[0].v).decimals : 6;
  const hr = h.results[0], received = got.results[0].m;
  const days = hr ? Math.floor((now - Math.max(hr.since, s.results[0]?.last_at ?? 0)) / DAY) : null;
  let rank = null;
  if (received > 0) {
    const r = await db.prepare(`SELECT COUNT(*) + 1 AS rank FROM (SELECT p.wallet, SUM(p.micro) AS m FROM payouts p JOIN batches b ON b.drop_n = p.drop_n AND b.i = p.batch
      WHERE b.status = 'confirmed' AND p.micro > 0 GROUP BY p.wallet) WHERE m > ?`).bind(received).first();
    rank = r.rank;
  }
  return {
    wallet, x: publicX(p.results[0]),
    balance: hr ? Number(hr.balance) / 10 ** dec : 0,
    devotionDays: days, multiplier: days == null ? 1 : streakMult(cfg, days), nextStreak: days == null ? null : nextStreak(cfg, days),
    receivedUsdc: received / 1e6, rounds: got.results[0].rounds, rank, sells: s.results[0]?.sells || 0,
  };
}

export async function handleProfiles(req, env, url) {
  const cfg = config(env), path = url.pathname, now = Date.now();
  const body = async () => (req.method === "POST" ? await req.json().catch(() => ({})) : {});

  if (path === "/api/auth/challenge" && req.method === "POST") return json(await createChallenge(env, url, (await body()).wallet, now));
  if (path === "/api/auth/signin" && req.method === "POST") {
    const s = await signIn(env, await body(), now);
    return json({ wallet: s.wallet }, 200, { "set-cookie": sessionCookie(s.token, url) });
  }
  if (path === "/api/auth/signout" && req.method === "POST") {
    await signOut(env, req);
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", url, 0) });
  }

  const session = await getSession(env, req, now);
  if (path === "/api/me") {
    if (!session) return json({ signedIn: false, xEnabled: xConfigured(env) });
    const prof = await profileOf(env, cfg, session.wallet, now);
    return json({ signedIn: true, xEnabled: xConfigured(env), holds: (await cultBalance(env, cfg, session.wallet)) > 0n, ...prof });
  }
  if (path === "/api/x/connect") {
    if (!session) throw new HttpError(401, "Sign in with your wallet first.");
    return Response.redirect(await connectUrl(env, session.wallet, url.origin, now), 302);
  }
  if (path === "/api/x/callback") return handleCallback(env, url, session?.wallet, now);
  if (path === "/api/x/disconnect" && req.method === "POST") {
    if (!session) throw new HttpError(401, "Sign in with your wallet first.");
    await env.DB.prepare("UPDATE profiles SET x_id = NULL, x_handle = NULL, x_name = NULL, x_pfp = NULL, x_refresh = NULL WHERE wallet = ?").bind(session.wallet).run();
    return json({ ok: true });
  }
  const m = path.match(/^\/api\/profile\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  if (m) return json(await profileOf(env, cfg, m[1], now));
  return json({ error: "Not found" }, 404);
}
