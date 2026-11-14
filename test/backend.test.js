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