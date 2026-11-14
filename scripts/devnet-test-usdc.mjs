// Devnet stand-in for USDC: a classic SPL token with 6 decimals (same as USDC), minted to the payout wallet
// so the airdrop engine can do real payouts on devnet without Jupiter. Run again to top it up.
//   node scripts/devnet-test-usdc.mjs [amount=50]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const key = (n) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`program-keys/${n}.json`, "utf8"))));
const deployer = key("devnet-deployer"), payout = key("devnet-payout");
const file = "program-keys/devnet-test-usdc.txt";
const amount = Number(process.argv[2] || 50);

let mint;
if (existsSync(file)) mint = new PublicKey(readFileSync(file, "utf8").trim());
else {
  mint = await createMint(conn, deployer, deployer.publicKey, null, 6, undefined, { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
  writeFileSync(file, mint.toBase58());
  console.log("created test USDC mint", mint.toBase58());
}
const ata = await getOrCreateAssociatedTokenAccount(conn, deployer, mint, payout.publicKey);
await mintTo(conn, deployer, mint, ata.address, deployer, BigInt(Math.round(amount * 1e6)));
// The payout wallet pays rent for new holders' token accounts + tx fees; keep it at >= 0.15 SOL.
const bal = await conn.getBalance(payout.publicKey);
if (bal < 0.15 * LAMPORTS_PER_SOL) await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: payout.publicKey, lamports: 0.15 * LAMPORTS_PER_SOL - bal })), [deployer]);
const tok = await conn.getTokenAccountBalance(ata.address);
console.log(`payout ${payout.publicKey.toBase58()} holds ${tok.value.uiAmountString} test USDC and ${(await conn.getBalance(payout.publicKey)) / LAMPORTS_PER_SOL} SOL`);