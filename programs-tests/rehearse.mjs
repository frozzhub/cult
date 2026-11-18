// Full rehearsal of the launch on a LOCAL validator with throwaway keys (never mainnet keys):
//   solana-test-validator --reset --bpf-program <POOL_ID> target/deploy/paper_pool.so --bpf-program <HOOK_ID> target/deploy/paper_hook.so
//   node programs-tests/rehearse.mjs            (RPC=http://127.0.0.1:8899 by default)
// Runs scripts/launch.mjs for real (refusals, crash and resume at every step, the creator's key as a base58 file and as
// CREATOR_KEY), then buys, sells and wallet transfers, and checks the money and the authorities from the chain.
// Two launches: buy fee 0 (what ships), then buy fee 100 bps with a team buy in the pool's own transaction.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, AuthorityType, createAssociatedTokenAccountIdempotentInstruction,
  createSetAuthorityInstruction, createMintToInstruction, createUpdateTransferHookInstruction, createTransferCheckedWithTransferHookInstruction, getAccount, getAssociatedTokenAddressSync, getMint, getTransferHook,
} from "@solana/spl-token";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.RPC || "http://127.0.0.1:8899";
const POOL = new PublicKey("5xsG4XWGVdazEZSDkjFWu25gCyeCnTuxuPxbmJ1xmA4D");
const HOOK = new PublicKey("521AkYhN31VTGPLn75NgeWievYHZoxPwREihCCsppxnF");
const conn = new Connection(RPC, "confirmed");
const run = promisify(execFile);
const SUPPLY = 1_000_000_000n * 1_000_000n;
const SOL = BigInt(LAMPORTS_PER_SOL);
const enc = new TextEncoder();
const disc = (n) => createHash("sha256").update("global:" + n).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (bytes) => { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } return s; };
const bal = async (pk) => BigInt(await conn.getBalance(pk, "confirmed"));
const fund = async (pk, lamports) => { const s = await conn.requestAirdrop(pk, Number(lamports)); await conn.confirmTransaction(s, "confirmed"); };
const sigs = [];
const send = async (label, ixs, signers) => { const s = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" }); sigs.push([label, s]); return s; };
const t0 = Date.now();
const say = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

async function launch(extra, env = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [process.env.LAUNCH_SCRIPT || "scripts/launch.mjs", ...extra], { cwd: REPO, encoding: "utf8", env: { ...process.env, ...env } });
    return { code: 0, out: stdout + stderr };
  } catch (e) { return { code: e.code, out: (e.stdout || "") + (e.stderr || "") }; }
}

// Pool account: 8 disc | mint | vault | payout | fee_bps u16 @104 | sol_reserve u64 @106 | bump @114 | virtual_sol u64 @115 | buy_fee_bps u16 @123
const readPool = async (pool) => { const d = (await conn.getAccountInfo(pool, "confirmed")).data; return { feeBps: d.readUInt16LE(104), solReserve: d.readBigUInt64LE(106), virtualSol: d.readBigUInt64LE(115), buyFeeBps: d.readUInt16LE(123), len: d.length }; };

