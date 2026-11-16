// New backend paths: RPC sell parsing, pool pricing, holder snapshot fallbacks, 429 retries.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { parseRpcSell, poolPrice } from "../src/indexer.js";
import { tokenHolders, rpc } from "../src/chain.js";
import { config } from "../src/config.js";

const addr = () => Keypair.generate().publicKey.toBase58();
const MINT = addr(), POOL = addr(), PAYOUT = addr(), USER = addr();
const cfg = config({ MINT, POOL_ACCOUNT: POOL, PAYOUT_WALLET: PAYOUT });
const env = { SOLANA_RPC_URL: "https://rpc.test" };
const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

const tb = (owner, amount) => ({ mint: MINT, owner, uiTokenAmount: { amount: String(amount), decimals: 6 } });
const rpcTx = ({ userTok = [5_000_000, 0], poolTok = [100, 5_000_100], lamports = [[1e9, 1.849995e9], [1e7, 1.015e8]], err = null } = {}) => ({
  blockTime: 1_800_000_000,
  meta: {
    err, fee: 5000,
    preTokenBalances: [tb(USER, userTok[0]), tb(POOL, poolTok[0])],
    postTokenBalances: [tb(USER, userTok[1]), tb(POOL, poolTok[1])],
    preBalances: [lamports[0][0], lamports[1][0], 5e9],
    postBalances: [lamports[0][1], lamports[1][1], 4e9],
  },
  transaction: { message: { accountKeys: [{ pubkey: USER }, { pubkey: PAYOUT }, { pubkey: POOL }] } },
});

test("parseRpcSell: a sell", () => {
  const s = parseRpcSell("sig1", rpcTx(), cfg);
  assert.equal(s.wallet, USER);
  assert.equal(s.tokens, 5);
  assert.equal(s.fee, 91_500_000);
  assert.equal(s.solOut, 850_000_000); // includes the tx fee the seller paid
  assert.equal(s.at, 1_800_000_000_000);
});

test("parseRpcSell: buys, failed txs and unrelated txs are ignored", () => {
  assert.equal(parseRpcSell("b", rpcTx({ userTok: [0, 5], poolTok: [10, 5] }), cfg), null);
  assert.equal(parseRpcSell("f", rpcTx({ err: { InstructionError: [0, { Custom: 6002 }] } }), cfg), null);
  assert.equal(parseRpcSell("n", rpcTx({ userTok: [5, 5], poolTok: [5, 5] }), cfg), null);
  assert.equal(parseRpcSell("x", null, cfg), null);
});

test("poolPrice: SOL per token times SOL price", () => {
  // 20 SOL against 1B tokens at $200/SOL = $0.000004
  const p = poolPrice({ solReserve: 20_000_000_000n, tokenReserve: 1_000_000_000_000_000n, decimals: 6 }, 200);
  assert.ok(Math.abs(p - 0.000004) < 1e-12);
});

function mockRpc(handler) {
  globalThis.fetch = async (_u, init) => {
    const { method, params } = JSON.parse(init.body);
    const out = handler(method, params);
    if (out?.status) return new Response("", { status: out.status });
    if (out?.error) return Response.json({ jsonrpc: "2.0", id: 1, error: out.error });
    return Response.json({ jsonrpc: "2.0", id: 1, result: out });
  };
}

test("tokenHolders: Helius DAS, paged by cursor", async () => {
  let calls = 0;
  mockRpc((m, p) => {
    assert.equal(m, "getTokenAccounts");
    assert.equal(p.mint, MINT);
    calls++;
    if (!p.cursor) return { token_accounts: [{ owner: USER, amount: 5 }, { owner: USER, amount: 7 }], cursor: "c1" };
    return { token_accounts: [], cursor: null };
  });
  const h = await tokenHolders(env, MINT, "prog");
  assert.equal(h.get(USER), 12n, "two accounts, same owner, summed");
  assert.equal(calls, 2);
});

test("tokenHolders: falls back to `mintAddress` (Solana Foundation RPCs)", async () => {
  mockRpc((m, p) => (p.mint ? { error: { code: -32602, message: "unknown field `mint`, expected one of `ownerAddress`, `mintAddress`" } }
    : p.cursor ? { token_accounts: [] } : { token_accounts: [{ owner: USER, amount: 3 }], cursor: "c" }));
  assert.equal((await tokenHolders(env, MINT, "prog")).get(USER), 3n);
});

test("tokenHolders: falls back to getProgramAccounts when there's no DAS at all", async () => {
  mockRpc((m) => (m === "getTokenAccounts" ? { error: { code: -32601, message: "Method not found" } }
    : [{ account: { data: { parsed: { info: { owner: USER, tokenAmount: { amount: "9" } } } } } }]));
  assert.equal((await tokenHolders(env, MINT, "prog")).get(USER), 9n);
});

test("tokenHolders: real errors aren't swallowed", async () => {
  mockRpc(() => ({ error: { code: -32000, message: "node is behind" } }));
  await assert.rejects(tokenHolders(env, MINT, "prog"), /node is behind/);
});

