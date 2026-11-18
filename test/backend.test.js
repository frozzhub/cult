// Backend paths: reading a sell/buy from RPC balances, holder snapshot fallbacks, 429 retries, endpoint lists, the chart series.
// (The pool-price tests, parseRpcSell/poolPrice/parseTrade, went with the custom pool: a trade is read from token balances by
// src/trades.js now, tested against real transactions in trades.test.js and here on synthetic ones.)
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { parseTokenBalances } from "../src/indexer.js";
import { rpcChanges, readTrade } from "../src/trades.js";
import { tokenHolders, rpc } from "../src/chain.js";
import { config } from "../src/config.js";
import { pda } from "./fakes.js";

const addr = () => Keypair.generate().publicKey.toBase58();
const MINT = addr(), POOL = pda(), PAYOUT = addr(), USER = addr(), USER_ACCT = addr(), POOL_ACCT = addr(); // POOL: a pool vault's owner, off the curve
const cfg = config({ MINT, PAYOUT_WALLET: PAYOUT });
const env = { SOLANA_RPC_URL: "https://rpc.test" };
const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

const tb = (accountIndex, owner, amount) => ({ accountIndex, mint: MINT, owner, uiTokenAmount: { amount: String(amount), decimals: 6 } });
// A getTransaction (jsonParsed): the user's token account is key 0, the pool vault's key 2.
const rpcTx = ({ userTok = [5_000_000, 0], poolTok = [100, 4_500_100], err = null } = {}) => ({
  slot: 11, blockTime: 1_800_000_000,
  meta: { err, fee: 5000, preTokenBalances: [tb(0, USER, userTok[0]), tb(2, POOL, poolTok[0])], postTokenBalances: [tb(0, USER, userTok[1]), tb(2, POOL, poolTok[1])] },
  transaction: { signatures: ["sig1"], message: { accountKeys: [{ pubkey: USER_ACCT }, { pubkey: PAYOUT }, { pubkey: POOL_ACCT }] } },
});

test("a sell read from RPC balances: the wallet's loss is the size, what the vault didn't get is the tax", () => {
  const c = rpcChanges(rpcTx(), MINT);
  const s = readTrade(c, { payout: PAYOUT, taxBps: 1000 });
  assert.deepEqual([s.side, s.wallet, s.tokens, s.withheld, s.net], ["sell", USER, 5_000_000n, 500_000n, 4_500_000n]);
  assert.equal(c.at, 1_800_000_000_000);
  assert.equal(c.sig, "sig1");
});

test("buys, failed txs and unrelated txs: a buy is a buy and never a sell; the rest read as nothing", () => {
  const b = readTrade(rpcChanges(rpcTx({ userTok: [0, 4_500_000], poolTok: [10_000_000, 5_000_000] }), MINT), { payout: PAYOUT });
  assert.deepEqual([b.side, b.wallet, b.tokens, b.withheld], ["buy", USER, 5_000_000n, 500_000n]);
  assert.equal(rpcChanges(rpcTx({ err: { InstructionError: [0, { Custom: 6002 }] } }), MINT), null);
  assert.equal(readTrade(rpcChanges(rpcTx({ userTok: [5, 5], poolTok: [5, 5] }), MINT), { payout: PAYOUT }), null);
  assert.equal(readTrade(rpcChanges(rpcTx(), addr()), { payout: PAYOUT }), null, "another mint");
  assert.equal(rpcChanges(null, MINT), null);
  assert.equal(readTrade(null), null);
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

test("parseTokenBalances: post-balances of every $CULT account the tx touched", () => {
  const tx = rpcTx();
  tx.meta.postTokenBalances = [tb(1, USER, 0), tb(2, POOL, 5_000_100), { mint: addr(), owner: USER, accountIndex: 0, uiTokenAmount: { amount: "9" } }];
  assert.deepEqual(parseTokenBalances(tx, cfg), [
    { address: PAYOUT, owner: USER, amount: "0" },
    { address: POOL_ACCT, owner: POOL, amount: "5000100" },
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

test("bucketSeries: last price per bucket, carried forward, ends at the live price", async () => {
  const { bucketSeries } = await import("../src/live.js");
  const trades = [{ at: 10, usd: 1 }, { at: 15, usd: 2 }, { at: 75, usd: 3 }];
  const pts = bucketSeries(trades, { from: 0, to: 100, buckets: 4, nowPrice: 3.5 });
  assert.deepEqual(pts, [[25, 2], [50, 2], [75, 3], [100, 3], [100, 3.5]]);
  assert.deepEqual(bucketSeries([], { from: 0, to: 100, buckets: 2, startPrice: 7 }), [[50, 7], [100, 7]]);
  assert.deepEqual(bucketSeries([], { from: 0, to: 100 }), []);
});
