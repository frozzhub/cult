// Profiles end to end on a local D1: wallet sign-in, holder-only X linking (X mocked), sync, boards.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Keypair } from "@solana/web3.js";
import worker from "../src/index.js";
import { handleCallback, syncX, profilesFor } from "../src/profiles.js";

const PERSIST = ".wrangler/profile-test";
let proxy, env;
const ORIGIN = "https://cult.test";

// A wallet we can sign with: noble keypair -> Solana address.
function makeWallet() {
  const sk = ed25519.utils.randomSecretKey();
  const kp = Keypair.fromSeed(sk);
  return { sk, address: kp.publicKey.toBase58() };
}
const alice = makeWallet(), bob = makeWallet();

before(async () => {
  rmSync(PERSIST, { recursive: true, force: true });
  execSync(`node node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --local --persist-to ${PERSIST}`, { stdio: "ignore", env: { ...process.env, CI: "1" } });
  proxy = await getPlatformProxy({ configPath: "wrangler.jsonc", persist: { path: PERSIST + "/v3" } });
  env = { ...proxy.env, DEMO: "0", MINT: "", X_CLIENT_ID: "client-123", X_CLIENT_SECRET: "shh", ASSETS: { fetch: () => new Response("") } };
});
after(() => proxy?.dispose());

const call = (path, { body, cookie, method } = {}) => worker.fetch(new Request(ORIGIN + path, {
  method: method || (body ? "POST" : "GET"), redirect: "manual",
  headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
}), env);

async function signIn(w) {
  const { nonce, message } = await (await call("/api/auth/challenge", { body: { wallet: w.address } })).json();
  const sig = Buffer.from(ed25519.sign(new TextEncoder().encode(message), w.sk)).toString("base64");
  const res = await call("/api/auth/signin", { body: { wallet: w.address, nonce, signature: sig } });
  assert.equal(res.status, 200, await res.clone().text());
  return res.headers.get("set-cookie").split(";")[0];
}

// X mocked: token exchange, refresh, users/me.
function fakeX({ id = "x-1", username = "alice_x", name = "Alice", pfp = "https://pbs.twimg.com/profile_images/1/a_normal.jpg", refreshStatus = 200 } = {}) {
  return async (url, init) => {
    if (String(url).includes("/oauth2/token")) {
      const p = new URLSearchParams(init.body);
      assert.equal(init.headers.authorization, "Basic " + btoa("client-123:shh"));
      if (p.get("grant_type") === "refresh_token") {
        if (refreshStatus !== 200) return new Response(JSON.stringify({ error: "invalid_request" }), { status: refreshStatus });
        return Response.json({ access_token: "at2", refresh_token: "rt-rotated" });
      }
      assert.equal(p.get("code_verifier").length > 40, true);
      return Response.json({ access_token: "at1", refresh_token: "rt1" });
    }
    if (String(url).includes("/users/me")) return Response.json({ data: { id, username, name, profile_image_url: pfp } });
    throw new Error("unexpected " + url);
  };
}

test("wallet sign-in: valid signature starts a session; wrong signature and reused challenges don't", async () => {
  const cookie = await signIn(alice);
  const me = await (await call("/api/me", { cookie })).json();
  assert.equal(me.signedIn, true);
  assert.equal(me.wallet, alice.address);
  assert.equal(me.holds, false);

  const { nonce, message } = await (await call("/api/auth/challenge", { body: { wallet: alice.address } })).json();
  const badSig = Buffer.from(ed25519.sign(new TextEncoder().encode(message), bob.sk)).toString("base64");
  assert.equal((await call("/api/auth/signin", { body: { wallet: alice.address, nonce, signature: badSig } })).status, 401);
  assert.equal((await call("/api/auth/signin", { body: { wallet: alice.address, nonce, signature: badSig } })).status, 400, "challenge is single use");
  assert.equal((await (await call("/api/me")).json()).signedIn, false);
});

test("linking X needs a $CULT holder; then it redirects to X with PKCE", async () => {
  const cookie = await signIn(alice);
  const no = await call("/api/x/connect", { cookie });
  assert.equal(no.status, 403);
  assert.match((await no.json()).error, /Hold some \$CULT/);

  await env.DB.prepare("INSERT INTO token_accounts (address, owner, amount, slot) VALUES ('acct-a', ?, '5000000', 1)").bind(alice.address).run();
  const res = await call("/api/x/connect", { cookie });
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get("location"));
  assert.equal(to.origin + to.pathname, "https://x.com/i/oauth2/authorize");
  assert.equal(to.searchParams.get("redirect_uri"), ORIGIN + "/api/x/callback");
  assert.equal(to.searchParams.get("code_challenge_method"), "S256");
  assert.match(to.searchParams.get("scope"), /offline\.access/);
  assert.equal((await call("/api/x/connect")).status, 401, "signed out");
});

