// Shared pieces for the curve scripts (launch-curve, migrate-curve, fee-ops, rehearse-curve).
// Ported from scripts/launch.mjs (this repo, 13-15 Nov): key loading (JSON array, Phantom base58, env), base58, the
// "save the signature before sending, settle an unknown outcome from the signature's status, never by resending" sender,
// transaction sizing, genesis-hash cluster names, the Exit/Refuse error pattern. New here: the curve builder, the plan
// numbers, Token-2022 withheld-fee readers and the settle helper being testable with a fake connection.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import BN from "bn.js";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getMint, getTransferFeeConfig, unpackAccount, getTransferFeeAmount,
  createAssociatedTokenAccountIdempotentInstruction, createWithdrawWithheldTokensFromAccountsInstruction,
  createWithdrawWithheldTokensFromMintInstruction,
} from "@solana/spl-token";
import {
  buildCurveWithMarketCap, TokenType, TokenDecimal, TokenAuthorityOption, BaseFeeMode, CollectFeeMode, MigrationOption,
  MigrationFeeOption, ActivationType, getMigrationThresholdPrice, getBaseTokenForSwap, getMigrationBaseToken,
  getPriceFromSqrtPrice, getMigrationQuoteAmountFromThreshold, getProtocolMigrationFee, PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS,
  calculateTransferFeeExcludedAmount,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

export const FEE_WALLET = "HrEKXpJvACWNxQJgQGhqNmJgQpwgC6kjtPD4dyDK2AH5";
export const DECIMALS = 6;
export const SUPPLY_TOKENS = 1_000_000_000;
export const TRANSFER_FEE_BPS = 1000; // Meteora's cap (constants.rs:82)
export const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const GENESIS = { "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet-beta", EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet", "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet" };
export const TX_MAX = 1232;
export const FEE_WALLET_MIN_LAMPORTS = 10_000_000n; // pays for every sweep/refund/claim; 0.01 SOL

// process.exit() right after network calls aborts Node on Windows, so a failure sets the exit code and unwinds.
export class Refuse extends Error {}
export const refuse = (msg) => { throw new Refuse(msg); };
export const sol = (l) => `${(Number(l) / 1e9).toFixed(6)} SOL`; // display only
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const tilde = (p) => String(p).replace(/^~(?=$|[\\/])/, homedir());

// ---- arguments ----------------------------------------------------------------------------------------------------
// spec = { value: [names that take a value], flag: [names that are switches] }. An unknown flag is a refusal: a typo in
// a money script (--team-bye) must not be silently ignored.
export function parseArgs(argv, spec) {
  const args = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const k = a.slice(2);
    if (spec.flag?.includes(k)) args[k] = true;
    else if (spec.value?.includes(k)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) refuse(`--${k} needs a value.`);
      args[k] = v; i++;
    } else refuse(`Unknown option --${k}.`);
  }
  return { args, pos };
}

export function lamportsOf(s, flag) {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(String(s));
  if (!m) refuse(`--${flag} must be an amount of SOL like 30 or 0.05.`);
  return BigInt(m[1]) * 1_000_000_000n + BigInt((m[2] || "").padEnd(9, "0"));
}
export function positiveNumber(s, flag) {
  const n = Number(s);
  if (!/^\d+(\.\d+)?$/.test(String(s)) || !(n > 0)) refuse(`--${flag} must be a number above 0.`);
  return n;
}

