// Jupiter: quotes, swap transactions for the site and for the treasury, and the inspection every one of them passes
// before a key signs it (review item A3). We never sign a transaction Jupiter hands back: we ask for its
// instructions, read every one of them, and compile the transaction ourselves.
//   - static rules: only expected programs; the user is the only signer; System/Token/ATA instructions only in the
//     shapes a swap needs (wrap, sync, close, open the user's own token accounts); no instruction mentions a key we
//     must keep out (the fee key, when it only co-signs a refund);
//   - for the treasury, the simulated outcome too: the output account gains at least the quote's minimum and the
//     input account loses at most what was sold, so a swapped-out destination account is caught.
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, AddressLookupTableAccount } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SOL_MINT } from "./config.js";
import * as chain from "./chain.js";
import { parseTokenAccount } from "./token22.js";

export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const COMPUTE = "ComputeBudget111111111111111111111111111111", SYSTEM = "11111111111111111111111111111111";
const TOKEN = TOKEN_PROGRAM_ID.toBase58(), TOKEN22 = TOKEN_2022_PROGRAM_ID.toBase58(), ATA = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
const MAX_TX = 1232;
const MAX_PRIORITY_LAMPORTS = 3_000_000; // compute-unit limit x price: no swap may pay more than this to be included (it is also what we ask Jupiter for)

