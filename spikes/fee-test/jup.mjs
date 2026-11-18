// One real swap through Jupiter's public API from the test trader: node jup.mjs buy <lamports> | sell <rawTokens>
import { readFileSync } from "node:fs";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
const S = { ...JSON.parse(readFileSync("state.json", "utf8")), ...(process.env.MINT ? { mint: process.env.MINT } : {}) }, SOL = "So11111111111111111111111111111111111111112";
const rpc = readFileSync(process.env.USERPROFILE + "/.coined-preview/prod.vars", "utf8").match(/^SOLANA_RPC_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, "").replace("devnet.helius", "mainnet.helius");
const conn = new Connection(rpc, "confirmed");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL("../../program-keys/mainnet/test-trader.json", import.meta.url), "utf8"))));
const [side, amount] = process.argv.slice(2);
const [i, o] = side === "buy" ? [SOL, S.mint] : [S.mint, SOL];
const q = await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${i}&outputMint=${o}&amount=${amount}&slippageBps=100`)).json();
if (!q.routePlan) throw new Error("no route: " + JSON.stringify(q));
const s = await (await fetch("https://lite-api.jup.ag/swap/v1/swap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteResponse: q, userPublicKey: kp.publicKey.toBase58(), dynamicComputeUnitLimit: true, prioritizationFeeLamports: 100000 }) })).json();
if (!s.swapTransaction) throw new Error("no tx: " + JSON.stringify(s));
const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, "base64")); tx.sign([kp]);
const sig = await conn.sendTransaction(tx, { skipPreflight: false });
const bh = await conn.getLatestBlockhash();
const r = await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
console.log(`jupiter ${side} at 1% slippage: quoted out ${q.outAmount} via ${q.routePlan.map((p) => p.swapInfo.label).join(" > ")}  ${r.value.err ? "FAILED " + JSON.stringify(r.value.err) : "ok"}  ${sig}`);