// ---- keys -----------------------------------------------------------------------------------------------------------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(s) {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}
export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}
// A solana-keygen JSON array (64 numbers) or a Phantom-exported base58 secret. Never echoes the secret.
export function parseSecret(raw) {
  try {
    const t = String(raw).trim().replace(/^["']|["']$/g, "");
    const bytes = t.startsWith("[") ? Uint8Array.from(JSON.parse(t)) : b58decode(t);
    return bytes.length === 32 ? Keypair.fromSeed(bytes) : Keypair.fromSecretKey(bytes);
  } catch { return null; }
}
// file = a path, env = the name of an environment variable; exactly one may be set. Returns null when neither is.
export function loadKey({ file, envName, label }) {
  const env = envName ? (process.env[envName] || "").trim() : "";
  if (file && env) refuse(`Both --${label} and ${envName} are set. Use one.`);
  if (!file && !env) return null;
  let raw = env;
  if (file) { try { raw = readFileSync(tilde(file), "utf8"); } catch { refuse(`Can't read the key file ${file}.`); } }
  return parseSecret(raw) ?? refuse(`The ${label} key isn't a solana-keygen JSON array or a base58 secret.`);
}
export const pubkeyOf = (s, flag) => { try { return new PublicKey(s); } catch { return refuse(`--${flag} isn't a Solana address.`); } };

// ---- connection -----------------------------------------------------------------------------------------------------
// A public RPC answers 429 under a burst. Pace the calls and retry 429/5xx/network errors with backoff. Retrying the same
// signed bytes is not a resend: a duplicate lands once, and unknown outcomes are still settled from the signature.
export function pacedFetch({ gapMs = 120, tries = 7, fetchFn = (...a) => fetch(...a), wait = sleep } = {}) {
  let next = 0;
  return async (info, init) => {
    for (let i = 0; ; i++) {
      const at = Math.max(Date.now(), next); next = at + gapMs;
      if (at > Date.now()) await wait(at - Date.now());
      let res;
      try { res = await fetchFn(info, init); } catch (e) { if (i + 1 >= tries) throw e; await wait(Math.min(15_000, 1000 * 2 ** i)); continue; }
      if ((res.status === 429 || (res.status >= 502 && res.status <= 504)) && i + 1 < tries) { await wait(Math.min(15_000, 1000 * 2 ** i)); continue; }
      return res;
    }
  };
}
export function connect(rpc) {
  const url = rpc || process.env.SOLANA_RPC_URL;
  if (!url) refuse("Give the RPC with --rpc <URL> or the SOLANA_RPC_URL environment variable.");
  return new Connection(url, { commitment: "confirmed", fetch: pacedFetch(), disableRetryOnRateLimit: true });
}
export async function clusterOf(conn) { return GENESIS[await conn.getGenesisHash()] || "an unknown cluster"; }

// ---- files ----------------------------------------------------------------------------------------------------------
export function readJson(f, fallback = null) { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; } }
// Write beside the target and rename: a crash leaves the old file or the new one, never half of one.
export function writeJson(f, obj) { const t = f + ".tmp"; writeFileSync(t, JSON.stringify(obj, null, 2)); renameSync(t, f); }
export function saveSecret(f, kp) {
  writeFileSync(f, JSON.stringify([...kp.secretKey]), { flag: "wx", mode: 0o600 });
  if (parseSecret(readFileSync(f, "utf8"))?.publicKey.toBase58() !== kp.publicKey.toBase58()) refuse(`The key didn't save properly to ${f}. Nothing was sent.`);
}

// ---- the curve ------------------------------------------------------------------------------------------------------
export const TOKEN_AUTHORITY = { immutable: TokenAuthorityOption.Immutable, creator: TokenAuthorityOption.CreatorUpdateAuthority, partner: TokenAuthorityOption.PartnerUpdateAuthority };

// One curve, one place. The settings that transfer-fee tokens force are the SDK's and the program's, not ours:
// Customizable migration fee, a Compounding-mode graduated pool, constant supply, no vesting
// (dynamic-bonding-curve state/config.rs:825-855). compoundingFeeBps 0 = the whole graduated-pool fee in SOL.
export function buildCurve({ startMcap, gradMcap, poolFeeBps = 25, tokenAuthority = "immutable" }) {
  if (!(startMcap > 0) || !(gradMcap > startMcap)) refuse("--grad-mcap must be above --start-mcap, and both above 0.");
  if (!Number.isInteger(poolFeeBps) || poolFeeBps < 25 || poolFeeBps > 1000) refuse("--pool-fee-bps is a whole number from 25 (the curve's minimum) to 1000.");
  if (!(tokenAuthority in TOKEN_AUTHORITY)) refuse("--token-authority is immutable, creator or partner.");
  return buildCurveWithMarketCap({
    token: { tokenType: TokenType.Token2022, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: 9, tokenAuthorityOption: TOKEN_AUTHORITY[tokenAuthority], totalTokenSupply: SUPPLY_TOKENS, leftover: 0 },
    fee: {
      baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: poolFeeBps, endingFeeBps: poolFeeBps, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: 0, poolCreationFee: 0, enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.Customizable, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: { collectFeeMode: 2, dynamicFee: 0, poolFeeBps, compoundingFeeBps: 0 },
    },
    // 100% of the graduated liquidity is permanently locked and owned by the partner (the fee wallet), which can claim its fees.
    liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 100, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp, initialMarketCap: startMcap, migrationMarketCap: gradMcap,
  });
}

const raw = (tokens) => BigInt(Math.round(tokens)) * 10n ** BigInt(DECIMALS);
// What the curve will do, from the config the SDK built. Mirrors the program's own arithmetic (SDK ports of it); the real
// numbers are read back from the stored config after launch (readConfigNumbers) and the two are compared in the rehearsal.
export function curvePlan(cfg, { poolFeeBps = 25 } = {}) {
  const threshold = cfg.migrationQuoteThreshold; // lamports of SOL the curve must collect
  const migSqrt = getMigrationThresholdPrice(threshold, cfg.sqrtStartPrice, cfg.curve);
  const sold = getBaseTokenForSwap(cfg.sqrtStartPrice, migSqrt, cfg.curve); // raw base units sold on the curve
  const migQuote = getMigrationQuoteAmountFromThreshold(threshold, 0);
  const migBase = getMigrationBaseToken(migQuote, migSqrt, MigrationOption.MET_DAMM_V2, 2);
  const [pb, pq] = getProtocolMigrationFee(migBase, migQuote, migSqrt, PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS, MigrationOption.MET_DAMM_V2, 2);
  const baseAfterProtocol = migBase.sub(pb), quoteAfterProtocol = migQuote.sub(pq);
  // The deposit scales the SOL side down by the transfer fee on the token side (migration_handler/compounding_liquidity.rs:167
  // get_migration_deposit_amounts); the SOL not deposited is booked to the protocol (migrate_damm_v2_initialize_pool.rs:1152-1165).
  const baseReceived = calculateTransferFeeExcludedAmount({ epoch: new BN(0), maximumFee: new BN("18446744073709551615"), transferFeeBasisPoints: TRANSFER_FEE_BPS }, baseAfterProtocol).amount;
  const quoteDeposited = quoteAfterProtocol.mul(baseReceived).div(baseAfterProtocol);
  const feeKeep = (x) => x.muln(10_000 - poolFeeBps).divn(10_000);
  return {
    startPriceSol: Number(getPriceFromSqrtPrice(cfg.sqrtStartPrice, 6, 9)),
    graduationPriceSol: Number(getPriceFromSqrtPrice(migSqrt, 6, 9)),
    thresholdLamports: BigInt(threshold.toString()),
    buyersPayAtGraduationLamports: BigInt(threshold.muln(10_000).divn(10_000 - poolFeeBps).toString()), // curve fee is on top
    soldTokensRaw: BigInt(sold.toString()),
    migrationBaseRaw: BigInt(migBase.toString()),
    protocolMigrationFeeQuoteLamports: BigInt(pq.toString()),
    poolDepositQuoteLamports: BigInt(quoteDeposited.toString()),
    withheldAtMigrationRaw: BigInt(baseAfterProtocol.sub(baseReceived).toString()),
    poolReserveBaseRaw: BigInt(baseReceived.toString()),
    unusedQuoteBookedToProtocolLamports: BigInt(quoteAfterProtocol.sub(quoteDeposited).toString()),
    _feeKeep: feeKeep, // not printed
  };
}

// ---- Token-2022 withheld fees ---------------------------------------------------------------------------------------
export const ata = (mint, owner) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);

