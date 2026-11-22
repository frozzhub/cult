// Jupiter: impact without the tax, reading its swap-instructions, and the inspection every swap passes before a key signs.
// jupSwapInstructions() in fakes.js has Jupiter's real answer shape; the real answers were also run through inspect() and a mainnet
// simulation ("Real Jupiter").
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createTransferInstruction, createCloseAccountInstruction, createSetAuthorityInstruction, AuthorityType, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { impactBps, inspect, instructionsOf, JUPITER_PROGRAM, swapTx } from "../src/jupiter.js";
import { jupSwapInstructions, jupQuote, SOL, addr } from "./fakes.js";

const MINT = addr(), user = Keypair.generate().publicKey.toBase58(), other = addr(), feeKey = addr();
const mints = { [MINT]: TOKEN_2022_PROGRAM_ID.toBase58(), [SOL]: TOKEN_PROGRAM_ID.toBase58() };
const buy = (amount = 1_000_000n) => instructionsOf(jupSwapInstructions({ user, inputMint: SOL, outputMint: MINT, outputProgram: TOKEN_2022_PROGRAM_ID, amount }));
const sell = () => instructionsOf(jupSwapInstructions({ user, inputMint: MINT, inputProgram: TOKEN_2022_PROGRAM_ID, outputMint: SOL, amount: 5n }));
const ok = (ixs, o = {}) => inspect(ixs, { user, mints, maxWrap: 1_000_000n + 2_100_000n, ...o });
const ix = (programId, keys, data = []) => new TransactionInstruction({ programId: new PublicKey(programId), keys: keys.map(([p, s, w]) => ({ pubkey: new PublicKey(p), isSigner: !!s, isWritable: !!w })), data: Buffer.from(data) });

test("impactBps takes the coin's own tax out of Jupiter's figure", () => {
  assert.equal(impactBps({ priceImpactPct: "0.1044472262835" }, 1000), 49, "100,000 tokens on the real curve: 10.44% counts the tax, 0.49% is the impact");
  assert.equal(impactBps({ priceImpactPct: "0.0000981748894" }, 0), 1, "no tax coin: as it is");
  assert.equal(impactBps({ priceImpactPct: "0.09" }, 1000), 0, "never below zero");
  assert.equal(impactBps({ priceImpactPct: "banana" }, 1000), Infinity, "unknown means refuse");
  assert.equal(impactBps({}, 1000), Infinity);
});

test("the shapes of a normal buy and a normal sell pass", () => {
  assert.equal(ok(buy()), null);
  assert.equal(inspect(sell(), { user, mints, maxWrap: 0n }), null, "a sell wraps nothing");
});

