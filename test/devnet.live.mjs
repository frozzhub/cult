// Backend against the real devnet launch (run: npm run test:devnet). Needs network.
//  - parseRpcSell on the smoke test's real buy and sell
//  - a full DRY_RUN airdrop cycle on a fresh local D1: poll sells from devnet -> snapshot holders with
//    getProgramAccounts (public RPC has no Helius DAS) -> price from the pool -> allocate -> "pay"
//  - /api/state and /api/wallet show it
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import worker from "../src/index.js";
import { config } from "../src/config.js";
import { parseRpcSell, tick } from "../src/indexer.js";
import { rpc } from "../src/chain.js";

const RPC = process.env.DEVNET_RPC || "https://api.devnet.solana.com";
const MINT = "FpAWetRJ4MJm4mUdTUVeagoHjcQv3oXevu9XUcVFuN6a";
const PAYOUT = "GCpRo9fhAho6XhCrihAjgMz9WNiTB5Z6mYtFtmnYEBbc";
const TRADER = "DKWtaJzTYdtNy2CsGXhP4TXtQEYkhmTvDBp45C9na5H";
const BUY = "4tyL1JXSbX5UqwprBepjCxsbbHhPUSuocVVd8YQTUjkMH2jEVUTBSJ8HGsfRkJCiR6rDmVkDgSspNRDRzSFrHivm";
const SELL = "gb2hKAtMbvEEkS7cp2aHm6uEjjNtGjX2uHYe3xtYqp3KESvJU8mrgBFhByWKmdLg7opgREGyEaL9avd61HLkGVe";
const PERSIST = ".wrangler/devnet-test";
const base = {
  DEMO: "0", DRY_RUN: "1", HOLDERS: process.env.HOLDERS || "", MINT, PAYOUT_WALLET: PAYOUT, SOLANA_RPC_URL: RPC, MIN_HOLD_USD: "0",
  POOL_PROGRAM: "J6zYGwRTLX17ms2dDZ6yGXP21xfigBwLKvYXho2Aw9Bu", HOOK_PROGRAM: "794MkqjE5VxXMVX9pJFK9D6YeK9pKp59K5BkBULfnSG2",
  ASSETS: { fetch: () => new Response("") },
};
const cfg = config(base);
const getTx = (sig) => rpc(base, "getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
let proxy, env;

before(async () => {
  rmSync(PERSIST, { recursive: true, force: true });
  execSync(`node node_modules/wrangler/bin/wrangler.js d1 migrations apply cult-mainnet --local --persist-to ${PERSIST}`, { stdio: "ignore", env: { ...process.env, CI: "1" } });
  proxy = await getPlatformProxy({ configPath: "wrangler.jsonc", persist: { path: PERSIST + "/v3" } });
  env = { ...proxy.env, ...base };
});
after(() => proxy?.dispose());

test("parseRpcSell reads the real devnet sell and ignores the buy", async () => {
  assert.equal(parseRpcSell(BUY, await getTx(BUY), cfg), null);
  const s = parseRpcSell(SELL, await getTx(SELL), cfg);
  assert.equal(s.wallet, TRADER);
  assert.equal(s.fee, 15_937_499);       // exactly what the payout wallet received
  assert.equal(s.solOut, 90_312_500);    // what the smoke test quoted as net
  assert.ok(Math.abs(s.tokens - 58_823_529.411764) < 1);
});

test("a full dry-run airdrop on devnet: poll, snapshot, price from pool, allocate, pay", async () => {
  const r = await tick(env, Date.now() + 3_600_000); // pretend it's next hour so the smoke sell is claimed
  assert.equal(r.status, "done", JSON.stringify(r));
  const accts = (await env.DB.prepare("SELECT * FROM token_accounts WHERE owner = ?").bind(TRADER).all()).results;
  assert.equal(accts.length, 1, "holder index has the trader's account");
  const onchain = await rpc(base, "getTokenAccountBalance", [accts[0].address]);
  assert.equal(accts[0].amount, onchain.value.amount, "index matches the chain");
  const sells = (await env.DB.prepare("SELECT * FROM sells").all()).results;
  assert.ok(sells.some((s) => s.sig === SELL && s.fee_lamports === 15_937_499), "poller found the first sell");
  assert.ok(sells.length >= 2, "and the live-site sell");
  assert.ok(!sells.some((s) => s.sig === BUY), "buy not recorded as a sell");
  const d = await env.DB.prepare("SELECT * FROM drops").first();
  assert.ok(d.price_usd > 0, "priced from the pool");
  assert.ok(d.usdc_micro > 0, JSON.stringify(d));
  const paid = (await env.DB.prepare("SELECT wallet, micro FROM payouts WHERE micro > 0").all()).results;
  assert.deepEqual(paid.map((p) => p.wallet), [TRADER], "the trader is the only holder outside the pool");

  const st = await (await worker.fetch(new Request("http://x/api/state"), env)).json();
  assert.equal(st.live, true);
  assert.equal(st.trade, true);
  assert.equal(st.wall.top[0].wallet, TRADER);
  assert.equal(st.drops.length, 1);
  const w = await (await worker.fetch(new Request("http://x/api/wallet/" + TRADER), env)).json();
  assert.ok(Math.abs(w.balance - Number(onchain.value.amount) / 1e6) < 1);
  assert.ok(w.share > 0.99);
  assert.ok(w.receivedUsdc > 0);

  assert.deepEqual(await tick(env, Date.now() + 3_600_000), { idle: true }, "nothing new in the same hour");
});