export async function readMint(conn, mint) {
  const info = await conn.getAccountInfo(mint, "confirmed");
  if (!info) return null;
  if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) refuse(`${mint} exists but isn't a Token-2022 mint.`);
  const m = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const fee = getTransferFeeConfig(m);
  const epoch = (await conn.getEpochInfo("confirmed")).epoch;
  const f = fee && (BigInt(fee.newerTransferFee.epoch) <= BigInt(epoch) ? fee.newerTransferFee : fee.olderTransferFee);
  return {
    decimals: m.decimals, supply: m.supply, mintAuthority: m.mintAuthority, freezeAuthority: m.freezeAuthority,
    fee: fee && {
      bps: f.transferFeeBasisPoints, max: f.maximumFee, configAuthority: fee.transferFeeConfigAuthority.equals(PublicKey.default) ? null : fee.transferFeeConfigAuthority,
      withdrawAuthority: fee.withdrawWithheldAuthority.equals(PublicKey.default) ? null : fee.withdrawWithheldAuthority, withheld: fee.withheldAmount,
    },
  };
}

// {amount, withheld, owner, delegate, closeAuthority} per token account (null when it doesn't exist or isn't ours).
export async function readTokenAccounts(conn, mint, addrs) {
  const out = new Map();
  for (let i = 0; i < addrs.length; i += 90) { // a getMultipleAccounts call takes up to 100 keys
    const part = addrs.slice(i, i + 90);
    const infos = await conn.getMultipleAccountsInfo(part, "confirmed");
    part.forEach((a, j) => {
      const info = infos[j];
      if (!info || !info.owner.equals(TOKEN_2022_PROGRAM_ID)) return out.set(a.toBase58(), null);
      const t = unpackAccount(a, info, TOKEN_2022_PROGRAM_ID);
      if (!t.mint.equals(mint)) return out.set(a.toBase58(), null);
      out.set(a.toBase58(), { address: a, amount: t.amount, withheld: getTransferFeeAmount(t)?.withheldAmount ?? 0n, owner: t.owner, delegate: t.delegate, closeAuthority: t.closeAuthority });
    });
  }
  return out;
}

