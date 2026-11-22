// One-time launch of $CULT: create the Token-2022 mint (transfer hook + on-chain metadata), the hook's account
// list, mint the supply, create the pool (virtual SOL seed, no SOL goes in), optionally buy for the team, then
// revoke the mint authority AND the transfer-hook authority, so nothing about the coin can be changed.
//
//   node scripts/launch.mjs --keypair <file> --payout <PAYOUT_WALLET> --supply 1000000000 \
//     --name Cult --symbol CULT --uri https://<domain>/token.json --rpc <URL> \
//     [--virtual 30] [--buy-fee 0] [--team-buy <SOL>] [--keys-dir program-keys/mainnet] [--go]
//
// The creator is whoever owns --keypair (a solana-keygen JSON array file, or a file holding a Phantom-exported
// base58 secret) or the CREATOR_KEY env var (base58). It is not the program deployer. It needs about 0.015 SOL for
// accounts and fees, plus --team-buy. The payout wallet must already hold 0.06 SOL (small sells fail otherwise).
//
// Without --go it only prints the plan and the checks. With --go:
//   - the generated mint key is saved to <keys-dir>/mint-<pubkey>.json BEFORE anything is sent;
//   - steps are grouped into as few transactions as fit (one for supply + pool + team buy + both revokes if it does);
//   - each transaction is signed and its signature saved (<keys-dir>/launch-<mint>.pending.json) BEFORE it is sent;
//   - an unknown outcome is settled only from that signature's status, never by sending again;
//   - re-running after a crash finds the mint key, reads what exists on chain and does only what is left.
// A finished launch in the keys dir is never resumed or repeated: add --new-mint to launch another coin on purpose.
// Testing knobs: --split (one step per transaction) and --max-txs <n> (stop after n transactions).
//
// Reuse: step order, mint/metadata/hook set-up and account lists come from this script's first version (devnet,
// 13 Nov); b58decode is ported from src/chain.js.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, ExtensionType, getMintLen, getAccountLen, getAssociatedTokenAddressSync,
  createInitializeMintInstruction, createInitializeTransferHookInstruction, createInitializeMetadataPointerInstruction,
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, createSetAuthorityInstruction, AuthorityType,
  unpackMint, getTransferHook, TYPE_SIZE, LENGTH_SIZE,
} from "@solana/spl-token";
import { createInitializeInstruction as createInitMetadata, pack as packMetadata } from "@solana/spl-token-metadata";

