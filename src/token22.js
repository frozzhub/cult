// Token-2022 pieces the refund and sweep engine needs: read a token account or the mint from raw bytes, decide what
// to do with an account's withheld tokens (pure), and build the instructions. Layouts are from the token-2022
// source (base account 165 bytes, account type byte at 165, TLV extensions from 166) and checked against real
// mainnet accounts in test/fixtures/accounts.json.
import { PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createWithdrawWithheldTokensFromAccountsInstruction, createWithdrawWithheldTokensFromMintInstruction,
} from "@solana/spl-token";

const EXT_TRANSFER_FEE_CONFIG = 1, EXT_TRANSFER_FEE_AMOUNT = 2;
const b58 = (u8) => new PublicKey(u8).toBase58();
const u64 = (u8, o) => new DataView(u8.buffer, u8.byteOffset + o, 8).getBigUint64(0, true);
const u32 = (u8, o) => new DataView(u8.buffer, u8.byteOffset + o, 4).getUint32(0, true);
const coption = (u8, o) => (u32(u8, o) === 1 ? b58(u8.subarray(o + 4, o + 36)) : null); // 4-byte tag, then 32 bytes

// TLV extensions after the account-type byte: Map(type -> bytes).
function extensions(u8) {
  const out = new Map();
  for (let o = 166; o + 4 <= u8.length;) {
    const type = u8[o] | (u8[o + 1] << 8), len = u8[o + 2] | (u8[o + 3] << 8);
    if (o + 4 + len > u8.length) break;
    out.set(type, u8.subarray(o + 4, o + 4 + len));
    o += 4 + len;
  }
  return out;
}

// A Token-2022 token account -> { mint, owner, amount, delegate, state, closeAuthority, withheld }, or null when the
// bytes are not an initialized token account. `withheld` is the TransferFeeAmount extension (0n when it has none).
export function parseTokenAccount(u8) {
  if (!u8 || u8.length < 165 || u8[108] === 0) return null;
  const ext = u8.length > 165 ? extensions(u8) : new Map();
  const fee = ext.get(EXT_TRANSFER_FEE_AMOUNT);
  return {
    mint: b58(u8.subarray(0, 32)), owner: b58(u8.subarray(32, 64)), amount: u64(u8, 64),
    delegate: coption(u8, 72), state: u8[108], closeAuthority: coption(u8, 129),
    withheld: fee && fee.length >= 8 ? u64(fee, 0) : 0n, hasFeeExt: !!fee,
  };
}

// A Token-2022 mint -> { decimals, withheld (held in the mint), withdrawAuthority, feeBps, mintAuthority, freezeAuthority }, or null.
export function parseMint(u8) {
  if (!u8 || u8.length < 82 || u8[45] !== 1) return null;
  const cfg = u8.length > 165 ? extensions(u8).get(EXT_TRANSFER_FEE_CONFIG) : null;
  const authority = (o) => { const k = cfg.subarray(o, o + 32); return k.every((b) => b === 0) ? null : b58(k); };
  return {
    decimals: u8[44], mintAuthority: coption(u8, 0), freezeAuthority: coption(u8, 46),
    withheld: cfg ? u64(cfg, 64) : 0n,
    withdrawAuthority: cfg ? authority(32) : null,
    // The newer fee is the one in force from its epoch on; the older one until then. The mint is built once and never
    // changes (no config authority), so both are the same number.
    feeBps: cfg ? cfg[106] | (cfg[107] << 8) : 0,
  };
}

export const onCurve = (w) => { try { return PublicKey.isOnCurve(new PublicKey(w).toBytes()); } catch { return false; } };

// The transfer fee on `amount`: rounded up (token-2022 does), capped by the mint's maximum.
export const feeOn = (amount, bps) => (BigInt(amount) * BigInt(bps) + 9_999n) / 10_000n;

/* ---------- what to do with an account's withheld tokens ---------- */

