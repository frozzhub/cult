import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Keypair, PublicKey, VersionedTransaction, TransactionMessage, SystemProgram } from "@solana/web3.js";
import worker from "../src/index.js";
import { config } from "../src/config.js";
import { poolAddress } from "../src/trade.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const addr = () => Keypair.generate().publicKey.toBase58();
const POOL_PROGRAM = "J6zYGwRTLX17ms2dDZ6yGXP21xfigBwLKvYXho2Aw9Bu", HOOK_PROGRAM = "794MkqjE5VxXMVX9pJFK9D6YeK9pKp59K5BkBULfnSG2";
const MINT = addr(), PAYOUT = addr();
const env = { DEMO: "0", MINT, POOL_PROGRAM, HOOK_PROGRAM, PAYOUT_WALLET: PAYOUT, SOLANA_RPC_URL: "https://rpc.test", ASSETS: { fetch: () => new Response("") } };
const cfg = config(env);
const POOL = poolAddress(cfg).toBase58();
const VAULT = getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(POOL), true, TOKEN_2022_PROGRAM_ID).toBase58();

// Pool account: 8 disc | mint | vault | payout | fee u16 | sol_reserve u64 | bump
const data = Buffer.alloc(8 + 96 + 2 + 8 + 1);
new PublicKey(VAULT).toBuffer().copy(data, 40);
new PublicKey(MINT).toBuffer().copy(data, 8);

new PublicKey(PAYOUT).toBuffer().copy(data, 72);
data.writeUInt16LE(1500, 104);
data.writeBigUInt64LE(100n * 1_000_000_000n, 106); // 100 SOL
const TOKENS = 500_000_000n * 1_000_000n;            // 500M $PAPER, 6 decimals
let sent = 0, rpcCalls = 0;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith("https://rpc.test")) return realFetch(input, init);
  const { method, params } = JSON.parse(init.body);
  rpcCalls++;
  const result = {
    getMultipleAccounts: () => {
      assert.deepEqual(params[0], [POOL, VAULT, MINT]);
      const va = Buffer.alloc(165); va.writeBigUInt64LE(TOKENS, 64);
      const m = Buffer.alloc(82); m[44] = 6;
      return { value: [data, va, m].map((b) => ({ data: [b.toString("base64"), "base64"] })) };
    },
    getLatestBlockhash: () => ({ value: { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 } }),
    sendTransaction: () => { sent++; return "x"; },
  }[method]();
  return Response.json({ jsonrpc: "2.0", id: 1, result });
};
after(() => (globalThis.fetch = realFetch));

const call = (p, body) => worker.fetch(new Request("http://x" + p, body ? { method: "POST", body: JSON.stringify(body) } : {}), env);

test("config derives the pool address from the program and mint", () => {
  assert.equal(cfg.pool, POOL);
});

test("/api/pool reads reserves and the fee", async () => {
  const p = await (await call("/api/pool")).json();
  assert.deepEqual(p, { solReserve: "100000000000", tokenReserve: TOKENS.toString(), feeBps: 1500, decimals: 6 });
});

test("a sell quote takes 15% off the SOL out, and min-out applies slippage", async () => {
  const user = addr();
  const amount = 5_000_000n * 1_000_000n; // 1% of the pool
  const r = await (await call("/api/trade", { wallet: user, side: "sell", amount: amount.toString(), slippageBps: 100 })).json();
  const gross = (amount * 100_000_000_000n) / (TOKENS + amount);
  const net = gross - (gross * 1500n) / 10_000n;
  assert.equal(r.out, net.toString());
  assert.equal(r.minOut, ((net * 9900n) / 10_000n).toString());

  const tx = VersionedTransaction.deserialize(Buffer.from(r.transaction, "base64"));
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  assert.equal(keys[0], user, "the user pays the fees");
  const ix = tx.message.compiledInstructions.find((i) => keys[i.programIdIndex] === POOL_PROGRAM);
  const disc = createHash("sha256").update("global:sell").digest().subarray(0, 8);
  assert.deepEqual(Buffer.from(ix.data.subarray(0, 8)), disc);
  assert.equal(Buffer.from(ix.data).readBigUInt64LE(8), amount);
  assert.equal(ix.accountKeyIndexes.length, 11);
  assert.equal(keys[ix.accountKeyIndexes[2]], POOL);
  assert.equal(keys[ix.accountKeyIndexes[3]], VAULT);
  assert.equal(keys[ix.accountKeyIndexes[5]], PAYOUT);
  assert.equal(keys[ix.accountKeyIndexes[9]], HOOK_PROGRAM);
});

test("a buy has no fee", async () => {
  const r = await (await call("/api/trade", { wallet: addr(), side: "buy", amount: "1000000000", slippageBps: 50 })).json();
  assert.equal(r.out, ((1_000_000_000n * TOKENS) / (100_000_000_000n + 1_000_000_000n)).toString());
});

test("/api/send only relays transactions that call the pool", async () => {
  const kp = Keypair.generate();
  const other = new VersionedTransaction(new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: addr(), instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 })] }).compileToV0Message());
  other.sign([kp]);
  const res = await call("/api/send", { signed: Buffer.from(other.serialize()).toString("base64") });
  assert.equal(res.status, 400);
  assert.equal(sent, 0);
});

test("client-read reserves (CLIENT_RPC): builds the trade with no RPC calls, addresses derived server-side", async () => {
  const before = rpcCalls;
  const cenv = { ...env, CLIENT_RPC: "https://client.test" };
  const res = await worker.fetch(new Request("http://x/api/trade", { method: "POST", body: JSON.stringify({
    wallet: addr(), side: "buy", amount: "1000000000", slippageBps: 100,
    pool: { solReserve: "100000000000", tokenReserve: TOKENS.toString(), feeBps: 1500 }, blockhash: addr(),
  }) }), cenv);
  const r = await res.json();
  assert.ok(r.transaction, JSON.stringify(r));
  assert.equal(rpcCalls, before, "no RPC used");
  const tx = VersionedTransaction.deserialize(Buffer.from(r.transaction, "base64"));
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  assert.ok(keys.includes(POOL) && keys.includes(VAULT) && keys.includes(PAYOUT));
  const st = await (await worker.fetch(new Request("http://x/api/state"), cenv)).json();
  assert.deepEqual(st.accounts, { pool: POOL, vault: VAULT });
  assert.equal(st.clientRpc, "https://client.test");
});

test("client-read reserves are ignored unless CLIENT_RPC is on", async () => {
  const before = rpcCalls;
  await call("/api/trade", { wallet: addr(), side: "buy", amount: "1000000000", pool: { solReserve: "1", tokenReserve: "1", feeBps: 0 }, blockhash: addr() });
  assert.ok(rpcCalls > before, "read the pool itself");
});