const POOL_PROGRAM = new PublicKey("5xsG4XWGVdazEZSDkjFWu25gCyeCnTuxuPxbmJ1xmA4D");
const HOOK_PROGRAM = new PublicKey("521AkYhN31VTGPLn75NgeWievYHZoxPwREihCCsppxnF");
const DECIMALS = 6;
const FEE_BPS = 1500;
const MAX_BUY_FEE_BPS = 500;
const PAYOUT_MIN = 60_000_000n; // lamports: below this a small sell's fee can't open the payout wallet
const TX_MAX = 1232; // bytes in a transaction
const FEE_MARGIN = 3_000_000n; // lamports for transaction fees
const POOL_LEN = 125; // 8 disc + mint, vault, payout (96) + fee_bps 2 + sol_reserve 8 + bump 1 + virtual_sol 8 + buy_fee_bps 2
const METAS_LEN = 16; // the hook's empty extra-account list
const GENESIS = { "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet-beta", EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet", "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet" };

// process.exit() right after network calls aborts Node on Windows, so failing sets the exit code and unwinds instead.
class Exit extends Error {}
process.on("uncaughtException", (e) => { if (!(e instanceof Exit)) console.error(e.stack || e); process.exitCode = 1; });
const fail = (msg) => { console.error(msg); process.exitCode = 1; throw new Exit(msg); };
class Refuse extends Error {}
const refuse = (msg) => { throw new Refuse(msg); };
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]]] : a), []));
const need = (k) => { if (typeof args[k] !== "string") fail(`Missing --${k}`); return args[k]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sol = (l) => `${(Number(l) / 1e9).toFixed(4)} SOL`; // display only

// ---- inputs ---------------------------------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s) {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}
function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}
// A solana-keygen JSON array (64 numbers) or a Phantom-exported base58 secret. Never echoes the secret.
function parseSecret(raw) {
  try {
    const t = String(raw).trim().replace(/^["']|["']$/g, "");
    const bytes = t.startsWith("[") ? Uint8Array.from(JSON.parse(t)) : b58decode(t);
    return bytes.length === 32 ? Keypair.fromSeed(bytes) : Keypair.fromSecretKey(bytes);
  } catch { return null; }
}
const lamportsOf = (s, flag) => {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(String(s));
  if (!m) fail(`--${flag} must be an amount of SOL like 30 or 0.05`);
  return BigInt(m[1]) * 1_000_000_000n + BigInt((m[2] || "").padEnd(9, "0"));
};
const tilde = (p) => String(p).replace(/^~(?=$|[\\/])/, homedir());

function loadCreator() {
  const env = (process.env.CREATOR_KEY || "").trim();
  if (args.keypair && env) fail("Both --keypair and CREATOR_KEY are set. Use one.");
  if (!args.keypair && !env) fail("Give the creator's key with --keypair <file> or the CREATOR_KEY environment variable.");
  if (args.keypair && typeof args.keypair !== "string") fail("--keypair needs a file path.");
  let raw = env;
  if (args.keypair) { try { raw = readFileSync(tilde(args.keypair), "utf8"); } catch { fail(`Can't read the key file ${args.keypair}.`); } }
  return parseSecret(raw) ?? fail("The creator key isn't a solana-keygen JSON array or a base58 secret.");
}

const creator = loadCreator();
let payout;
try { payout = new PublicKey(need("payout")); } catch { fail("--payout isn't a wallet address."); }
const virtualSol = lamportsOf(args.virtual ?? "30", "virtual");
if (virtualSol <= 0n) fail("--virtual must be more than 0.");
if (!/^\d+$/.test(String(args["buy-fee"] ?? "0")) || Number(args["buy-fee"] ?? 0) > MAX_BUY_FEE_BPS) fail(`--buy-fee is in basis points, 0 to ${MAX_BUY_FEE_BPS} (100 = 1%).`);
const BUY_FEE_BPS = Number(args["buy-fee"] ?? 0);
const teamBuy = args["team-buy"] === undefined ? 0n : lamportsOf(args["team-buy"], "team-buy");
if (args["team-buy"] !== undefined && teamBuy <= 0n) fail("--team-buy must be more than 0.");
if (!/^\d+$/.test(String(args.supply))) fail("--supply is a whole number of tokens, like 1000000000.");
const supply = BigInt(args.supply) * 10n ** BigInt(DECIMALS);
const meta = { name: need("name"), symbol: need("symbol"), uri: need("uri") };
const conn = new Connection(args.rpc || "https://api.devnet.solana.com", "confirmed");
const keysDir = resolve(typeof args["keys-dir"] === "string" ? tilde(args["keys-dir"]) : join(REPO, "program-keys", "mainnet"));
const GO = args.go === true;
const maxTxs = args["max-txs"] === undefined ? Infinity : Number(args["max-txs"]);

const enc = new TextEncoder();
const disc = (name) => createHash("sha256").update("global:" + name).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const quoteOut = (amountIn, reserveIn, reserveOut) => (amountIn * reserveOut) / (reserveIn + amountIn); // mirrors the pool, rounds down
const feeOf = (amount, bps) => (amount * BigInt(bps)) / 10_000n;

// ---- the mint key: found, or made and saved before anything is sent -----------------------------------------------

const mintFiles = () => (existsSync(keysDir) ? readdirSync(keysDir).filter((f) => /^mint-.+\.json$/.test(f)).map((f) => join(keysDir, f)) : []);
const addrs = (mint) => {
  const pool = PublicKey.findProgramAddressSync([enc.encode("pool"), mint.toBytes()], POOL_PROGRAM)[0];
  return {
    pool,
    metas: PublicKey.findProgramAddressSync([enc.encode("extra-account-metas"), mint.toBytes()], HOOK_PROGRAM)[0],
    creatorAta: getAssociatedTokenAddressSync(mint, creator.publicKey, false, TOKEN_2022_PROGRAM_ID),
    vault: getAssociatedTokenAddressSync(mint, pool, true, TOKEN_2022_PROGRAM_ID),
  };
};

// What exists on chain for this mint, read at "confirmed". Refuses anything that isn't ours.
async function readState(mint) {
  const a = addrs(mint);
  const [mintAcc, metasAcc, poolAcc, ataAcc, vaultAcc] = await conn.getMultipleAccountsInfo([mint, a.metas, a.pool, a.creatorAta, a.vault], "confirmed");
  const st = { ...a, mintExists: false, metasExists: false, poolExists: false, supply: 0n, ataBalance: 0n, mintAuthorityNull: false, hookAuthorityNull: false };
  if (mintAcc) {
    if (!mintAcc.owner.equals(TOKEN_2022_PROGRAM_ID)) refuse(`${mint} exists but isn't a Token-2022 mint.`);
    const m = unpackMint(mint, mintAcc, TOKEN_2022_PROGRAM_ID);
    const hook = getTransferHook(m);
    if (!hook || !hook.programId.equals(HOOK_PROGRAM)) refuse(`Mint ${mint} has a different transfer hook.`);
    if (m.mintAuthority && !m.mintAuthority.equals(creator.publicKey)) refuse(`Mint ${mint} belongs to another creator.`);
    if (!hook.authority.equals(PublicKey.default) && !hook.authority.equals(creator.publicKey)) refuse(`Mint ${mint}: the hook authority is someone else's.`);
    if (m.decimals !== DECIMALS) refuse(`Mint ${mint} has ${m.decimals} decimals, not ${DECIMALS}.`);
    Object.assign(st, { mintExists: true, supply: m.supply, mintAuthorityNull: m.mintAuthority === null, hookAuthorityNull: hook.authority.equals(PublicKey.default) });
  }
  if (metasAcc && metasAcc.owner.equals(HOOK_PROGRAM)) st.metasExists = true;
  if (poolAcc) {
    if (!poolAcc.owner.equals(POOL_PROGRAM)) refuse(`The pool address ${a.pool} is owned by another program.`);
    const d = poolAcc.data;
    const same = new PublicKey(d.subarray(8, 40)).equals(mint) && new PublicKey(d.subarray(72, 104)).equals(payout) && d.readUInt16LE(104) === FEE_BPS
      && d.readBigUInt64LE(115) === virtualSol && d.readUInt16LE(123) === BUY_FEE_BPS;
    if (!same) refuse(`A pool for ${mint} already exists with different settings (payout, fees or virtual SOL).`);
    st.poolExists = true;
    st.solReserve = d.readBigUInt64LE(106);
    st.vaultTokens = vaultAcc ? vaultAcc.data.readBigUInt64LE(64) : 0n;
  }
  if (ataAcc && ataAcc.owner.equals(TOKEN_2022_PROGRAM_ID)) st.ataBalance = ataAcc.data.readBigUInt64LE(64);
  return st;
}

// ---- the steps ------------------------------------------------------------------------------------------------------

const keys = (list) => list.map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable }));

