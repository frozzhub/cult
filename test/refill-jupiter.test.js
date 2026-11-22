// The SOL refill's Jupiter checks (src/jupiter.js): a USDC -> native SOL swap of the payout wallet. Jupiter wraps nothing for it and
// closes its wrapped-SOL account to the wallet, so inspect() must accept exactly that shape and refuse anything that adds a signer, moves
// a token or changes an owner, and outcomeProblem() reads the gain from the wallet's lamports (less the fee and rent slack), takes no more
// USDC than was sold and, with `keep`, lets no other token account (the CULT treasury) fall. The engine side is in refill.test.js.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createTransferInstruction, createCloseAccountInstruction, createSetAuthorityInstruction, AuthorityType,
  createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { inspect, instructionsOf, outcomeProblem } from "../src/jupiter.js";
import { treasuryAta } from "../src/token22.js";
import { USDC_MINT } from "../src/config.js";
import { jupSwapInstructions, tokenAccount, addr, b64, SOL } from "./fakes.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const T1 = TOKEN_PROGRAM_ID, T22 = TOKEN_2022_PROGRAM_ID;
const payout = Keypair.generate(), USER = payout.publicKey.toBase58(), U = payout.publicKey;
const other = addr(), O = new PublicKey(other), USDC = new PublicKey(USDC_MINT), MINT = addr();
const usdcA = getAssociatedTokenAddressSync(USDC, U, true, T1), wsol = getAssociatedTokenAddressSync(new PublicKey(SOL), U, true, T1);
const json = (ix) => ({ programId: ix.programId.toBase58(), accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data).toString("base64") });

/* ---------- inspect: the shape of a USDC -> SOL swap ---------- */

const mints = { [USDC_MINT]: T1.toBase58(), [SOL]: T1.toBase58() };
const check = (mutate) => {
  const a = jupSwapInstructions({ user: USER, inputMint: USDC_MINT, outputMint: SOL, amount: 50_000_000n });
  mutate?.(a);
  return inspect(instructionsOf(a), { user: USER, mints, maxWrap: 0n }); // the refill sells USDC: nothing may be wrapped
};

test("inspect: Jupiter's USDC -> SOL answer (open the wrapped-SOL account, swap, close it to the wallet) passes with nothing allowed to wrap", () => {
  assert.equal(check(), null);
});

test("inspect: a USDC -> SOL answer that adds a signer, a transfer, a wrap, an owner change or another wallet's account is refused, each for its own reason", () => {
  const cases = {
    "a second signer on the swap": [(a) => a.swapInstruction.accounts.push({ pubkey: other, isSigner: true, isWritable: false }), "another signer"],
    "a System transfer out of the wallet": [(a) => a.setupInstructions.push(json(SystemProgram.transfer({ fromPubkey: U, toPubkey: O, lamports: 1n }))), "system transfer"],
    "a wrap of even one lamport (a USDC sale wraps none)": [(a) => a.setupInstructions.push(json(SystemProgram.transfer({ fromPubkey: U, toPubkey: wsol, lamports: 1n }))), "system transfer"],
    "a USDC transfer out of the wallet's account": [(a) => a.setupInstructions.push(json(createTransferInstruction(usdcA, getAssociatedTokenAddressSync(USDC, O, true, T1), U, 1n))), "token instruction"],
    "an owner change on the USDC account": [(a) => a.setupInstructions.push(json(createSetAuthorityInstruction(usdcA, U, AuthorityType.AccountOwner, O))), "token instruction"],
    "closing the wrapped-SOL account to someone else": [(a) => { a.cleanupInstruction = json(createCloseAccountInstruction(wsol, O, U)); }, "token instruction"],
    "an account create for another wallet": [(a) => a.setupInstructions.push(json(createAssociatedTokenAccountIdempotentInstruction(U, getAssociatedTokenAddressSync(USDC, O, true, T1), O, USDC, T1))), "account create"],
    "a program nobody expected": [(a) => a.setupInstructions.push({ programId: addr(), accounts: [], data: "" }), "unexpected program"],
  };
  for (const [name, [mutate, reason]] of Object.entries(cases)) assert.equal(check(mutate), reason, name);
});

/* ---------- outcomeProblem: native SOL out ---------- */