test("rpc retries on 429 and then succeeds", async () => {
  let n = 0;
  mockRpc(() => (++n < 3 ? { status: 429 } : 42));
  assert.equal(await rpc(env, "getSlot", []), 42);
  assert.equal(n, 3);
});

test("parseTokenBalances: post-balances of every $PAPER account the tx touched", async () => {
  const { parseTokenBalances } = await import("../src/indexer.js");
  const tx = rpcTx();
  tx.meta.postTokenBalances = [{ ...tb(USER, 0), accountIndex: 1 }, { ...tb(POOL, 5_000_100), accountIndex: 2 }, { mint: addr(), owner: USER, accountIndex: 0, uiTokenAmount: { amount: "9" } }];
  assert.deepEqual(parseTokenBalances(tx, cfg), [
    { address: PAYOUT, owner: USER, amount: "0" },
    { address: POOL, owner: POOL, amount: "5000100" },
  ]);
  assert.deepEqual(parseTokenBalances({ meta: { err: {} } }, cfg), []);
});
test("HELIUS_KEY secret goes first, on the env's network", async () => {
  const { rpcUrls } = await import("../src/chain.js");
  const k = "a".repeat(36);
  assert.deepEqual(rpcUrls({ SOLANA_RPC_URL: "https://x.test,https://y.test", HELIUS_KEY: k, CLUSTER: "devnet" }),
    [`https://devnet.helius-rpc.com/?api-key=${k}`, "https://x.test", "https://y.test"]);
  assert.deepEqual(rpcUrls({ HELIUS_KEY: k }), [`https://mainnet.helius-rpc.com/?api-key=${k}`]);
  assert.deepEqual(rpcUrls({}), ["https://api.mainnet-beta.solana.com"]);
});

test("rpc fails over to the next endpoint when one is throttled", async () => {
  const hits = [];
  globalThis.fetch = async (u) => { hits.push(String(u)); return String(u).includes("a.test") ? new Response("", { status: 429 }) : Response.json({ jsonrpc: "2.0", id: 1, result: 7 }); };
  assert.equal(await rpc({ SOLANA_RPC_URL: "https://a.test,https://b.test" }, "getSlot", []), 7);
  assert.deepEqual(hits, ["https://a.test", "https://b.test"]);
});
test("parseTrade: buys and sells through the pool, priced after the trade; seeding the pool isn't a trade", async () => {
  const { parseTrade, POOL_RENT } = await import("../src/indexer.js");
  // sell: pool +5 $PAPER (raw 5e6), pool SOL 5e9 -> 4e9
  const sell = parseTrade("s", rpcTx(), cfg);
  assert.equal(sell.side, "sell");
  assert.equal(sell.sol, 1e9);
  assert.ok(Math.abs(sell.priceSol - ((4e9 - POOL_RENT) / 1e9) / (5_000_100 / 1e6)) < 1e-12);
  // buy: pool loses tokens, gains SOL
  const b = rpcTx({ userTok: [0, 5_000_000], poolTok: [10_000_000, 5_000_000] });
  b.meta.preBalances[2] = 4e9; b.meta.postBalances[2] = 5e9;
  assert.equal(parseTrade("b", b, cfg).side, "buy");
  // launch: pool gains both
  const seed = rpcTx({ userTok: [1e9, 0], poolTok: [0, 1e9] });
  seed.meta.preBalances[2] = 0; seed.meta.postBalances[2] = 2e9;
  assert.equal(parseTrade("x", seed, cfg), null);
  assert.equal(parseRpcSell("x", seed, cfg), null, "and it isn't a sell on the Wall either");
});

test("bucketSeries: last price per bucket, carried forward, ends at the live price", async () => {
  const { bucketSeries } = await import("../src/live.js");
  const trades = [{ at: 10, usd: 1 }, { at: 15, usd: 2 }, { at: 75, usd: 3 }];
  const pts = bucketSeries(trades, { from: 0, to: 100, buckets: 4, nowPrice: 3.5 });
  assert.deepEqual(pts, [[25, 2], [50, 2], [75, 3], [100, 3], [100, 3.5]]);
  assert.deepEqual(bucketSeries([], { from: 0, to: 100, buckets: 2, startPrice: 7 }), [[50, 7], [100, 7]]);
  assert.deepEqual(bucketSeries([], { from: 0, to: 100 }), []);
});
test("cumulativeSeries: running total that only goes up, thinned evenly, always ending at the true total", async () => {
  const { cumulativeSeries } = await import("../src/live.js");
  const drops = [{ at: 1, usdc: 2 }, { at: 2, usdc: 0.5 }, { at: 3, usdc: 1.5 }];
  assert.deepEqual(cumulativeSeries(drops), [[1, 2, 2], [2, 2.5, 0.5], [3, 4, 1.5]]);
  const many = Array.from({ length: 1000 }, (_, i) => ({ at: i, usdc: 1 }));
  const s = cumulativeSeries(many, 160);
  assert.equal(s.length, 160);
  assert.deepEqual(s.at(-1), [999, 1000, 1]);
  assert.deepEqual(s[0], [0, 1, 1]);
  assert.ok(s.every((p, i, a) => !i || p[1] >= a[i - 1][1]));
  assert.deepEqual(cumulativeSeries([]), []);
});