function buildSteps(mint, st, rent) {
  const { pool, metas, creatorAta, vault } = st;
  const c = creator.publicKey;
  const hookKeys = [[HOOK_PROGRAM, false, false], [metas, false, false]];
  const buyIx = (solIn, minOut) => new TransactionInstruction({
    programId: POOL_PROGRAM, data: Buffer.concat([disc("buy"), u64(solIn), u64(minOut)]),
    keys: keys([[c, true, true], [mint, false, false], [pool, false, true], [vault, false, true], [creatorAta, false, true], [payout, false, true],
      [TOKEN_2022_PROGRAM_ID, false, false], [ASSOCIATED_TOKEN_PROGRAM_ID, false, false], [SystemProgram.programId, false, false], ...hookKeys]),
  });
  // The team buy is priced from the virtual seed when the pool is created in the same transaction (nobody can trade in
  // between); on a re-run it is priced from the live pool with 1% of room.
  const teamMinOut = st.poolExists
    ? (quoteOut(teamBuy - feeOf(teamBuy, BUY_FEE_BPS), st.solReserve, st.vaultTokens) * 99n) / 100n
    : quoteOut(teamBuy - feeOf(teamBuy, BUY_FEE_BPS), virtualSol, supply);

  const metaLen = TYPE_SIZE + LENGTH_SIZE + packMetadata({ mint, updateAuthority: c, ...meta, additionalMetadata: [] }).length;
  const mintLen = getMintLen([ExtensionType.TransferHook, ExtensionType.MetadataPointer]);
  const setAuth = (type) => createSetAuthorityInstruction(mint, c, type, null, [], TOKEN_2022_PROGRAM_ID);
  return [
    { name: "mint", done: st.mintExists, cost: rent.mintAndMeta, ixs: () => [
      SystemProgram.createAccount({ fromPubkey: c, newAccountPubkey: mint, space: mintLen, lamports: Number(rent.mintAndMeta), programId: TOKEN_2022_PROGRAM_ID }), // rent is far below 2^53
      createInitializeTransferHookInstruction(mint, c, HOOK_PROGRAM, TOKEN_2022_PROGRAM_ID),
      createInitializeMetadataPointerInstruction(mint, c, mint, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(mint, DECIMALS, c, null, TOKEN_2022_PROGRAM_ID),
      createInitMetadata({ programId: TOKEN_2022_PROGRAM_ID, metadata: mint, updateAuthority: c, mint, mintAuthority: c, ...meta }),
    ] },
    { name: "hook list", done: st.metasExists, cost: rent.metas, ixs: () => [new TransactionInstruction({
      programId: HOOK_PROGRAM, data: disc("initialize_extra_account_meta_list"),
      keys: keys([[c, true, true], [metas, false, true], [mint, false, false], [SystemProgram.programId, false, false]]),
    })] },
    { name: "supply", done: st.supply >= supply, cost: rent.ata, ixs: () => [
      createAssociatedTokenAccountIdempotentInstruction(c, creatorAta, c, mint, TOKEN_2022_PROGRAM_ID),
      createMintToInstruction(mint, creatorAta, c, supply, [], TOKEN_2022_PROGRAM_ID),
    ] },
    { name: "pool", done: st.poolExists, cost: rent.pool + rent.ata, ixs: () => [new TransactionInstruction({
      programId: POOL_PROGRAM, data: Buffer.concat([disc("initialize"), u16(FEE_BPS), u16(BUY_FEE_BPS), u64(supply), u64(virtualSol)]),
      keys: keys([[c, true, true], [mint, false, false], [pool, false, true], [vault, false, true], [creatorAta, false, true], [payout, false, false],
        [TOKEN_2022_PROGRAM_ID, false, false], [ASSOCIATED_TOKEN_PROGRAM_ID, false, false], [SystemProgram.programId, false, false], ...hookKeys]),
    })] },
    ...(teamBuy > 0n ? [{ name: "team buy", done: st.poolExists && st.ataBalance > 0n, cost: teamBuy, ixs: () => [buyIx(teamBuy, teamMinOut)] }] : []),
    { name: "revoke mint authority", done: st.mintAuthorityNull, cost: 0n, ixs: () => [setAuth(AuthorityType.MintTokens)] },
    { name: "revoke hook authority", done: st.hookAuthorityNull, cost: 0n, ixs: () => [setAuth(AuthorityType.TransferHookProgramId)] },
  ];
}

const txOf = (ixs, blockhash) => { const tx = new Transaction({ feePayer: creator.publicKey, blockhash, lastValidBlockHeight: 0 }); tx.add(...ixs); return tx; };
const sizeOf = (ixs) => { const m = txOf(ixs, PublicKey.default.toBase58()).compileMessage(); return m.serialize().length + 1 + 64 * m.header.numRequiredSignatures; };

// As few transactions as fit, in order. --split puts every step in its own.
function groupSteps(pending) {
  const groups = [];
  for (const s of pending) {
    const last = groups[groups.length - 1];
    if (!args.split && last && sizeOf([...last.ixs, ...s.ixs()]) <= TX_MAX) { last.names.push(s.name); last.ixs.push(...s.ixs()); }
    else groups.push({ names: [s.name], ixs: [...s.ixs()] });
  }
  return groups;
}

// ---- sending: signature saved first, unknown outcomes settled from the signature ------------------------------------

const pendingFile = (mint) => join(keysDir, `launch-${mint}.pending.json`);
const logFile = (mint) => join(keysDir, `launch-${mint}.log`);

// "landed" | "failed" | "expired". Looks the signature up with history; waits while the blockhash could still land.
async function settle(sig, lastValid) {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const [st] = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value;
    if (st?.err) return { status: "failed", err: st.err };
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return { status: "landed" };
    if (!st && (await conn.getBlockHeight("confirmed")) > lastValid + 5) {
      const [again] = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value;
      if (!again) return { status: "expired" };
    }
    await sleep(800);
  }
  fail(`Still can't tell whether ${sig} landed. Run the same command again to keep checking; nothing else was sent.`);
}