const AMOUNT = 50_000_000n, MIN_OUT = 247_500_000n; // $50 of USDC; the quote's minimum in lamports
const TREAS = treasuryAta(MINT, USER).toBase58();
const wallet = (lamports) => ({ lamports, bytes: new Uint8Array(0) });
const usdcAcct = (n) => ({ lamports: 2_039_280, bytes: tokenAccount({ mint: USDC_MINT, owner: USER, amount: n, ext: false }) });
const cultAcct = (n) => ({ lamports: 2_100_000, bytes: tokenAccount({ mint: MINT, owner: USER, amount: n }) });
const BEFORE = { [USER]: wallet(100_000_000), [usdcA.toBase58()]: usdcAcct(80_000_000n), [TREAS]: cultAcct(1_000_000_000n) };
const landed = (o = {}) => ({ [USER]: wallet(100_000_000 - 10_000 + 250_000_000), [usdcA.toBase58()]: usdcAcct(30_000_000n), [TREAS]: cultAcct(1_000_000_000n), ...o });

async function run(after, { keep = [TREAS], err = null } = {}) {
  const acct = (s) => (s ? { lamports: s.lamports, data: [b64(s.bytes), "base64"], owner: T1.toBase58() } : null);
  globalThis.fetch = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    const result = method === "getMultipleAccounts" ? { value: params[0].map((a) => acct(BEFORE[a])) }
      : method === "getBalance" ? { value: BEFORE[USER].lamports }
      : method === "simulateTransaction" ? { value: { err, logs: [], unitsConsumed: 1, accounts: params[1].accounts.addresses.map((a) => acct(after[a])) } }
      : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: U, recentBlockhash: addr(), instructions: [SystemProgram.transfer({ fromPubkey: U, toPubkey: U, lamports: 1 })] }).compileToV0Message());
  return outcomeProblem({ SOLANA_RPC_URL: "https://rpc.test" }, tx, { user: USER, inputMint: USDC_MINT, inputProgram: T1.toBase58(), outputMint: SOL, outputProgram: T1.toBase58(), amount: String(AMOUNT), minOut: String(MIN_OUT), keep });
}

test("outcomeProblem, USDC -> SOL: passes when the wallet's lamports rise by the quote's minimum less the fee slack and the USDC falls by no more than was sold", async () => {
  assert.equal(await run(landed()), null);
  assert.equal(await run(landed({ [USER]: wallet(100_000_000 + Number(MIN_OUT) - 6_000_000) })), null, "exactly the minimum less the 6,000,000 lamport slack");
});

test("outcomeProblem, USDC -> SOL: a swap that pays less SOL than the quote's minimum (beyond the slack), or none, is refused", async () => {
  const less = "the swap would pay out less than its quote";
  assert.equal(await run(landed({ [USER]: wallet(100_000_000 + Number(MIN_OUT) - 6_000_001) })), less, "one lamport under");
  assert.equal(await run(landed({ [USER]: wallet(100_000_000 - 10_000) })), less, "no SOL arrives at all: the USDC just leaves");
  assert.equal(await run(landed({ [USER]: wallet(1_000_000) })), less, "the wallet ends with less SOL than it started with");
});

test("outcomeProblem, USDC -> SOL: a swap that takes more USDC than was sold is refused, exactly the amount is not", async () => {
  assert.equal(await run(landed({ [usdcA.toBase58()]: usdcAcct(80_000_000n - AMOUNT) })), null);
  assert.equal(await run(landed({ [usdcA.toBase58()]: usdcAcct(80_000_000n - AMOUNT - 1n) })), "the swap would take more than it should");
  assert.equal(await run(landed({ [usdcA.toBase58()]: null })), "the swap would take more than it should", "the whole account emptied and closed");
});

test("outcomeProblem, USDC -> SOL: a swap that moves another token (the CULT treasury) is refused, and only because that account is named in `keep`", async () => {
  assert.equal(await run(landed({ [TREAS]: cultAcct(1_000_000_000n - 1n) })), "the swap would take another token");
  assert.equal(await run(landed({ [TREAS]: null })), "the swap would take another token", "closed");
  assert.equal(await run(landed({ [TREAS]: cultAcct(1_000_000_001n) })), null, "more is not less");
  assert.equal(await run(landed({ [TREAS]: cultAcct(0n) }), { keep: [] }), null, "an account nobody named is not watched: the caller must name what it keeps");
});

test("outcomeProblem, USDC -> SOL: a swap that fails in simulation is refused", async () => {
  assert.equal(await run(landed(), { err: { InstructionError: [2, "Custom"] } }), "the swap fails in simulation");
});