const jfetch = async (env, url, init = {}) => {
  const res = await fetch(url, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...chain.jupHeaders(env) }, signal: AbortSignal.timeout(12_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Jupiter ${res.status}: ${String(body.error || body.message || "").slice(0, 120)}`), { status: res.status });
  return body;
};

export async function quote(env, cfg, { inputMint, outputMint, amount, slippageBps }) {
  const q = await jfetch(env, `${cfg.jup}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`);
  if (!q.routePlan?.length || q.outAmount == null) throw new Error("Jupiter has no route for that.");
  return q;
}

// Price impact in bps WITHOUT the transfer tax. Jupiter's figure counts the tax as impact: a 100-token sell shows
// about 10.5% on a 10% tax coin. impact = 1 - (1 - jupiter) / (1 - tax).
export function impactBps(q, taxBps = 0) {
  const j = Number(q.priceImpactPct);
  if (!Number.isFinite(j)) return Infinity;
  const net = 1 - (1 - j) / (1 - taxBps / 10_000);
  return Math.max(0, Math.round(net * 10_000));
}

/* ---------- reading Jupiter's instructions ---------- */

const ixFrom = (j) => new TransactionInstruction({
  programId: new PublicKey(j.programId),
  keys: (j.accounts || []).map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: !!a.isSigner, isWritable: !!a.isWritable })),
  data: Buffer.from(j.data || "", "base64"),
});

// Jupiter's swap-instructions answer -> ordered TransactionInstruction list, or throws on anything we don't expect
// (an "other" instruction, a token ledger) before it is looked at further.
export function instructionsOf(r) {
  if (!r.swapInstruction) throw new Error("Jupiter gave no swap instruction.");
  if (r.tokenLedgerInstruction || r.otherInstructions?.length) throw new Error("Jupiter's swap has instructions we don't accept.");
  return [...(r.computeBudgetInstructions || []), ...(r.setupInstructions || []), r.swapInstruction, ...(r.cleanupInstruction ? [r.cleanupInstruction] : [])].map(ixFrom);
}

// The static rules. ixs: TransactionInstruction[]. ctx:
//   user:    the wallet that pays and signs (the payout wallet for the treasury, the trader on the site)
//   mints:   { mint: tokenProgramId } for the two mints being swapped (WSOL's program is the classic one)
//   maxWrap: most lamports the swap may wrap (what is sold, plus a little for account rent)
//   forbid:  keys no instruction may mention (the fee key, when it only co-signs a refund)
// -> null when fine, or the reason.
export function inspect(ixs, { user, mints, maxWrap = 0n, forbid = [] }) {
  const u = new PublicKey(user);
  const wsol = getAssociatedTokenAddressSync(new PublicKey(SOL_MINT), u, true, TOKEN_PROGRAM_ID).toBase58();
  const bad = new Set(forbid);
  let jupiter = 0, priority = { limit: 1_400_000n, price: 0n };
  for (const ix of ixs) {
    const prog = ix.programId.toBase58(), k = ix.keys.map((x) => x.pubkey.toBase58()), d = ix.data;
    for (const x of ix.keys) {
      if (bad.has(x.pubkey.toBase58())) return "it mentions a key we keep out of swaps";
      if (x.isSigner && x.pubkey.toBase58() !== user) return "another signer";
    }
    if (prog === COMPUTE) {
      if (d[0] === 2) priority.limit = BigInt(d.readUInt32LE(1));
      else if (d[0] === 3) priority.price = d.readBigUInt64LE(1);
      else if (d[0] !== 4) return "compute budget";
    } else if (prog === ATA) {
      // create (empty data or 0) or create idempotent (1): [funder, ata, owner, mint, system, token program]
      if (d.length > 1 || (d[0] ?? 0) > 1 || k.length !== 6) return "account create";
      const prgm = new PublicKey(k[5]);
      if (k[0] !== user || k[2] !== user || k[4] !== SYSTEM || !(k[5] === TOKEN || k[5] === TOKEN22)) return "account create";
      // Any mint is fine as long as it is the user’s own account, paid for by the user: Jupiter routes through other tokens
      // at times (staging, 17 Nov: a round was refused for one tick over such a hop). The cost is that account’s rent, once.
      if (k[1] !== getAssociatedTokenAddressSync(new PublicKey(k[3]), u, true, prgm).toBase58()) return "account create for another mint or owner";
    } else if (prog === SYSTEM) {
      // wrapping: lamports from the user into the user's own wrapped-SOL account, nothing else
      if (d.length !== 12 || d.readUInt32LE(0) !== 2 || k[0] !== user || k[1] !== wsol || d.readBigUInt64LE(4) > maxWrap) return "system transfer";
    } else if (prog === TOKEN) {
      if (d.length === 1 && d[0] === 17 && k[0] === wsol) continue;                       // sync native
      if (d.length === 1 && d[0] === 9 && k[0] === wsol && k[1] === user && k[2] === user) continue; // close the wrapped-SOL account to the user
      return "token instruction";
    } else if (prog === JUPITER_PROGRAM) {
      jupiter++;
    } else return "unexpected program";
  }
  if (jupiter !== 1) return "no swap";
  if ((priority.limit * priority.price) / 1_000_000n > BigInt(MAX_PRIORITY_LAMPORTS)) return "priority fee";
  return null;
}

/* ---------- compile ---------- */

async function lookupTables(env, addresses) {
  const found = await chain.getAccounts(env, addresses || []);
  return [...found].map(([key, bytes]) => {
    if (!bytes) throw new Error("A Jupiter lookup table isn't on chain.");
    return new AddressLookupTableAccount({ key: new PublicKey(key), state: AddressLookupTableAccount.deserialize(bytes) });
  });
}

// Compile to a v0 transaction (nothing signed). Throws when it can't fit one transaction.
export async function compile(env, { payer, instructions, tables, blockhash }) {
  const msg = new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: blockhash, instructions }).compileToV0Message(await lookupTables(env, tables));
  const tx = new VersionedTransaction(msg);
  let size; try { size = tx.serialize().length; } catch { size = Infinity; } // web3.js throws a RangeError past 1232 bytes instead of returning them
  if (size > MAX_TX) throw new Error("The swap doesn't fit in one transaction.");
  return tx;
}

// Ask Jupiter for the instructions of a quote, inspect them, and compile a transaction for `user`.
//   extra: instructions appended after the swap (the buyer's refund); forbid: keys the swap may not mention.
// Returns the unsigned transaction and the facts needed to sign and track it.
export async function swapTx(env, cfg, { quoteResponse, user, mints, maxWrap, forbid = [], extra = [], blockhash }) {
  const r = await jfetch(env, `${cfg.jup}/swap/v1/swap-instructions`, {
    method: "POST",
    body: JSON.stringify({ quoteResponse, userPublicKey: user, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
      // "auto" can answer above the cap inspect() enforces, and every swap would then be refused just when the curve is hot.
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: MAX_PRIORITY_LAMPORTS, priorityLevel: "veryHigh" } } }),
  });
  const ixs = instructionsOf(r);
  const why = inspect(ixs, { user, mints, maxWrap, forbid });
  if (why) throw new Error(`Jupiter's swap was refused (${why}).`);
  const bh = blockhash || (await chain.latestBlockhash(env));
  const tx = await compile(env, { payer: user, instructions: [...ixs, ...extra], tables: r.addressLookupTableAddresses, blockhash: bh.blockhash });
  return { tx, lvbh: Number(bh.lastValidBlockHeight || 0), instructions: ixs };
}

/* ---------- the treasury's own swap ---------- */

// Simulate and compare balances: the output account must gain at least `minOut`, and what leaves must not exceed
// `amount`, and the wallet's SOL may drop only by fees and account rent (plus `amount` when SOL is sold). A failed simulation is a refusal.
export async function outcomeProblem(env, tx, { user, inputMint, outputMint, outputProgram, inputProgram, amount, minOut }) {
  const u = new PublicKey(user);
  const ata = (m, p) => getAssociatedTokenAddressSync(new PublicKey(m), u, true, new PublicKey(p)).toBase58();
  const outA = ata(outputMint, outputProgram), inA = inputMint === SOL_MINT ? null : ata(inputMint, inputProgram);
  const watch = [user, outA, ...(inA ? [inA] : [])];
  const before = await chain.getAccounts(env, watch), lamportsBefore = await chain.solBalance(env, user);
  const sim = await chain.simulate(env, tx, watch);
  if (sim.err) return "the swap fails in simulation";
  const tokens = (bytes) => (bytes ? parseTokenAccount(bytes)?.amount ?? 0n : 0n);
  if (tokens(sim.after.get(outA)?.data) - tokens(before.get(outA)) < BigInt(minOut)) return "the swap would pay out less than its quote";
  if (inA && tokens(before.get(inA)) - tokens(sim.after.get(inA)?.data) > BigInt(amount)) return "the swap would take more than it should";
  // Every leg: the wallet's SOL may drop by fees and account rent, plus the amount when SOL is what is sold (review N6).
  if (lamportsBefore - (sim.after.get(user)?.lamports ?? 0n) > (inA ? 0n : BigInt(amount)) + 6_000_000n) return "the swap would take more SOL than it should";
  return null;
}

// A signed swap for the payout wallet: Jupiter's quote, inspected instructions, a transaction we compiled, simulated
// against the quote, then signed. `amount` raw units of inputMint into outputMint.
export async function treasurySwap(env, cfg, kp, { inputMint, inputProgram, outputMint, outputProgram, amount, quoteResponse }) {
  const user = kp.publicKey.toBase58();
  const q = quoteResponse || (await quote(env, cfg, { inputMint, outputMint, amount, slippageBps: cfg.slippageBps }));
  const { tx, lvbh } = await swapTx(env, cfg, {
    quoteResponse: q, user, mints: { [inputMint]: inputProgram, [outputMint]: outputProgram },
    maxWrap: inputMint === SOL_MINT ? BigInt(amount) + 2_100_000n : 0n,
  });
  const why = await outcomeProblem(env, tx, { user, inputMint, outputMint, inputProgram, outputProgram, amount, minOut: q.otherAmountThreshold ?? q.outAmount });
  if (why) throw new Error(`Jupiter's swap was refused (${why}).`);
  tx.sign([kp]);
  return { tx, sig: chain.sigOf(tx), lvbh, outMicro: Number(q.outAmount || 0), minOut: Number(q.otherAmountThreshold ?? q.outAmount) };
}