async function resolvePending(mint) {
  const f = pendingFile(mint);
  if (!existsSync(f)) return;
  const p = JSON.parse(readFileSync(f, "utf8"));
  console.log(`  checking the last transaction (${p.names}) ${p.sig}`);
  const r = await settle(p.sig, p.lastValidBlockHeight);
  unlinkSync(f);
  console.log(`  it ${r.status === "expired" ? "never landed (blockhash expired)" : r.status}`);
}

async function sendGroup(mint, g) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = txOf(g.ixs, blockhash);
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.sign(creator, ...(g.names.includes("mint") ? [mintKp] : []));
  const sig = b58encode(tx.signature);
  writeFileSync(pendingFile(mint), JSON.stringify({ names: g.names, sig, lastValidBlockHeight }));
  appendFileSync(logFile(mint), `${new Date().toISOString()} ${g.names.join(" + ")} ${sig}\n`);
  try {
    await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
  } catch (e) {
    // A refusal by the simulation means it never reached the network; anything else leaves the signature to settle.
    if (e?.name === "SendTransactionError" || /simulation/i.test(String(e?.message))) { unlinkSync(pendingFile(mint)); fail(`Refused before sending (${g.names.join(" + ")}): ${e.message}\n${(e.logs || []).join("\n")}`); }
    console.log(`  send error (${e.message}); settling from the signature`);
  }
  const r = await settle(sig, lastValidBlockHeight);
  unlinkSync(pendingFile(mint));
  if (r.status === "failed") fail(`Transaction failed on chain (${g.names.join(" + ")}): ${JSON.stringify(r.err)}  ${sig}\nFix the cause and run the same command again.`);
  console.log(`  ${r.status === "landed" ? "done" : "expired, will retry"}  ${g.names.join(" + ")}  (${tx.serialize().length} bytes)  ${sig}`);
  return r.status === "landed";
}

