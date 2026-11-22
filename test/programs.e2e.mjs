// Programs end to end on a real local validator, including the launch script and the Worker's trade API.
// Run: node --test test/programs.e2e.mjs (after npm run build:programs). On Windows, solana-test-validator
// needs Developer Mode (it creates symlinks); otherwise use npm run test:programs (LiteSVM, no validator).
// Starts solana-test-validator with both programs loaded, then:
//   launch script (mint + hook + pool + revoke) -> buy through the Worker's /api/trade -> sell ->
//   15% of the sell lands in the payout wallet -> wallet-to-wallet works -> sending to another "pool" fails.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedWithTransferHookInstruction, getAccount, getMint } from "@solana/spl-token";
import worker from "../src/index.js";

const POOL_PROGRAM = "5xsG4XWGVdazEZSDkjFWu25gCyeCnTuxuPxbmJ1xmA4D";
const HOOK_PROGRAM = "521AkYhN31VTGPLn75NgeWievYHZoxPwREihCCsppxnF";
const BIN = process.env.SOLANA_BIN || join(homedir(), "solana", "v4.3.2", "solana-release", "bin");
const RPC = process.env.E2E_RPC || "http://127.0.0.1:8899"; // E2E_RPC: a validator already running with both programs loaded (see programs-tests/rehearse.mjs)
const TMP = ".wrangler/e2e";
const conn = new Connection(RPC, "confirmed");
let validator, env, mint;

const creator = Keypair.generate(), payout = Keypair.generate(), buyer = Keypair.generate(), friend = Keypair.generate();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fund = async (pk, sol) => { const s = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL); await conn.confirmTransaction(s, "confirmed"); };
const lamports = (pk) => conn.getBalance(pk, "confirmed");
const ata = (owner) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);

before(async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  if (!process.env.E2E_RPC) validator = spawn(join(BIN, "solana-test-validator.exe"), [
    "--reset", "--quiet", "--ledger", join(TMP, "ledger"),
    "--bpf-program", HOOK_PROGRAM, "target/deploy/paper_hook.so",
    "--bpf-program", POOL_PROGRAM, "target/deploy/paper_pool.so",
  ], { stdio: "ignore" });
  for (let i = 0; i < 120; i++) { try { await conn.getLatestBlockhash(); break; } catch { await wait(1000); } }
  await Promise.all([fund(creator.publicKey, 100), fund(payout.publicKey, 1), fund(buyer.publicKey, 50), fund(friend.publicKey, 1)]);

  const kpFile = join(TMP, "creator.json");
  writeFileSync(kpFile, JSON.stringify([...creator.secretKey]));
  const out = execFileSync(process.execPath, ["scripts/launch.mjs", "--keypair", kpFile, "--payout", payout.publicKey.toBase58(), "--virtual", "20", "--keys-dir", join(TMP, "keys"),
    "--supply", "1000000000", "--name", "Paper Hands", "--symbol", "PAPER", "--uri", "https://example.com/m.json", "--rpc", RPC, "--go"], { encoding: "utf8" });
  console.log(out);
  mint = new PublicKey(out.match(/"MINT": "([1-9A-HJ-NP-Za-km-z]+)"/)[1]);
  // The launch is one transaction now and the Worker reads at finalized: wait for the pool to get there.
  const finalized = new Connection(RPC, "finalized");
  const poolPda = PublicKey.findProgramAddressSync([Buffer.from("pool"), mint.toBytes()], new PublicKey(POOL_PROGRAM))[0];
  for (let i = 0; i < 120 && !(await finalized.getAccountInfo(poolPda)); i++) await wait(500);
  env = { DEMO: "0", MINT: mint.toBase58(), POOL_PROGRAM, HOOK_PROGRAM, PAYOUT_WALLET: payout.publicKey.toBase58(), SOLANA_RPC_URL: RPC, ASSETS: { fetch: () => new Response("") } };
});
after(() => validator?.kill());

const call = async (p, body) => (await worker.fetch(new Request("http://x" + p, body ? { method: "POST", body: JSON.stringify(body) } : {}), env)).json();

// What the site does: build on the Worker, sign in the "wallet", relay through the Worker, wait.
async function trade(kp, side, amount) {
  const prep = await call("/api/trade", { wallet: kp.publicKey.toBase58(), side, amount: String(amount), slippageBps: 100 });
  assert.ok(prep.transaction, JSON.stringify(prep));
  const tx = VersionedTransaction.deserialize(Buffer.from(prep.transaction, "base64"));
  tx.sign([kp]);
  const sent = await call("/api/send", { signed: Buffer.from(tx.serialize()).toString("base64") });
  assert.ok(sent.signature, JSON.stringify(sent));
  for (let i = 0; i < 40; i++) {
    const st = await call("/api/tx/" + sent.signature);
    if (st.status === "confirmed") return prep;
    assert.notEqual(st.status, "failed", "trade failed on-chain");
    await wait(500);
  }
  throw new Error("trade never confirmed");
}

test("launch: supply is all in the pool and minting is off for good", async () => {
  const m = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  assert.equal(m.mintAuthority, null);
  const p = await call("/api/pool");
  assert.equal(p.tokenReserve, (1_000_000_000n * 1_000_000n).toString());
  assert.equal(p.solReserve, String(20 * LAMPORTS_PER_SOL));
  assert.equal(p.feeBps, 1500);
});

test("buy: no fee, tokens arrive", async () => {
  const payoutBefore = await lamports(payout.publicKey);
  const prep = await trade(buyer, "buy", 2 * LAMPORTS_PER_SOL);
  const acct = await getAccount(conn, ata(buyer.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID);
  assert.equal(acct.amount.toString(), prep.out);
  assert.equal(await lamports(payout.publicKey), payoutBefore, "buys pay no fee");
});

test("sell: 15% of the SOL goes to the payout wallet", async () => {
  const held = (await getAccount(conn, ata(buyer.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  const half = held / 2n;
  const p = await call("/api/pool");
  const gross = (half * BigInt(p.solReserve)) / (BigInt(p.tokenReserve) + half);
  const fee = (gross * 1500n) / 10_000n;
  const payoutBefore = await lamports(payout.publicKey);
  const prep = await trade(buyer, "sell", half);
  assert.equal(BigInt(prep.out), gross - fee);
  assert.equal(BigInt(await lamports(payout.publicKey)) - BigInt(payoutBefore), fee);
});

test("hook: wallet to wallet works, sending into another program's account doesn't", async () => {
  const send = (toOwner, amount) => createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, ata(toOwner), toOwner, mint, TOKEN_2022_PROGRAM_ID);
  const xfer = (toOwner, amount) => createTransferCheckedWithTransferHookInstruction(conn, ata(buyer.publicKey), mint, ata(toOwner), buyer.publicKey, amount, 6, [], "confirmed", TOKEN_2022_PROGRAM_ID);

  await sendAndConfirmTransaction(conn, new Transaction().add(send(friend.publicKey), await xfer(friend.publicKey, 1_000_000n)), [buyer]);
  assert.equal((await getAccount(conn, ata(friend.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID)).amount, 1_000_000n);

  // A "pool vault" owned by some other program's address (off the ed25519 curve).
  const fakePool = PublicKey.findProgramAddressSync([Buffer.from("pool")], new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"))[0];
  await assert.rejects(
    sendAndConfirmTransaction(conn, new Transaction().add(send(fakePool), await xfer(fakePool, 1_000_000n)), [buyer]),
    /custom program error|0x1771|OtherPool/i,
  );
});