test("instructionsOf refuses anything beyond compute budget, setup, the swap and one cleanup", () => {
  const good = jupSwapInstructions({ user, inputMint: SOL, outputMint: MINT, outputProgram: TOKEN_2022_PROGRAM_ID, amount: 1n });
  assert.throws(() => instructionsOf({ ...good, tokenLedgerInstruction: good.swapInstruction }), /don't accept/);
  assert.throws(() => instructionsOf({ ...good, otherInstructions: [good.swapInstruction] }), /don't accept/);
  assert.throws(() => instructionsOf({ ...good, swapInstruction: null }), /no swap instruction/);
});

test("hostile answers are refused, each for its own reason (the reason is pinned, so one guard can't hide behind another)", () => {
  const withExtra = (extra, base = buy()) => [...base.slice(0, -1), extra, base.at(-1)];
  const U = new PublicKey(user), O = new PublicKey(other);
  const wsol = getAssociatedTokenAddressSync(new PublicKey(SOL), U, true, TOKEN_PROGRAM_ID);
  const ataMint = getAssociatedTokenAddressSync(new PublicKey(MINT), U, true, TOKEN_2022_PROGRAM_ID);
  const ATA = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), SYS = "11111111111111111111111111111111", TOK = TOKEN_PROGRAM_ID.toBase58(), T22 = TOKEN_2022_PROGRAM_ID.toBase58();
  const transferData = SystemProgram.transfer({ fromPubkey: U, toPubkey: wsol, lamports: 1n }).data;
  const ataIx = (keys) => ix(ATA, keys, [1]); // [funder, account, owner, mint, system, token program]
  const good = [[user, false, true], [ataMint.toBase58(), false, true], [user], [MINT], [SYS], [T22]];
  const alter = (i, v) => good.map((k, j) => (j === i ? [v] : k));
  const cases = {
    "a System transfer to someone else": [SystemProgram.transfer({ fromPubkey: U, toPubkey: O, lamports: 1n }), "system transfer"],
    "a System transfer larger than the wrap": [SystemProgram.transfer({ fromPubkey: U, toPubkey: wsol, lamports: 99_000_000_000n }), "system transfer"],
    "a System transfer from an account that is not the user (no signature needed to name it)": [ix(SYS, [[other, false, true], [wsol.toBase58(), false, true]], transferData), "system transfer"],
    "a System instruction of another kind with the same length": [ix(SYS, [[user, true, true], [wsol.toBase58(), false, true]], Buffer.concat([Buffer.from([3, 0, 0, 0]), transferData.subarray(4)])), "system transfer"],
    "a System transfer with trailing bytes": [ix(SYS, [[user, true, true], [wsol.toBase58(), false, true]], Buffer.concat([transferData, Buffer.from([0])])), "system transfer"],
    "a System account create (it also needs another signer)": [SystemProgram.createAccount({ fromPubkey: U, newAccountPubkey: O, lamports: 1, space: 1, programId: SystemProgram.programId }), "another signer"],
    "a token transfer out of the user's account": [createTransferInstruction(wsol, O, U, 1n), "token instruction"],
    "a token authority change": [createSetAuthorityInstruction(wsol, U, AuthorityType.AccountOwner, O), "token instruction"],
    "closing the wrapped SOL account to someone else": [createCloseAccountInstruction(wsol, O, U), "token instruction"],
    "closing an account that is not the wrapped SOL account": [ix(TOK, [[other], [user], [user, true]], [9]), "token instruction"],
    "closing with an authority that is not the user": [ix(TOK, [[wsol.toBase58()], [user], [other]], [9]), "token instruction"],
    "syncing an account that is not the wrapped SOL account": [ix(TOK, [[other, false, true]], [17]), "token instruction"],
    "an unknown program": [ix(other, [[user, true]], [1, 2, 3]), "unexpected program"],
    "another signer (the instruction replaces the swap so nothing else could refuse it)": [null, "another signer"],
    "an unknown compute budget instruction": [ix("ComputeBudget111111111111111111111111111111", [], [1, 0, 0, 0, 0]), "compute budget"],
    "an account create for someone else's account": [createAssociatedTokenAccountIdempotentInstruction(U, getAssociatedTokenAddressSync(new PublicKey(MINT), O, true, TOKEN_2022_PROGRAM_ID), O, new PublicKey(MINT), TOKEN_2022_PROGRAM_ID), "account create"],
    "an account create whose address is the user's real account but names another mint": [ataIx(alter(3, other)), "account create for another mint or owner"],
    "an account create paid by someone else": [ataIx(alter(0, other)), "account create"],
    "an account create with another System program": [ataIx(alter(4, other)), "account create"],
    "an account create with an unknown token program": [ataIx(alter(5, other)), "account create"],
    "an account create with seven accounts": [ataIx([...good, [other]]), "account create"],
    "an account create with data that is not create or create-idempotent": [ix(ATA, good, [2]), "account create"],
    "an account create with extra data": [ix(ATA, good, [1, 0]), "account create"],
  };
  for (const [name, [bad, reason]] of Object.entries(cases)) {
    const ixs = bad === null ? buy().map((i) => (i.programId.toBase58() === JUPITER_PROGRAM ? ix(JUPITER_PROGRAM, [[user, true], [other, true]], [1]) : i)) : withExtra(bad);
    assert.equal(ok(ixs), reason, name);
  }
  assert.equal(ok(withExtra(ataIx(good))), null, "and the user's own account create is fine");
  assert.equal(ok(buy(), { maxWrap: 10n }), "system transfer", "wrapping more than the sale needs");
  assert.equal(ok(buy().filter((i) => i.programId.toBase58() !== JUPITER_PROGRAM)), "no swap", "no swap instruction at all");
  assert.equal(ok([...buy(), ...buy().filter((i) => i.programId.toBase58() === JUPITER_PROGRAM)]), "no swap", "two of them");
});

test("a key we keep out of swaps (the fee key, when it only co-signs a refund) may not appear anywhere in Jupiter's instructions", () => {
  const dirty = buy().map((i) => (i.programId.toBase58() === JUPITER_PROGRAM ? ix(JUPITER_PROGRAM, [[user, true], [feeKey, false, true]], [9]) : i));
  assert.equal(ok(dirty, { forbid: [feeKey] }), "it mentions a key we keep out of swaps");
  assert.equal(ok(dirty), null, "without the rule the same instructions are fine");
});

test("a priority fee over the cap (3,000,000 lamports) is refused, one under it is fine", () => {
  const cb = (limit, price) => [
    new TransactionInstruction({ programId: new PublicKey("ComputeBudget111111111111111111111111111111"), keys: [], data: Buffer.from([2, ...new Uint8Array(new Uint32Array([limit]).buffer)]) }),
    new TransactionInstruction({ programId: new PublicKey("ComputeBudget111111111111111111111111111111"), keys: [], data: Buffer.from([3, ...new Uint8Array(new BigUint64Array([BigInt(price)]).buffer)]) }),
  ];
  const rest = buy().filter((i) => i.programId.toBase58() !== "ComputeBudget111111111111111111111111111111");
  assert.equal(ok([...cb(1_000_000, 3_500_000), ...rest]), "priority fee", "1,000,000 units at 3,500,000 micro-lamports = 3,500,000 lamports");
  assert.equal(ok([...cb(1_000_000, 3_000_000), ...rest]), null, "exactly the cap is allowed");
  assert.equal(ok([...cb(200_000, 100_000), ...rest]), null);
  assert.equal(ok([cb(0, 0)[1], ...rest].slice(0, 1).concat(rest)), null, "a price with no limit uses the 1,400,000-unit maximum: 0 price is free");
  assert.equal(ok([cb(0, 3_000_000)[1], ...rest]), "priority fee", "a price with no limit set counts at the 1,400,000-unit maximum: 4,200,000 lamports");
});

test("swapTx compiles what Jupiter returned, inspected, with the refund appended and the fee key as its only extra signer", async () => {
  const realFetch = globalThis.fetch;
  const answers = jupSwapInstructions({ user, inputMint: SOL, outputMint: MINT, outputProgram: TOKEN_2022_PROGRAM_ID, amount: 1_000_000n });
  globalThis.fetch = async (u, init) => {
    if (String(u).includes("/swap-instructions")) { assert.equal(JSON.parse(init.body).userPublicKey, user); return Response.json(answers); }
    if (String(u).includes("test.rpc")) { const { method } = JSON.parse(init.body); return Response.json({ jsonrpc: "2.0", id: 1, result: method === "getLatestBlockhash" ? { value: { blockhash: addr(), lastValidBlockHeight: 900 } } : null }); }
    throw new Error("unmocked " + u);
  };
  try {
    const env = { SOLANA_RPC_URL: "https://test.rpc" }, cfg = { jup: "https://jup.test" };
    const q = jupQuote({ inputMint: SOL, outputMint: MINT, amount: 1_000_000n, out: 5_000_000n });
    const r = await swapTx(env, cfg, { quoteResponse: q, user, mints, maxWrap: 3_100_000n });
    assert.equal(r.lvbh, 900);
    assert.equal(r.tx.message.header.numRequiredSignatures, 1, "the user is the only signer of a plain swap");
    const refund = new TransactionInstruction({ programId: TOKEN_2022_PROGRAM_ID, keys: [{ pubkey: new PublicKey(feeKey), isSigner: true, isWritable: false }], data: Buffer.from([26, 3, 1]) });
    const a = await swapTx(env, cfg, { quoteResponse: q, user, mints, maxWrap: 3_100_000n, forbid: [feeKey], extra: [refund] });
    assert.equal(a.tx.message.header.numRequiredSignatures, 2);
    assert.deepEqual(a.tx.message.staticAccountKeys.slice(0, 2).map((k) => k.toBase58()), [user, feeKey]);
    await assert.rejects(swapTx(env, cfg, { quoteResponse: q, user, mints, maxWrap: 10n }), /refused \(system transfer\)/);
  } finally { globalThis.fetch = realFetch; }
});
