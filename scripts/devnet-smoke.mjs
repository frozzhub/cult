// Devnet smoke test through the Worker's trade API (what the site's Buy/Sell panel does):
// fund a trader from the deployer, buy, sell half, check the 15% reached the payout wallet.
//   node scripts/devnet-smoke.mjs <MINT>            (Worker code in-process)
//   BASE=https://<site> node scripts/devnet-smoke.mjs <MINT>   (the deployed site)
import { readFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import worker from "../src/index.js";

const RPC = "https://api.devnet.solana.com";
const key = (n) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`program-keys/${n}.json`, "utf8"))));
const deployer = key("devnet-deployer"), trader = key("devnet-trader"), payout = key("devnet-payout");
const mint = new PublicKey(process.argv[2]);
const conn = new Connection(RPC, "confirmed");
const env = {
  DEMO: "0", MINT: mint.toBase58(), SOLANA_RPC_URL: RPC, PAYOUT_WALLET: payout.publicKey.toBase58(),
  POOL_PROGRAM: "J6zYGwRTLX17ms2dDZ6yGXP21xfigBwLKvYXho2Aw9Bu", HOOK_PROGRAM: "794MkqjE5VxXMVX9pJFK9D6YeK9pKp59K5BkBULfnSG2",
  ASSETS: { fetch: () => new Response("") },
};
// BASE=https://... runs against the deployed site instead of the Worker code in-process.
const call = async (p, body) => {
  const init = body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {};
  return (await (process.env.BASE ? fetch(process.env.BASE + p, init) : worker.fetch(new Request("http://x" + p, init), env))).json();
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tokens = async () => (await getAccount(conn, getAssociatedTokenAddressSync(mint, trader.publicKey, false, TOKEN_2022_PROGRAM_ID), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;

// What the page does when CLIENT_RPC is on: read pool/vault/mint and a blockhash from the public RPC itself.
async function clientRead() {
  const st = await call("/api/state");
  const accts = await conn.getMultipleAccountsInfo([st.accounts.pool, st.accounts.vault, st.mint].map((a) => new PublicKey(a)));
  const [p, v] = accts.map((a) => a.data);
  return {
    pool: { solReserve: p.readBigUInt64LE(106).toString(), tokenReserve: v.readBigUInt64LE(64).toString(), feeBps: p.readUInt16LE(104) },
    blockhash: (await conn.getLatestBlockhash()).blockhash,
  };
}

async function trade(side, amount) {
  if (process.env.BASE) {
    const prep = await call("/api/trade", { wallet: trader.publicKey.toBase58(), side, amount: String(amount), slippageBps: 100, ...(await clientRead()) });
    if (!prep.transaction) throw new Error(JSON.stringify(prep));
    const tx = VersionedTransaction.deserialize(Buffer.from(prep.transaction, "base64"));
    tx.sign([trader]);
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(sig, "confirmed");
    const st = await conn.getSignatureStatus(sig);
    if (st.value?.err) throw new Error("failed on-chain: " + sig);
    return { ...prep, sig };
  }
  const prep = await call("/api/trade", { wallet: trader.publicKey.toBase58(), side, amount: String(amount), slippageBps: 100 });
  if (!prep.transaction) throw new Error(JSON.stringify(prep));
  const tx = VersionedTransaction.deserialize(Buffer.from(prep.transaction, "base64"));
  tx.sign([trader]);
  const sent = await call("/api/send", { signed: Buffer.from(tx.serialize()).toString("base64") });
  if (!sent.signature) throw new Error(JSON.stringify(sent));
  for (let i = 0; i < 60; i++) {
    const st = await call("/api/tx/" + sent.signature);
    if (st.status === "confirmed") return { ...prep, sig: sent.signature };
    if (st.status === "failed") throw new Error("failed on-chain: " + sent.signature);
    await wait(1000);
  }
  throw new Error("not confirmed: " + sent.signature);
}

if ((await conn.getBalance(trader.publicKey)) < 0.3 * LAMPORTS_PER_SOL) {
  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: trader.publicKey, lamports: 0.5 * LAMPORTS_PER_SOL })), [deployer]);
}
if (!process.env.BASE) console.log("pool", await call("/api/pool"));

const payout0 = await conn.getBalance(payout.publicKey, "confirmed");
const buy = await trade("buy", 0.2 * LAMPORTS_PER_SOL);
const held = await tokens();
console.log(`buy  ${buy.sig}\n     got ${held} raw $PAPER (quoted ${buy.out}); payout change ${(await conn.getBalance(payout.publicKey, "confirmed")) - payout0}`);

const sell = await trade("sell", held / 2n);
const fee = (await conn.getBalance(payout.publicKey, "confirmed")) - payout0;
const gross = BigInt(sell.out) * 10_000n / 8_500n;
console.log(`sell ${sell.sig}\n     net quoted ${sell.out} lamports; payout got ${fee} lamports (${(Number(fee) / Number(gross) * 100).toFixed(2)}% of gross)`);