// ---- main -------------------------------------------------------------------------------------------------------------

let mintKp = null;

async function main() {
  const problems = [];
  let cluster = "unreachable", rent = null, payoutBal = null, creatorBal = null;
  try {
    cluster = GENESIS[await conn.getGenesisHash()] || "an unknown cluster (a local validator?)";
    const mintLen = getMintLen([ExtensionType.TransferHook, ExtensionType.MetadataPointer]);
    const metaLen = TYPE_SIZE + LENGTH_SIZE + packMetadata({ mint: PublicKey.default, updateAuthority: creator.publicKey, ...meta, additionalMetadata: [] }).length;
    const r = async (n) => BigInt(await conn.getMinimumBalanceForRentExemption(n));
    rent = { mintAndMeta: await r(mintLen + metaLen), metas: await r(METAS_LEN), ata: await r(getAccountLen([ExtensionType.ImmutableOwner, ExtensionType.TransferHookAccount])), pool: await r(POOL_LEN) };
    [payoutBal, creatorBal] = (await conn.getMultipleAccountsInfo([payout, creator.publicKey], "confirmed")).map((a) => BigInt(a?.lamports ?? 0));
    const [poolProg, hookProg] = await conn.getMultipleAccountsInfo([POOL_PROGRAM, HOOK_PROGRAM], "confirmed");
    if (!poolProg?.executable) problems.push(`The pool program ${POOL_PROGRAM} isn't deployed on this cluster.`);
    if (!hookProg?.executable) problems.push(`The hook program ${HOOK_PROGRAM} isn't deployed on this cluster.`);
    if (payoutBal < PAYOUT_MIN) problems.push(`The payout wallet ${payout} holds ${sol(payoutBal)}; it needs at least ${sol(PAYOUT_MIN)} before launch. Send ${sol(PAYOUT_MIN - payoutBal)} more.`);
  } catch (e) { problems.push(`Can't read the cluster at ${conn.rpcEndpoint}: ${e.message}`); }

  // Which mint: an explicit file, a saved unfinished launch, or a new key.
  let mintNote = "new key, saved before the first send";
  if (typeof args["mint-keypair"] === "string") {
    mintKp = parseSecret(readFileSync(tilde(args["mint-keypair"]), "utf8")) ?? fail("--mint-keypair isn't a valid key file.");
    mintNote = `from ${args["mint-keypair"]}`;
  } else if (!problems.length && !args["new-mint"]) {
    const unfinished = [], finished = [];
    for (const f of mintFiles()) {
      const kp = parseSecret(readFileSync(f, "utf8"));
      if (!kp) continue;
      try {
        const s = await readState(kp.publicKey);
        (s.poolExists && s.mintAuthorityNull && s.hookAuthorityNull ? finished : unfinished).push({ f, kp });
      } catch (e) { if (!(e instanceof Refuse)) throw e; /* not this launch's: skip */ }
    }
    if (unfinished.length > 1) fail(`More than one unfinished launch key in ${keysDir}:\n${unfinished.map((x) => "  " + x.f).join("\n")}\nPass the right one with --mint-keypair <file>.`);
    if (unfinished.length === 1) { mintKp = unfinished[0].kp; mintNote = `RESUMING the unfinished launch saved in ${unfinished[0].f}`; }
    // A launch whose last transaction landed just before a crash looks like this on the re-run: say so, don't start a second coin.
    else if (finished.length) fail(`REFUSING: already launched here, nothing was sent:\n${finished.map((x) => "  " + x.f).join("\n")}\nTo launch another coin on purpose, add --new-mint.`);
  }
  const fresh = !mintKp;
  if (fresh) mintKp = Keypair.generate();
  const mint = mintKp.publicKey;

  let state = null, preview = null;
  if (!problems.length) {
    state = await readState(mint);
    const pending = buildSteps(mint, state, rent).filter((s) => !s.done);
    const needed = FEE_MARGIN + pending.reduce((n, s) => n + s.cost, 0n);
    if (creatorBal < needed) problems.push(`The creator wallet ${creator.publicKey} holds ${sol(creatorBal)}; the steps left need about ${sol(needed)} (account rent and fees${teamBuy ? `, and the ${sol(teamBuy)} team buy` : ""}). Send at least ${sol(needed - creatorBal)} more.`);
    preview = groupSteps(pending);
  }

  console.log(`
Plan (${GO ? "LIVE" : "dry run, add --go to send"}) on ${conn.rpcEndpoint} (${cluster})
  creator      ${creator.publicKey.toBase58()}  holds ${creatorBal === null ? "?" : sol(creatorBal)}; launches the coin and keeps nothing: put it in EXCLUDE in wrangler.jsonc${teamBuy ? " (it also takes the team buy)" : ""}
  mint         ${mint.toBase58()}  (${meta.name} / $${meta.symbol}, ${DECIMALS} decimals, ${args.supply} supply)  ${mintNote}
  pool         ${addrs(mint).pool.toBase58()}  all ${args.supply} tokens, virtual seed ${sol(virtualSol)} (no SOL goes in), ${FEE_BPS / 100}% sell fee, ${BUY_FEE_BPS / 100}% buy fee
  payout       ${payout.toBase58()}  holds ${payoutBal === null ? "?" : sol(payoutBal)} (needs ${sol(PAYOUT_MIN)})
  team buy     ${teamBuy ? `${sol(teamBuy)} by the creator, in the pool's own transaction if it fits` : "none"}
  then         mint authority and transfer-hook authority revoked: no more tokens, and the hook can't be switched off
  left open    token metadata and its pointer stay with the creator (rename or revoke later)${preview ? `
  sends        ${preview.length ? preview.map((g, i) => `tx ${i + 1}: ${g.names.join(", ")}`).join("\n               ") : "nothing, everything exists already"}` : ""}
`);
  if (problems.length) { console.error(problems.map((p) => "REFUSING: " + p).join("\n")); process.exitCode = 1; return; }
  if (!GO) return;

  // Save the mint key before anything is sent, and read it back.
  mkdirSync(keysDir, { recursive: true });
  if (fresh) {
    const f = join(keysDir, `mint-${mint.toBase58()}.json`);
    writeFileSync(f, JSON.stringify([...mintKp.secretKey]), { flag: "wx", mode: 0o600 });
    if (parseSecret(readFileSync(f, "utf8"))?.publicKey.toBase58() !== mint.toBase58()) fail(`The mint key didn't save properly to ${f}. Nothing was sent.`);
    console.log(`  mint key saved to ${f}`);
  }

  let sent = 0, expired = 0;
  for (;;) {
    await resolvePending(mint);
    state = await readState(mint);
    const groups = groupSteps(buildSteps(mint, state, rent).filter((s) => !s.done));
    if (!groups.length) break;
    if (sent >= maxTxs) { console.log(`Stopped after ${sent} transaction(s) (--max-txs). Run the same command to continue.`); return; }
    if (await sendGroup(mint, groups[0])) { sent++; expired = 0; } else if (++expired >= 3) fail("The transaction expired three times. Check the RPC and run the same command again.");
  }

  const end = await readState(mint);
  if (!(end.poolExists && end.mintAuthorityNull && end.hookAuthorityNull && end.supply === supply && (teamBuy === 0n || end.ataBalance > 0n))) fail("The launch ended in an unexpected state. Read " + logFile(mint));
  console.log(`
Done, and checked on chain: the pool exists, the mint authority and the transfer-hook authority are gone.
Put these in wrangler.jsonc (and the creator ${creator.publicKey.toBase58()} in EXCLUDE):
  "MINT": "${mint.toBase58()}",
  "POOL_PROGRAM": "${POOL_PROGRAM.toBase58()}",
  "HOOK_PROGRAM": "${HOOK_PROGRAM.toBase58()}",
  "PAYOUT_WALLET": "${payout.toBase58()}"
`);
}

try { await main(); } catch (e) { if (!(e instanceof Exit)) { console.error(e instanceof Refuse ? "REFUSING: " + e.message : e.stack || String(e)); process.exitCode = 1; } }
