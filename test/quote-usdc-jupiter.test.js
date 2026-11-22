// The site's Buy and Sell stay SOL <-> CULT through Jupiter (src/trade.js), and the round's swaps are CULT -> USDC. With a USDC curve
// Jupiter routes a SOL buy through USDC (SOL -> USDC -> CULT) and may hop a sale the same way, so the user's own USDC account shows up in
// the setup instructions and a middle token account in the simulation. Both checks must accept that route and still refuse a hostile
// version of it (src/jupiter.js inspect and outcomeProblem; the one-hop cases are in jupiter.test.js and review2-jupiter.test.js).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { inspect, instructionsOf, outcomeProblem } from "../src/jupiter.js";
import { USDC_MINT } from "../src/config.js";
import { jupSwapInstructions, tokenAccount, addr, b64, SOL } from "./fakes.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const T1 = TOKEN_PROGRAM_ID, T22 = TOKEN_2022_PROGRAM_ID;
const MINT = addr(), user = Keypair.generate().publicKey.toBase58(), other = addr();
const mints = { [MINT]: T22.toBase58(), [SOL]: T1.toBase58() };
const U = new PublicKey(user), O = new PublicKey(other), USDC = new PublicKey(USDC_MINT);
const usdcAtaOf = (owner) => getAssociatedTokenAddressSync(USDC, new PublicKey(owner), true, T1);
const json = (ix) => ({ programId: ix.programId.toBase58(), accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data).toString("base64") });

// Jupiter's answer for SOL -> USDC -> CULT: the one-hop buy (wrap SOL, open the coin's account, swap, close the wrapped SOL) plus the
// hop's own token account in the setup: an idempotent create of the user's USDC account, paid by the user.
const viaUsdc = (hop = createAssociatedTokenAccountIdempotentInstruction(U, usdcAtaOf(user), U, USDC, T1)) => {
  const a = jupSwapInstructions({ user, inputMint: SOL, outputMint: MINT, outputProgram: T22, amount: 1_000_000n });
  a.setupInstructions.push(json(hop));
  return instructionsOf(a);
};
const ok = (ixs) => inspect(ixs, { user, mints, maxWrap: 1_000_000n + 2_100_000n });

test("inspect: a buy routed SOL -> USDC -> CULT passes, with the user's own USDC account opened for the hop", () => {
  assert.equal(ok(viaUsdc()), null);
});

test("inspect: the hop's account has to be the user's own, paid for by the user; nothing else rides along with it", () => {
  const ata = (funder, address, owner) => new TransactionInstruction({ programId: ASSOCIATED_TOKEN_PROGRAM_ID, data: Buffer.from([1]), keys: [funder, address, owner, USDC, new PublicKey("11111111111111111111111111111111"), T1].map((p, i) => ({ pubkey: p, isSigner: i === 0, isWritable: i < 2 })) });
  assert.equal(ok(viaUsdc(createAssociatedTokenAccountIdempotentInstruction(U, usdcAtaOf(other), O, USDC, T1))), "account create", "a USDC account for someone else");
  assert.equal(ok(viaUsdc(createAssociatedTokenAccountIdempotentInstruction(O, usdcAtaOf(user), U, USDC, T1))), "another signer", "opened by someone else's money (they would have to sign)");
  assert.equal(ok(viaUsdc(ata(U, new PublicKey(addr()), U))), "account create for another mint or owner", "an address that is not the user's USDC account");
  assert.equal(ok(viaUsdc(createTransferInstruction(usdcAtaOf(user), usdcAtaOf(other), U, 1n))), "token instruction", "USDC moved out of the user's account");
  assert.equal(ok(viaUsdc(SystemProgram.transfer({ fromPubkey: U, toPubkey: usdcAtaOf(user), lamports: 1n }))), "system transfer", "SOL sent into the hop account");
});

test("outcomeProblem: a treasury sale that hops through another token passes on its net effect (the hop's account isn't watched), and fails when the USDC doesn't rise by the quote", async () => {
  const payout = Keypair.generate(), USER = payout.publicKey.toBase58(), u = payout.publicKey;
  const outA = usdcAtaOf(USER).toBase58(), inA = getAssociatedTokenAddressSync(new PublicKey(MINT), u, true, T22).toBase58();
  const amount = 1_000n * 1_000_000n, minOut = 49_000_000n;
  const wallet = (lamports) => ({ lamports, bytes: new Uint8Array(0) });
  const before = { [USER]: wallet(2_000_000_000), [outA]: { lamports: 2_039_280, bytes: tokenAccount({ mint: USDC_MINT, owner: USER, amount: 7_000_000n, ext: false }) }, [inA]: { lamports: 2_100_000, bytes: tokenAccount({ mint: MINT, owner: USER, amount }) } };
  const landed = (usdc) => ({ [USER]: wallet(2_000_000_000 - 20_000), [outA]: { lamports: 2_039_280, bytes: tokenAccount({ mint: USDC_MINT, owner: USER, amount: usdc, ext: false }) }, [inA]: { lamports: 2_100_000, bytes: tokenAccount({ mint: MINT, owner: USER, amount: 0n }) } });
  const asked = [];
  const run = async (usdcAfter) => {
    const after = landed(usdcAfter);
    const acct = (s) => (s ? { lamports: s.lamports, data: [b64(s.bytes), "base64"], owner: T1.toBase58() } : null);
    globalThis.fetch = async (_url, init) => {
      const { method, params } = JSON.parse(init.body);
      if (method === "simulateTransaction") asked.push(params[1].accounts.addresses);
      const result = method === "getMultipleAccounts" ? { value: params[0].map((a) => acct(before[a])) }
        : method === "getBalance" ? { value: before[USER].lamports }
        : method === "simulateTransaction" ? { value: { err: null, logs: [], unitsConsumed: 1, accounts: params[1].accounts.addresses.map((a) => acct(after[a])) } }
        : null;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    };
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: u, recentBlockhash: addr(), instructions: [SystemProgram.transfer({ fromPubkey: u, toPubkey: u, lamports: 1 })] }).compileToV0Message());
    return outcomeProblem({ SOLANA_RPC_URL: "https://rpc.test" }, tx, { user: USER, inputMint: MINT, inputProgram: T22.toBase58(), outputMint: USDC_MINT, outputProgram: T1.toBase58(), amount: String(amount), minOut: String(minOut) });
  };
  assert.equal(await run(7_000_000n + minOut), null, "the wallet's USDC rose by the quote's minimum and its CULT fell by what was sold");
  assert.deepEqual(asked[0].sort(), [USER, outA, inA].sort(), "three accounts are watched; the route's middle account is not one of them");
  assert.equal(await run(7_000_000n + minOut - 1n), "the swap would pay out less than its quote");
});
