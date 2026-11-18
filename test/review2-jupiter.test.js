// Second money review (curve design), the Jupiter leg: docs/reviews/2026-11-16-money-2-curve.md.
// Each test here FAILS on the code as reviewed and should pass once its finding is fixed.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { swapTx, outcomeProblem } from "../src/jupiter.js";
import { config, USDC_MINT } from "../src/config.js";
import { jupQuote, jupSwapInstructions, tokenAccount, addr, b64 } from "./fakes.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const MINT = addr(), payout = Keypair.generate(), USER = payout.publicKey.toBase58();
const env = { SOLANA_RPC_URL: "https://rpc.test", JUP_API_KEY: "k" };
const cfg = config({ MINT, PAYOUT_WALLET: USER, JUP_API: "https://jup.test", DRY_RUN: "0" });
const T22 = TOKEN_2022_PROGRAM_ID.toBase58(), T1 = TOKEN_PROGRAM_ID.toBase58();
const cu = (limit, price) => [
  { programId: "ComputeBudget111111111111111111111111111111", accounts: [], data: Buffer.from([2, ...new Uint8Array(new Uint32Array([limit]).buffer)]).toString("base64") },
  { programId: "ComputeBudget111111111111111111111111111111", accounts: [], data: Buffer.from([3, ...new Uint8Array(new BigUint64Array([BigInt(price)]).buffer)]).toString("base64") },
];

/* ---------- N5: the priority fee is left to Jupiter's "auto", above the cap inspect enforces ---------- */

test("N5: the swap asks Jupiter for an uncapped 'auto' priority fee; in congestion Jupiter's answer is over our 3,000,000-lamport cap and the round's swap is refused every tick", async () => {
  let body = null;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /swap-instructions$/);
    body = JSON.parse(init.body);
    // Jupiter's side, modelled: "auto" sets the fee from recent fees on the accounts the swap writes (a launch-day pool is hot),
    // up to Jupiter's own ceiling (0.005 SOL per its docs, from memory: verify). A request that names a maximum gets at most that.
    const p = body.prioritizationFeeLamports;
    const want = 4_000_000; // what a hot pool costs: 400,000 CU at 10 lamports per CU
    const lamports = typeof p === "object" && p?.priorityLevelWithMaxLamports ? Math.min(want, Number(p.priorityLevelWithMaxLamports.maxLamports)) : typeof p === "number" ? Math.min(want, p) : want;
    const answer = jupSwapInstructions({ user: USER, inputMint: MINT, inputProgram: TOKEN_2022_PROGRAM_ID, outputMint: USDC_MINT, amount: 1_000_000n });
    answer.computeBudgetInstructions = cu(400_000, Math.floor((lamports * 1_000_000) / 400_000));
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  const q = jupQuote({ inputMint: MINT, outputMint: USDC_MINT, amount: 1_000_000n, out: 50_000_000n });
  let err = null;
  try {
    await swapTx(env, cfg, { quoteResponse: q, user: USER, mints: { [MINT]: T22, [USDC_MINT]: T1 }, maxWrap: 0n, blockhash: { blockhash: addr(), lastValidBlockHeight: 100 } });
  } catch (e) { err = e; }
  assert.equal(err, null, `the treasury's CULT sale was refused: ${err?.message} (request sent prioritizationFeeLamports=${JSON.stringify(body?.prioritizationFeeLamports)})`);
});

/* ---------- N6: the treasury swap's simulation watches three accounts, not the wallet ---------- */

test("N6: the CULT leg's simulate-and-compare accepts a swap that also takes 1 SOL from the payout wallet (lamports are only checked when SOL is sold)", async () => {
  const u = payout.publicKey;
  const outA = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), u, true, TOKEN_PROGRAM_ID).toBase58();
  const inA = getAssociatedTokenAddressSync(new PublicKey(MINT), u, true, TOKEN_2022_PROGRAM_ID).toBase58();
  const amount = 1_000n * 1_000_000n, minOut = 49_000_000n;
  const before = { [USER]: { lamports: 2_000_000_000, bytes: new Uint8Array(0) }, [outA]: { lamports: 2_039_280, bytes: tokenAccount({ mint: USDC_MINT, owner: USER, amount: 0n, ext: false }) }, [inA]: { lamports: 2_100_000, bytes: tokenAccount({ mint: MINT, owner: USER, amount }) } };
  const after = { [USER]: { lamports: 1_000_000_000, bytes: new Uint8Array(0) }, [outA]: { lamports: 2_039_280, bytes: tokenAccount({ mint: USDC_MINT, owner: USER, amount: minOut, ext: false }) }, [inA]: { lamports: 2_100_000, bytes: tokenAccount({ mint: MINT, owner: USER, amount: 0n }) } };
  const acct = (s) => (s ? { lamports: s.lamports, data: [b64(s.bytes), "base64"], owner: T1 } : null);
  globalThis.fetch = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    const result = method === "getMultipleAccounts" ? { value: params[0].map((a) => acct(before[a])) }
      : method === "getBalance" ? { value: before[USER].lamports }
      : method === "simulateTransaction" ? { value: { err: null, logs: [], unitsConsumed: 1, accounts: params[1].accounts.addresses.map((a) => acct(after[a])) } }
      : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: u, recentBlockhash: addr(), instructions: [SystemProgram.transfer({ fromPubkey: u, toPubkey: u, lamports: 1 })] }).compileToV0Message());
  const why = await outcomeProblem(env, tx, { user: USER, inputMint: MINT, inputProgram: T22, outputMint: USDC_MINT, outputProgram: T1, amount: String(amount), minOut: String(minOut) });
  assert.notEqual(why, null, "a CULT -> USDC sale that costs the hot wallet 1 SOL on top passed the outcome check");
});