// One WithdrawWithheldTokensFromAccounts per up to 30 sources, the destination being the fee wallet's own token account
// (created if missing). The authority signs; the holders sign nothing.
export function sweepIxs({ mint, feeWallet, sources, fromMint }) {
  const dest = ata(mint, feeWallet);
  const ixs = [createAssociatedTokenAccountIdempotentInstruction(feeWallet, dest, feeWallet, mint, TOKEN_2022_PROGRAM_ID)];
  if (fromMint) ixs.push(createWithdrawWithheldTokensFromMintInstruction(mint, dest, feeWallet, [], TOKEN_2022_PROGRAM_ID));
  for (let i = 0; i < sources.length; i += 30) ixs.push(createWithdrawWithheldTokensFromAccountsInstruction(mint, dest, feeWallet, [], sources.slice(i, i + 30), TOKEN_2022_PROGRAM_ID));
  return ixs;
}
// Self-harvest: the authority releases an account's own withheld tokens back into it. No transfer, so no fee.
export const refundIx = ({ mint, feeWallet, account }) => createWithdrawWithheldTokensFromAccountsInstruction(mint, account, feeWallet, [], [account], TOKEN_2022_PROGRAM_ID);

// ---- sending: signature saved first, unknown outcomes settled from the signature ---------------------------------------

// "landed" | "failed" | "expired". Looks the signature up with history; waits while the blockhash could still land.
// Never resends. Ported from scripts/launch.mjs.
export async function settle(conn, sig, lastValidBlockHeight, { timeoutMs = 5 * 60_000, wait = sleep } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [st] = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value;
    if (st?.err) return { status: "failed", err: st.err };
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return { status: "landed" };
    if (!st && (await conn.getBlockHeight("confirmed")) > lastValidBlockHeight + 5) {
      const [again] = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value;
      if (!again) return { status: "expired" };
    }
    await wait(800);
  }
  throw new Error(`Still can't tell whether ${sig} landed. Run the same command again to keep checking; nothing else was sent.`);
}

export class TxFailed extends Error { constructor(label, sig, err) { super(`Transaction failed on chain (${label}): ${JSON.stringify(err)}  ${sig}`); this.sig = sig; this.err = err; } }

export const sizeOf = (ixs, payer) => {
  const tx = new Transaction({ feePayer: payer, blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 0 });
  tx.add(...ixs);
  const m = tx.compileMessage();
  return m.serialize().length + 1 + 64 * m.header.numRequiredSignatures;
};

