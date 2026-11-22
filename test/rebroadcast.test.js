// sendTx re-sends the same transaction until it is seen, only when REBROADCAST_MS is set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, TransactionMessage, VersionedTransaction, SystemProgram } from "@solana/web3.js";
import { sendTx } from "../src/chain.js";

const kp = Keypair.generate();
const tx = new VersionedTransaction(new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: "11111111111111111111111111111111",
  instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 })] }).compileToV0Message());
tx.sign([kp]);

async function run(env, seenAfter) {
  const real = globalThis.fetch, realT = globalThis.setTimeout; let sends = 0, polls = 0;
  globalThis.setTimeout = (f) => realT(f, 0);
  globalThis.fetch = async (_u, init) => {
    const { method } = JSON.parse(init.body);
    const result = method === "sendTransaction" ? (sends++, "sig") : { value: [++polls >= seenAfter ? { confirmationStatus: "confirmed" } : null] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
  };
  try { await sendTx({ SOLANA_RPC_URL: "http://rpc.test", ...env }, tx); } finally { globalThis.fetch = real; globalThis.setTimeout = realT; }
  return sends;
}

test("without REBROADCAST_MS a transaction is sent once", async () => assert.equal(await run({}, 1), 1));
test("with REBROADCAST_MS it is re-sent until it is seen in a block, then no more", async () => assert.equal(await run({ REBROADCAST_MS: "60000" }, 3), 3));