// acct: parseTokenAccount() read FRESH from the chain right before acting (null = the account is gone).
// ctx:  { address, mint, payout, treasury, deny: Set, minRefund: bigint }
// -> { action: "none" | "refund" | "sweep", why }
//   refund: owner on the ed25519 curve (a person's wallet), no delegate, no close authority, not frozen. The withheld
//           tokens go back into the SAME account, fee-free, so buys and wallet-to-wallet sends net 0%.
//   sweep:  everything else (pool vaults and other program-owned accounts, delegated or closable accounts, denied
//           owners, dust). The withheld tokens go to the treasury: this is the sell tax.
// A delegate set AFTER a refund changes nothing already refunded: the tokens were the owner's own.
export function classify(acct, ctx) {
  if (!acct) return { action: "none", why: "gone" };
  if (acct.mint !== ctx.mint) return { action: "none", why: "other mint" };
  if (acct.withheld <= 0n) return { action: "none", why: "empty" };
  if (ctx.address === ctx.treasury || acct.owner === ctx.payout) return { action: "none", why: "treasury" };
  if (ctx.deny.has(acct.owner)) return { action: "sweep", why: "denied" };
  if (acct.state === 2) return { action: "sweep", why: "frozen" };
  if (!onCurve(acct.owner)) return { action: "sweep", why: "program-owned" };
  if (acct.delegate) return { action: "sweep", why: "delegate" };
  if (acct.closeAuthority) return { action: "sweep", why: "close authority" };
  if (acct.withheld < ctx.minRefund) return { action: "sweep", why: "dust" };
  return { action: "refund", why: "wallet" };
}

/* ---------- instructions ---------- */

export const treasuryAta = (mint, payout) => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(payout), false, TOKEN_2022_PROGRAM_ID);

const budget = (units, price) => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price })];
// Compute-unit limits at about 2.4x what a mainnet simulation used (docs/build-log-curve-worker.md): a refund is ~2.2k units per
// account, a sweep ~21k for the treasury-account create plus ~0.3k per account, a mint sweep ~21k. The limit sets the priority fee paid.
const units = (kind, n) => (kind === "refund" ? 5_000 + n * 5_000 : 30_000 + n * 3_000);

// The refund instruction for one account: its own withheld tokens back into itself. Used alone (site buys) and in batches.
export const refundIx = (mint, account, authority) =>
  createWithdrawWithheldTokensFromAccountsInstruction(new PublicKey(mint), new PublicKey(account), new PublicKey(authority), [], [new PublicKey(account)], TOKEN_2022_PROGRAM_ID);

// kind "refund": one self-withdraw per account (each instruction has a single destination, so one each).
// kind "sweep":  the treasury account (opened if missing) is the destination of one instruction listing every source.
// kind "mint":   the withheld tokens held in the mint go to the treasury.
// The payout key is both fee payer and withdraw authority, so the transaction has one signer.
export function buildFeeTx(kp, blockhash, { kind, mint, accounts = [], priority = 100_000 }) {
  const payer = kp.publicKey, m = new PublicKey(mint), treasury = treasuryAta(mint, payer);
  const ixs = [];
  if (kind === "refund") {
    ixs.push(...budget(units(kind, accounts.length), priority));
    for (const a of accounts) ixs.push(refundIx(mint, a, payer));
  } else {
    ixs.push(...budget(units(kind, accounts.length), priority));
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(payer, treasury, payer, m, TOKEN_2022_PROGRAM_ID));
    ixs.push(kind === "mint"
      ? createWithdrawWithheldTokensFromMintInstruction(m, treasury, payer, [], TOKEN_2022_PROGRAM_ID)
      : createWithdrawWithheldTokensFromAccountsInstruction(m, treasury, payer, [], accounts.map((a) => new PublicKey(a)), TOKEN_2022_PROGRAM_ID));
  }
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  tx.sign([kp]);
  return tx;
}
