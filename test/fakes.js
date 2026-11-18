// Fakes shared by the Worker tests (replaces pool-fake.js): Token-2022 account and mint bytes in the real layout (checked
// against mainnet accounts in token22.test.js), Jupiter answers in its real JSON shape, and a simulateTransaction answer.
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction,
  createCloseAccountInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { JUPITER_PROGRAM } from "../src/jupiter.js";

export const SOL = "So11111111111111111111111111111111111111112";
export const b64 = (u8) => Buffer.from(u8).toString("base64");
export const addr = () => Keypair.generate().publicKey.toBase58();
// An address with no private key (the shape of a pool vault's owner): off the ed25519 curve.
export const pda = (seed = "vault") => PublicKey.findProgramAddressSync([Buffer.from(seed + Math.random())], Keypair.generate().publicKey)[0].toBase58();

const put = (buf, o, base58) => new PublicKey(base58).toBuffer().copy(buf, o);
const coption = (buf, o, base58) => { if (base58) { buf.writeUInt32LE(1, o); put(buf, o + 4, base58); } };

// A Token-2022 token account with the TransferFeeAmount extension (and ImmutableOwner, as an associated account has).
export function tokenAccount({ mint, owner, amount = 0n, withheld = 0n, delegate = null, closeAuthority = null, state = 1, ext = true }) {
  const buf = Buffer.alloc(ext ? 182 : 165);
  put(buf, 0, mint); put(buf, 32, owner); buf.writeBigUInt64LE(BigInt(amount), 64);
  coption(buf, 72, delegate); buf[108] = state; coption(buf, 129, closeAuthority);
  if (ext) { buf[165] = 2; buf.writeUInt16LE(7, 166); buf.writeUInt16LE(0, 168); buf.writeUInt16LE(2, 170); buf.writeUInt16LE(8, 172); buf.writeBigUInt64LE(BigInt(withheld), 174); }
  return new Uint8Array(buf);
}

// A Token-2022 mint with a TransferFeeConfig: no config authority (the fee can never change), `withdraw` may withdraw withheld tokens.
export function mintAccount({ withdraw, feeBps = 1000, withheld = 0n, decimals = 6, mintAuthority = null, freezeAuthority = null }) {
  const buf = Buffer.alloc(166 + 4 + 108), d = 170; // extension data starts after its 4-byte type and length
  buf[44] = decimals; buf[45] = 1; buf[165] = 1;
  coption(buf, 0, mintAuthority); coption(buf, 46, freezeAuthority);
  buf.writeUInt16LE(1, 166); buf.writeUInt16LE(108, 168);
  if (withdraw) put(buf, d + 32, withdraw);
  buf.writeBigUInt64LE(BigInt(withheld), d + 64);
  buf.writeUInt16LE(feeBps, d + 72 + 16); buf.writeUInt16LE(feeBps, d + 90 + 16);
  return new Uint8Array(buf);
}

/* ---------- Jupiter ---------- */

export function jupQuote({ inputMint, outputMint, amount, out, minOut, impact = "0.0001" }) {
  return {
    inputMint, inAmount: String(amount), outputMint, outAmount: String(out), otherAmountThreshold: String(minOut ?? (BigInt(out) * 99n) / 100n),
    swapMode: "ExactIn", slippageBps: 100, priceImpactPct: String(impact), routePlan: [{ swapInfo: { label: "Fake" }, percent: 100 }],
  };
}

const json = (ix) => ({ programId: ix.programId.toBase58(), accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data).toString("base64") });
const cu = (limit, price) => [
  { programId: "ComputeBudget111111111111111111111111111111", accounts: [], data: Buffer.from([2, ...new Uint8Array(new Uint32Array([limit]).buffer)]).toString("base64") },
  { programId: "ComputeBudget111111111111111111111111111111", accounts: [], data: Buffer.from([3, ...new Uint8Array(new BigUint64Array([BigInt(price)]).buffer)]).toString("base64") },
];

// What Jupiter's /swap-instructions answers for `user` swapping `amount` of inputMint into outputMint. The program
// instruction is opaque to us (it is Jupiter's), with the user as the only signer.
export function jupSwapInstructions({ user, inputMint, outputMint, inputProgram = TOKEN_PROGRAM_ID, outputProgram = TOKEN_PROGRAM_ID, amount }) {
  const u = new PublicKey(user), wsol = getAssociatedTokenAddressSync(new PublicKey(SOL), u, true, TOKEN_PROGRAM_ID);
  const ata = (m, p) => getAssociatedTokenAddressSync(new PublicKey(m), u, true, p);
  const setup = [], cleanup = [];
  const make = (m, p) => json(createAssociatedTokenAccountIdempotentInstruction(u, ata(m, p), u, new PublicKey(m), p));
  if (inputMint === SOL) {
    setup.push(make(SOL, TOKEN_PROGRAM_ID), json(SystemProgram.transfer({ fromPubkey: u, toPubkey: wsol, lamports: BigInt(amount) })), json(createSyncNativeInstruction(wsol)));
    cleanup.push(json(createCloseAccountInstruction(wsol, u, u)));
  } else setup.push(make(inputMint, inputProgram));
  if (outputMint === SOL) { setup.push(make(SOL, TOKEN_PROGRAM_ID)); cleanup.push(json(createCloseAccountInstruction(wsol, u, u))); }
  else setup.push(make(outputMint, outputProgram));
  const swap = {
    programId: JUPITER_PROGRAM,
    accounts: [
      { pubkey: TOKEN_PROGRAM_ID.toBase58(), isSigner: false, isWritable: false }, { pubkey: user, isSigner: true, isWritable: false },
      { pubkey: (inputMint === SOL ? wsol : ata(inputMint, inputProgram)).toBase58(), isSigner: false, isWritable: true },
      { pubkey: (outputMint === SOL ? wsol : ata(outputMint, outputProgram)).toBase58(), isSigner: false, isWritable: true },
      { pubkey: addr(), isSigner: false, isWritable: true }, // a pool account
    ],
    data: Buffer.from([229, 23, 203, 151, 122, 227, 173, 42, 0, 1, 2, 3]).toString("base64"),
  };
  return { computeBudgetInstructions: cu(200_000, 1000), setupInstructions: setup, swapInstruction: swap, cleanupInstruction: cleanup[0] || null, otherInstructions: [], addressLookupTableAddresses: [] };
}

// A simulateTransaction answer: `accounts` lists the addresses asked for, `state(address)` gives { lamports, bytes } after the run.
export function simulation(params, state, { err = null } = {}) {
  const want = params[1]?.accounts?.addresses || [];
  return { context: { slot: 1 }, value: { err, logs: [], unitsConsumed: 150_000, accounts: want.map((a) => { const s = state(a); return s ? { lamports: Number(s.lamports), data: [b64(s.bytes || new Uint8Array(0)), "base64"], owner: TOKEN_PROGRAM_ID.toBase58() } : null; }) } };
}
export { TOKEN_2022_PROGRAM_ID };