async function startLink(cookie) {
  const to = new URL((await call("/api/x/connect", { cookie })).headers.get("location"));
  return to.searchParams.get("state");
}

test("callback stores the X name and 400px picture, and the boards show them", async () => {
  const cookie = await signIn(alice);
  const state = await startLink(cookie);
  const res = await handleCallback(env, new URL(`${ORIGIN}/api/x/callback?state=${state}&code=abc`), alice.address, Date.now(), fakeX());
  assert.equal(res.headers.get("location"), `${ORIGIN}/?x=connected#profile`);
  const p = await (await call("/api/profile/" + alice.address)).json();
  assert.deepEqual(p.x, { handle: "alice_x", name: "Alice", pfp: "https://pbs.twimg.com/profile_images/1/a_400x400.jpg" });
  const map = await profilesFor(env.DB, [alice.address, bob.address]);
  assert.deepEqual(Object.keys(map), [alice.address]);
  const me = await (await call("/api/me", { cookie })).json();
  assert.equal(me.holds, true);
  assert.equal(me.x.name, "Alice");
});

test("callback refuses a different signed-in wallet, and one X account can't go on two wallets", async () => {
  const aCookie = await signIn(alice);
  const state = await startLink(aCookie);
  const wrong = await handleCallback(env, new URL(`${ORIGIN}/api/x/callback?state=${state}&code=abc`), bob.address, Date.now(), fakeX());
  assert.match(wrong.headers.get("location"), /x=signin/);

  await env.DB.prepare("INSERT INTO token_accounts (address, owner, amount, slot) VALUES ('acct-b', ?, '7000000', 1)").bind(bob.address).run();
  const bCookie = await signIn(bob);
  const bState = await startLink(bCookie);
  const taken = await handleCallback(env, new URL(`${ORIGIN}/api/x/callback?state=${bState}&code=abc`), bob.address, Date.now(), fakeX()); // same X id as alice
  assert.match(taken.headers.get("location"), /x=taken/);
  const expired = await handleCallback(env, new URL(`${ORIGIN}/api/x/callback?state=nope&code=abc`), bob.address, Date.now(), fakeX());
  assert.match(expired.headers.get("location"), /x=expired/);
});

test("daily sync picks up a new X name and picture, stores the rotated token, and stops on a revoked link", async () => {
  await env.DB.prepare("UPDATE profiles SET x_synced_at = 0 WHERE wallet = ?").bind(alice.address).run();
  const r = await syncX(env, Date.now(), fakeX({ name: "Alice (new)", pfp: "https://pbs.twimg.com/profile_images/2/b_normal.png" }));
  assert.equal(r.synced, 1);
  const row = await env.DB.prepare("SELECT x_name, x_pfp, x_refresh FROM profiles WHERE wallet = ?").bind(alice.address).first();
  assert.deepEqual(row, { x_name: "Alice (new)", x_pfp: "https://pbs.twimg.com/profile_images/2/b_400x400.png", x_refresh: "rt-rotated" });
  assert.equal((await syncX(env, Date.now(), fakeX())).due, 0, "not due again for a day");

  await env.DB.prepare("UPDATE profiles SET x_synced_at = 0 WHERE wallet = ?").bind(alice.address).run();
  await syncX(env, Date.now(), fakeX({ refreshStatus: 400 }));
  const revoked = await env.DB.prepare("SELECT x_name, x_refresh FROM profiles WHERE wallet = ?").bind(alice.address).first();
  assert.deepEqual(revoked, { x_name: "Alice (new)", x_refresh: null }, "keeps the last name, stops syncing");
});

test("unlink and sign out", async () => {
  const cookie = await signIn(alice);
  assert.equal((await call("/api/x/disconnect", { cookie, body: {} })).status, 200);
  assert.equal((await (await call("/api/profile/" + alice.address)).json()).x, null);
  const out = await call("/api/auth/signout", { cookie, body: {} });
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await (await call("/api/me", { cookie })).json()).signedIn, false);
});
