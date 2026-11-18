// The fixes for the second money review (docs/reviews/2026-11-16-money-2-curve.md) that need no database: the priority fee a vault
// sweep bids (N1), the settings' defaults (N2, N4), and the priority fee Jupiter is asked for (N5). The fixes that do are tested
// next to their code: test/fees.test.js (N1, N2), test/dbc.test.js (N4, N7), test/launch-fixes.test.js (N4, N10).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { priorityFee } from "../src/chain.js";
import { swapTx } from "../src/jupiter.js";
import { config, USDC_MINT } from "../src/config.js";
import { jupQuote, jupSwapInstructions, addr } from "./fakes.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const env = { SOLANA_RPC_URL: "https://rpc.test", JUP_API_KEY: "k" };

/* ---------- N1: what a vault sweep bids ---------- */

const rpcAnswering = (answer) => {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const r = typeof answer === "function" ? answer(body) : answer;
    return Response.json(r instanceof Error ? { jsonrpc: "2.0", id: 1, error: { code: -32000, message: r.message } } : { jsonrpc: "2.0", id: 1, result: r });
  };
  return calls;
};
const fees = (list) => list.map((prioritizationFee, i) => ({ slot: 100 + i, prioritizationFee }));

test("priorityFee: the 75th percentile of what landed on the accounts recently, between the floor and the cap", async () => {
  const calls = rpcAnswering(fees(Array.from({ length: 101 }, (_, i) => i * 100_000).reverse())); // 0 .. 10,000,000, unsorted
  const a = addr();
  assert.equal(await priorityFee(env, [a], 100_000, 20_000_000), 7_500_000, "index 75 of 0..100 steps of 100,000");
  assert.deepEqual(calls[0].method, "getRecentPrioritizationFees");
  assert.deepEqual(calls[0].params, [[a]], "asked about the accounts the transaction will write");
  assert.equal(await priorityFee(env, [a], 100_000, 5_000_000), 5_000_000, "capped");
  assert.equal(await priorityFee(env, [a], 8_000_000, 20_000_000), 8_000_000, "never below the floor");
  assert.equal(await priorityFee(env, [a], 9, 5), 9, "a floor above the cap is still the floor: never less than we pay today");
});

test("priorityFee: an RPC that fails, answers with nothing, or answers rubbish gives the floor, never a guess upward", async () => {
  const log = console.error; console.error = () => {};
  try {
    for (const answer of [new Error("method not found"), [], null, "x", [{ slot: 1 }], fees([-5, NaN])]) {
      rpcAnswering(answer);
      assert.equal(await priorityFee(env, [addr()], 123_456, 10_000_000), 123_456, JSON.stringify(answer));
    }
    globalThis.fetch = async () => { throw new Error("network down"); };
    assert.equal(await priorityFee(env, [addr()], 123_456, 10_000_000), 123_456);
  } finally { console.error = log; }
});

/* ---------- N5: the priority fee Jupiter is asked for ---------- */

test("N5: the swap asks Jupiter for a priority fee capped at the cap inspect() enforces (3,000,000 lamports), never 'auto'", async () => {
  const USER = Keypair.generate().publicKey.toBase58(), MINT = addr();
  let body = null;
  globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return Response.json(jupSwapInstructions({ user: USER, inputMint: MINT, inputProgram: TOKEN_2022_PROGRAM_ID, outputMint: USDC_MINT, amount: 1_000_000n })); };
  const q = jupQuote({ inputMint: MINT, outputMint: USDC_MINT, amount: 1_000_000n, out: 50_000_000n });
  const cfg = config({ MINT, PAYOUT_WALLET: USER, JUP_API: "https://jup.test" });
  await swapTx(env, cfg, { quoteResponse: q, user: USER, mints: { [MINT]: TOKEN_2022_PROGRAM_ID.toBase58(), [USDC_MINT]: TOKEN_PROGRAM_ID.toBase58() }, maxWrap: 0n, blockhash: { blockhash: addr(), lastValidBlockHeight: 100 } });
  assert.deepEqual(body.prioritizationFeeLamports, { priorityLevelWithMaxLamports: { maxLamports: 3_000_000, priorityLevel: "veryHigh" } });
  assert.equal(body.dynamicComputeUnitLimit, true);
});

/* ---------- settings ---------- */

test("settings: the new vars have their defaults, a refund day is 50,000 transactions, and a bad value falls back to the default", () => {
  const c = config({});
  assert.deepEqual([c.refundTxPerDay, c.refundMinUsd, c.refundMinTokens, c.feePriority, c.feePriorityMax, c.creator], [50_000, 0.01, 100_000n, 100_000, 10_000_000, ""]);
  assert.equal(config({ FEE_TX_PER_DAY: "5" }).feeTxPerDay, undefined, "the shared brake is gone: sweeps have none");
  const o = config({ REFUND_TX_PER_DAY: "12", REFUND_MIN_USD: "0.5", FEE_PRIORITY_MAX_MICROLAMPORTS: "777", CREATOR: "abc" });
  assert.deepEqual([o.refundTxPerDay, o.refundMinUsd, o.feePriorityMax, o.creator], [12, 0.5, 777, "abc"]);
  assert.deepEqual([config({ REFUND_TX_PER_DAY: "-1", REFUND_MIN_USD: "x" }).refundTxPerDay, config({ REFUND_MIN_USD: "x" }).refundMinUsd], [50_000, 0.01]);
});
