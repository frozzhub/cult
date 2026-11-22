// Prices (indexer.cachedPrices): Jupiter's price API, a 60-second cache, the last good value per field, the curve's own
// price for a coin Jupiter hasn't priced yet, and never a 0 stored as if it were a price.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { cachedPrices } from "../src/indexer.js";
import { config } from "../src/config.js";
import { addr } from "./fakes.js";
import { makeVault, CLEAR, boot, freshS, installFakes } from "./engine-fakes.js";

const PERSIST = ".wrangler/price-test";
const kp = Keypair.generate(), MINT = addr(), PAYOUT = kp.publicKey.toBase58(), VAULT = makeVault();
const T = 1_800_000_000_000;
let proxy, env, S, restoreFetch;
before(async () => {
  ({ proxy, env } = await boot(PERSIST, { MINT, PAYOUT, kp }));
  restoreFetch = installFakes({ S: () => S, MINT, PAYOUT, env: () => env });
});
after(async () => { await proxy?.dispose(); restoreFetch?.(); });
beforeEach(async () => {
  S = freshS({ PAYOUT, vault: VAULT });
  await env.DB.batch(CLEAR.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

const cfg = () => config(env);
const stored = () => env.DB.prepare("SELECT v, at FROM kv WHERE k = 'price'").first().then((r) => r && { ...JSON.parse(r.v), at: r.at });
const curve = (priceSol, at) => env.DB.prepare("INSERT INTO kv (k, v, at) VALUES ('curve', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify({ stage: "curve", priceSol, at }), at).run();

test("one Jupiter call a minute: the answer is cached for 60 seconds and fetched again after", async () => {
  assert.deepEqual(await cachedPrices(env, cfg(), T), { sol: 200, token: 0.001 });
  S.tokenUsd = 0.002;
  assert.deepEqual(await cachedPrices(env, cfg(), T + 59_000), { sol: 200, token: 0.001 }, "inside the minute: the cached figure, no call");
  assert.equal(S.priceCalls, 1);
  assert.deepEqual(await cachedPrices(env, cfg(), T + 60_000), { sol: 200, token: 0.002 });
  assert.equal(S.priceCalls, 2);
});

test("Jupiter down: each figure keeps its last good value, and the next try is 30 seconds away, not a minute", async () => {
  await cachedPrices(env, cfg(), T);
  S.priceDown = true;
  assert.deepEqual(await cachedPrices(env, cfg(), T + 61_000), { sol: 200, token: 0.001 }, "the last good prices, not zero");
  assert.equal(S.priceCalls, 2);
  assert.equal((await stored()).at, T + 61_000 - 30_000, "stamped so the cache runs out in 30 seconds");
  S.priceDown = false; S.solUsd = 210;
  assert.equal((await cachedPrices(env, cfg(), T + 61_000 + 29_000)).sol, 200, "29 seconds later: still the cached one");
  assert.equal(S.priceCalls, 2);
  assert.equal((await cachedPrices(env, cfg(), T + 61_000 + 31_000)).sol, 210, "31 seconds later: fetched again");
});

test("a figure Jupiter leaves out keeps its own last good value: the coin's and SOL's separately", async () => {
  await cachedPrices(env, cfg(), T);
  S.tokenUsd = 0; S.solUsd = 210; // no price for the coin today
  assert.deepEqual(await cachedPrices(env, cfg(), T + 61_000), { sol: 210, token: 0.001 });
  S.tokenUsd = 0.003; S.solUsd = 0; // none for SOL
  assert.deepEqual(await cachedPrices(env, cfg(), T + 122_000), { sol: 210, token: 0.003 });
});

test("a coin Jupiter hasn't priced: the curve's own price (SOL per coin x SOL's USD price) while the cron's read is under ten minutes old, nothing after", async () => {
  S.tokenUsd = 0;
  await curve(0.000005, T);
  assert.deepEqual(await cachedPrices(env, cfg(), T + 1_000), { sol: 200, token: 0.001 });
  await env.DB.prepare("DELETE FROM kv WHERE k = 'price'").run();
  assert.deepEqual(await cachedPrices(env, cfg(), T + 599_000), { sol: 200, token: 0.001 }, "the edge: 599 seconds old is still fresh");
  await env.DB.prepare("DELETE FROM kv WHERE k = 'price'").run();
  assert.deepEqual(await cachedPrices(env, cfg(), T + 601_000), { sol: 200, token: 0 }, "older than ten minutes: unknown, not a guess");
});

test("a coin Jupiter has no price for is asked about again on the next call (the curve read may have arrived since); a priced coin is cached for the minute", async () => {
  S.tokenUsd = 0;
  await cachedPrices(env, cfg(), T); await cachedPrices(env, cfg(), T + 1_000);
  assert.equal(S.priceCalls, 2, "no 60-second wait for a coin that has no price yet");
  await curve(0.000005, T + 1_500);
  assert.deepEqual(await cachedPrices(env, cfg(), T + 2_000), { sol: 200, token: 0.001 });
  assert.equal(S.priceCalls, 3);
  await cachedPrices(env, cfg(), T + 3_000);
  assert.equal(S.priceCalls, 3, "priced now: cached");
});

test("with nothing known and no last good value nothing is stored: a zero is never a price", async () => {
  S.solUsd = 0; S.tokenUsd = 0;
  assert.deepEqual(await cachedPrices(env, cfg(), T), { sol: 0, token: 0 });
  assert.equal(await stored(), null);
  S.priceDown = true;
  assert.deepEqual(await cachedPrices(env, cfg(), T + 120_000), { sol: 0, token: 0 });
  assert.equal(await stored(), null);
});