// One sender per script run. `dir` holds <name>.pending.json (the signed-but-unresolved transaction) and <name>.log.
// A transaction that is still pending from an earlier crash is settled before anything new is sent.
export function makeSender({ conn, dir, name, say = console.log, priorityMicroLamports = 100_000, wait = sleep, settleTimeoutMs }) {
  mkdirSync(dir, { recursive: true });
  const pendingFile = join(dir, `${name}.pending.json`), logFile = join(dir, `${name}.log`);
  const note = (s) => appendFileSync(logFile, `${new Date().toISOString()} ${s}\n`);

  async function resolvePending() {
    if (!existsSync(pendingFile)) return null;
    const p = readJson(pendingFile);
    if (!p) refuse(`${pendingFile} is unreadable. Look the signature up by hand before sending anything else.`);
    say(`  checking the last transaction (${p.label}) ${p.sig}`);
    const r = await settle(conn, p.sig, p.lastValidBlockHeight, { wait, timeoutMs: settleTimeoutMs });
    unlinkSync(pendingFile);
    note(`resolved ${p.label} ${p.sig} ${r.status}`);
    say(`  it ${r.status === "expired" ? "never landed (blockhash expired)" : r.status}`);
    return { ...p, ...r };
  }

  async function send(label, ixs, signers) {
    await resolvePending();
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight });
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }), ...ixs);
    tx.sign(...signers);
    const sig = b58encode(tx.signature);
    writeJson(pendingFile, { label, sig, lastValidBlockHeight }); // BEFORE broadcast
    note(`sending ${label} ${sig}`);
    try {
      await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    } catch (e) {
      // A refusal by the simulation means it never reached the network; anything else leaves the signature to settle.
      if (e?.name === "SendTransactionError" || /simulation/i.test(String(e?.message))) {
        unlinkSync(pendingFile);
        throw new Error(`Refused before sending (${label}): ${e.message}${e.logs ? "\n" + e.logs.slice(-6).join("\n") : ""}`);
      }
      say(`  send error (${e.message}); settling from the signature`);
    }
    const r = await settle(conn, sig, lastValidBlockHeight, { wait, timeoutMs: settleTimeoutMs });
    unlinkSync(pendingFile);
    note(`${r.status} ${label} ${sig}`);
    if (r.status === "failed") throw new TxFailed(label, sig, r.err);
    say(`  ${r.status === "landed" ? "done" : "expired, nothing happened"}  ${label}  ${sig}`);
    return { sig, status: r.status };
  }

  // A dry run's proof: the real program's answer, without sending. includeAccounts returns their balances after.
  async function simulate(ixs, signers, includeAccounts) {
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash });
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }), ...ixs);
    const r = await conn.simulateTransaction(tx, signers, includeAccounts);
    return { err: r.value.err, logs: r.value.logs || [], units: r.value.unitsConsumed, accounts: r.value.accounts };
  }
  return { send, simulate, resolvePending, pendingFile, logFile };
}

// ---- small network helpers --------------------------------------------------------------------------------------------
export async function fetchJson(url, { timeoutMs = 15_000, init } = {}) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal, headers: { accept: "application/json", ...(init?.headers || {}) } });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { ok: res.ok, status: res.status, json, text };
  } catch (e) { return { ok: false, status: 0, json: null, text: String(e.message) }; } finally { clearTimeout(t); }
}

// The token's metadata file must exist and name the coin; an image that can't be fetched shows as a blank coin in wallets.
export async function checkUri(uri) {
  const r = await fetchJson(uri);
  if (!r.ok) return { ok: false, why: `${uri} answers ${r.status || "no response"} (${String(r.text).slice(0, 80)}).` };
  if (!r.json || typeof r.json !== "object") return { ok: false, why: `${uri} isn't JSON.` };
  const missing = ["name", "symbol", "image"].filter((k) => typeof r.json[k] !== "string" || !r.json[k].trim());
  if (missing.length) return { ok: false, why: `${uri} has no ${missing.join(", ")}.` };
  const img = await fetchJson(r.json.image, { init: { method: "GET" } });
  if (!img.ok) return { ok: false, why: `The image ${r.json.image} answers ${img.status || "no response"}.` };
  return { ok: true, json: r.json };
}