async function scenario({ name, buyFeeBps, teamBuySol, virtualSol, resume }) {
  say(`=== ${name}`);
  const keysDir = mkdtempSync(join(tmpdir(), "cult-rehearsal-keys-"));
  const creator = Keypair.generate(), payout = Keypair.generate(), buyer = Keypair.generate(), friend = Keypair.generate();
  const creatorFile = join(keysDir, "creator.b58"); // a Phantom-style base58 secret
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(creatorFile, b58(creator.secretKey));
  const base = ["--keypair", creatorFile, "--payout", payout.publicKey.toBase58(), "--supply", "1000000000", "--name", "Cult", "--symbol", "CULT", "--uri", "https://example.com/token.json",
    "--rpc", RPC, "--keys-dir", keysDir, "--virtual", String(virtualSol), "--buy-fee", String(buyFeeBps), ...(teamBuySol ? ["--team-buy", String(teamBuySol)] : [])];
  const mintFiles = () => readdirSync(keysDir).filter((f) => f.startsWith("mint-") && f.endsWith(".json"));

  // 1. Refusals before anything is sent (and nothing saved). Order of checks: payout wallet, then the creator's balance.
  const refused = async (pattern, why) => {
    const r = await launch([...base, "--go"]);
    assert.equal(r.code, 1, `${why}: ${r.out}`);
    assert.match(r.out, pattern, r.out);
    assert.equal(mintFiles().length, 0, "nothing saved by a refused launch: " + why);
  };
  await refused(/REFUSING: The payout wallet .* holds 0\.0000 SOL; it needs at least 0\.0600 SOL/, "payout empty");
  await fund(payout.publicKey, 59_000_000n);
  await refused(/REFUSING: The payout wallet .* holds 0\.0590 SOL/, "payout at 0.059");
  await fund(payout.publicKey, 1_000_000n);
  await refused(/REFUSING: The creator wallet .* holds 0\.0000 SOL; the steps left need about \d\.\d{4} SOL/, "creator empty");
  const teamLamports = BigInt(Math.round((teamBuySol || 0) * 1e9));
  await fund(creator.publicKey, 50_000_000n + teamLamports); // 0.05 SOL plus the team buy: all a launch needs
  say("refusals: payout empty, payout 0.059 SOL, creator empty -> nothing sent, nothing saved");
  // Both key options at once, and neither, are refused.
  const noKey = base.filter((x, i) => !(x === "--keypair" || base[i - 1] === "--keypair"));
  let r = await launch([...base, "--go"], { CREATOR_KEY: b58(creator.secretKey) });
  assert.equal(r.code, 1); assert.match(r.out, /Both --keypair and CREATOR_KEY/);
  r = await launch([...noKey, "--go"], { CREATOR_KEY: "" });
  assert.equal(r.code, 1); assert.match(r.out, /Give the creator's key/);
  r = await launch([...base, "--buy-fee", "501"]);
  assert.equal(r.code, 1); assert.match(r.out, /--buy-fee/);

  // 2. Dry run prints the plan and writes nothing.
  r = await launch(base);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`creator\\s+${creator.publicKey.toBase58()}`)); assert.match(r.out, /EXCLUDE/); assert.match(r.out, /dry run/);
  assert.ok(!r.out.includes(b58(creator.secretKey)), "the secret is never printed");
  assert.equal(mintFiles().length, 0, "a dry run saves no key");
  say("dry run ok:\n" + r.out.split("\n").map((l) => "    " + l).join("\n"));

  const withArg = (a, flag, v) => a.map((x, i) => (a[i - 1] === flag ? v : x));
  // 3. Crash and resume at every step: one transaction per step, stop after each, with a dead signature left behind once.
  const split = ["--split", "--max-txs", "1"];
  const steps = teamBuySol ? 7 : 6;
  let mint = null;
  if (!resume) {
    // The normal path: no splitting, as few transactions as fit.
    r = await launch([...base, "--go"]);
    assert.equal(r.code, 0, r.out);
    const txs = r.out.split("\n").filter((l) => /^ {2}done /.test(l));
    assert.ok(txs.length >= 1 && txs.length <= 2, "everything fits in one or two transactions: " + r.out);
    assert.match(r.out, /Done, and checked on chain/);
    mint = new PublicKey(mintFiles()[0].slice(5, -5));
    say(`launch sent in ${txs.length} transaction(s): ${txs.map((l) => l.trim()).join(" | ")}`);
    for (const l of txs) { // the chain's own count of compute units for it (every getTransaction passes maxSupportedTransactionVersion 1)
      const t = await conn.getTransaction(l.trim().split(/\s+/).pop(), { commitment: "confirmed", maxSupportedTransactionVersion: 1 });
      say(`  compute units used by that transaction: ${t.meta.computeUnitsConsumed} of the 1,400,000 a transaction may ask for`);
    }
  }
  for (let i = 1; resume && i <= steps; i++) {
    if (i === 3) { // an old signature that never landed: the next run must settle it from its status and carry on
      const m = readdirSync(keysDir).find((f) => f.startsWith("mint-")).slice(5, -5);
      writeFileSync(join(keysDir, `launch-${m}.pending.json`), JSON.stringify({ names: ["pretend"], sig: b58(Buffer.alloc(64, 7)), lastValidBlockHeight: 1 }));
    }
    // Step 4 gives the creator's key as CREATOR_KEY instead of a file: the same wallet either way.
    r = await launch(i === 4 ? [...noKey, "--go", ...split] : [...base, "--go", ...split], i === 4 ? { CREATOR_KEY: b58(creator.secretKey) } : {});
    assert.equal(r.code, 0, `step ${i}: ${r.out}`);
    assert.equal(mintFiles().length, 1, "a re-run never makes a second mint");
    if (i === 1) mint = new PublicKey(mintFiles()[0].slice(5, -5));
    if (i === 3) assert.match(r.out, /never landed/);
    say(`step ${i}: ${r.out.split("\n").filter((l) => /done|RESUMING|saved|Stopped/.test(l)).map((l) => l.trim()).join(" | ")}`);
    if (i === 1) { // after the first step only the mint exists, with both authorities still live
      const m = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
      assert.ok(m.mintAuthority, "mint authority live until the last steps");
      // Someone else's key on this unfinished mint: refused before anything is sent.
      const strangerFile = join(keysDir, "stranger.b58");
      writeFileSync(strangerFile, b58(Keypair.generate().secretKey));
      const before = readFileSync(join(keysDir, `launch-${mint}.log`), "utf8");
      r = await launch([...withArg(base, "--keypair", strangerFile), "--go", "--mint-keypair", join(keysDir, mintFiles()[0])]);
      assert.equal(r.code, 1, r.out); assert.match(r.out, /belongs to another creator/);
      assert.equal(readFileSync(join(keysDir, `launch-${mint}.log`), "utf8"), before, "nothing sent for a stranger");
    }
  }
  // 4. Everything done: a re-run refuses to start a second coin.
  r = await launch([...base, "--go"]);
  assert.equal(r.code, 1); assert.match(r.out, /already launched here, nothing was sent/);
  assert.equal(mintFiles().length, 1);
  // A finished launch's key given on purpose, but with other settings or another creator: refused, never "continued".
  const mintFile = join(keysDir, mintFiles()[0]);
  r = await launch([...withArg(base, "--virtual", String(virtualSol + 1)), "--go", "--mint-keypair", mintFile]);
  assert.equal(r.code, 1, r.out); assert.match(r.out, /already exists with different settings/);
  say("a finished launch is never repeated, and its key with other settings is refused");

  // 5. State from the chain.
  const pool = PublicKey.findProgramAddressSync([enc.encode("pool"), mint.toBytes()], POOL)[0];
  const metas = PublicKey.findProgramAddressSync([enc.encode("extra-account-metas"), mint.toBytes()], HOOK)[0];
  const vault = getAssociatedTokenAddressSync(mint, pool, true, TOKEN_2022_PROGRAM_ID);
  const ata = (o) => getAssociatedTokenAddressSync(mint, o, true, TOKEN_2022_PROGRAM_ID); // off-curve allowed: the fake pool is one
  const m = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  assert.equal(m.mintAuthority, null, "mint authority revoked");
  assert.equal(m.supply, SUPPLY);
  const hook = getTransferHook(m);
  assert.ok(hook.authority.equals(PublicKey.default), "transfer-hook authority revoked");
  assert.ok(hook.programId.equals(HOOK));
  const p = await readPool(pool);
  const vir = BigInt(virtualSol) * SOL;
  assert.equal(p.len, 125); assert.equal(p.feeBps, 1500); assert.equal(p.buyFeeBps, buyFeeBps); assert.equal(p.virtualSol, vir);
  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(125));
  const team = BigInt(Math.round((teamBuySol || 0) * 1e9));
  const teamFee = team * BigInt(buyFeeBps) / 10_000n, teamNet = team - teamFee;
  const teamOut = teamNet * SUPPLY / (vir + teamNet);
  assert.equal(p.solReserve, vir + teamNet, "curve = virtual seed + the team buy's net");
  assert.equal(await bal(pool), rent + teamNet, "the pool holds its rent and the team buy, and nothing else");
  assert.equal((await getAccount(conn, vault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount, SUPPLY - teamOut);
  assert.equal((await getAccount(conn, ata(creator.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID)).amount, teamOut, "the creator holds only what the team buy bought");
  say(`launched: mint ${mint.toBase58()} pool ${pool.toBase58()}  mint authority null, hook authority null, real SOL in pool ${(rent + teamNet) - rent} lamports`);

  // 6. The creator can no longer change the hook (UpdateTransferHook is refused) or mint.
  await assert.rejects(sendAndConfirmTransaction(conn, new Transaction().add(createUpdateTransferHookInstruction(mint, creator.publicKey, PublicKey.default, [], TOKEN_2022_PROGRAM_ID)), [creator]), /custom program error|Error processing|failed/i);
  await assert.rejects(sendAndConfirmTransaction(conn, new Transaction().add(createMintToInstruction(mint, ata(creator.publicKey), creator.publicKey, 1n, [], TOKEN_2022_PROGRAM_ID)), [creator]), /custom program error|Error processing|failed/i);
  await assert.rejects(sendAndConfirmTransaction(conn, new Transaction().add(createSetAuthorityInstruction(mint, creator.publicKey, AuthorityType.TransferHookProgramId, creator.publicKey, [], TOKEN_2022_PROGRAM_ID)), [creator]), /custom program error|Error processing|failed/i);
  say("creator can't mint, can't update the hook, can't take the hook authority back");

  // 7. Buy and sell through the pool program.
  await fund(buyer.publicKey, 20n * SOL); await fund(friend.publicKey, SOL);
  const poolIx = (user, name, a, minOut) => new TransactionInstruction({
    programId: POOL, data: Buffer.concat([disc(name), u64(a), u64(minOut)]),
    keys: [[user, true, true], [mint, false, false], [pool, false, true], [vault, false, true], [ata(user), false, true], [payout.publicKey, false, true],
      [TOKEN_2022_PROGRAM_ID, false, false], [ASSOCIATED_TOKEN_PROGRAM_ID, false, false], [SystemProgram.programId, false, false], [HOOK, false, false], [metas, false, false]]
      .map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable })),
  });
  const quote = (i, rin, rout) => (i * rout) / (rin + i);
  let st = await readPool(pool);
  let vtok = (await getAccount(conn, vault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  const payout0 = await bal(payout.publicKey);
  const buyIn = 2n * SOL + 7n, buyFee = buyIn * BigInt(buyFeeBps) / 10_000n, buyNet = buyIn - buyFee, out = quote(buyNet, st.solReserve, vtok);
  const buySig = await send("buy", [poolIx(buyer.publicKey, "buy", buyIn, out)], [buyer]);
  assert.equal((await getAccount(conn, ata(buyer.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID)).amount, out);
  assert.equal(await bal(payout.publicKey) - payout0, buyFee, buyFeeBps ? "the payout wallet got exactly the buy fee" : "buys pay no fee");
  st = await readPool(pool);
  assert.equal(await bal(pool), rent + st.solReserve - vir, "pool lamports = rent + curve - virtual");
  say(`buy ${buyIn} lamports -> ${out} tokens, buy fee ${buyFee} lamports to payout  ${buySig}`);

  vtok = (await getAccount(conn, vault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  const half = out / 2n, gross = quote(half, vtok, st.solReserve), fee = gross * 1500n / 10_000n;
  const payout1 = await bal(payout.publicKey), buyer1 = await bal(buyer.publicKey);
  const sellSig = await send("sell", [poolIx(buyer.publicKey, "sell", half, gross - fee)], [buyer]);
  assert.equal(await bal(payout.publicKey) - payout1, fee, "15% of the SOL goes to the payout wallet");
  assert.equal(await bal(buyer.publicKey) - buyer1 + 5000n, gross - fee, "the seller gets the other 85%");
  say(`sell ${half} tokens -> gross ${gross} lamports: ${gross - fee} to the seller, ${fee} (${(Number(fee) / Number(gross) * 100).toFixed(3)}%) to payout  ${sellSig}`);

  // 8. Sell everything back: the pool never runs short, real SOL left is never negative.
  const rest = (await getAccount(conn, ata(buyer.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  st = await readPool(pool); vtok = (await getAccount(conn, vault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  const g2 = quote(rest, vtok, st.solReserve);
  await send("sell rest", [poolIx(buyer.publicKey, "sell", rest, g2 - g2 * 1500n / 10_000n)], [buyer]);
  assert.equal((await getAccount(conn, ata(buyer.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID)).amount, 0n);
  assert.ok((await bal(pool)) >= rent, "pool keeps its rent");
  const end = await readPool(pool);
  assert.equal(await bal(pool), rent + end.solReserve - vir);
  say(`sold the rest back; real SOL left in pool ${end.solReserve - vir} lamports (the team buy's, if any)`);

  // 9. Hook: wallet to wallet fine, into a program-owned account refused.
  await send("buy2", [poolIx(buyer.publicKey, "buy", SOL, 1)], [buyer]);
  const xfer = (toOwner, to, amt) => createTransferCheckedWithTransferHookInstruction(conn, ata(buyer.publicKey), mint, to, buyer.publicKey, amt, 6, [], "confirmed", TOKEN_2022_PROGRAM_ID);
  await send("to friend", [createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, ata(friend.publicKey), friend.publicKey, mint, TOKEN_2022_PROGRAM_ID), await xfer(friend.publicKey, ata(friend.publicKey), 1_000_000n)], [buyer]);
  const fakePool = PublicKey.findProgramAddressSync([Buffer.from("pool")], new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"))[0];
  await assert.rejects(sendAndConfirmTransaction(conn, new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, ata(fakePool), fakePool, mint, TOKEN_2022_PROGRAM_ID), await xfer(fakePool, ata(fakePool), 1_000_000n)), [buyer]), /custom program error|0x1771|failed/i);
  say("hook: wallet to wallet ok, into another program's account refused");
  rmSync(keysDir, { recursive: true, force: true });
}

try { await conn.getLatestBlockhash(); } catch { console.error(`No validator at ${RPC}. Start solana-test-validator first (see the header).`); process.exit(2); }
await scenario({ name: "launch 1: buy fee 0 (the one that ships), virtual 30 SOL, no team buy", buyFeeBps: 0, teamBuySol: 0, virtualSol: 30, resume: true });
await scenario({ name: "launch 2: buy fee 100 bps, virtual 20 SOL, team buy 1.5 SOL in the pool's transaction", buyFeeBps: 100, teamBuySol: 1.5, virtualSol: 20, resume: false });
await scenario({ name: "launch 3: buy fee 100 bps, virtual 25 SOL, team buy 0.5 SOL, crash and resume at every step", buyFeeBps: 100, teamBuySol: 0.5, virtualSol: 25, resume: true });
console.log("\nTransaction signatures from the buy/sell steps (local validator):");
for (const [l, s] of sigs) console.log(`  ${l.padEnd(10)} ${s}`);
console.log("\nREHEARSAL PASSED");
