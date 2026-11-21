// Devnet helper: trade $CULT on its DAMM v2 pool (after graduation), and show the pool's fee + who owns the liquidity.
//   node scripts/damm-trade.mjs --keypair program-keys/devnet-trader.json --buy 0.01 | --sell 20 | --info
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { CpAmm, getTokenProgram } from "@meteora-ag/cp-amm-sdk";
const args = Object.fromEntries(process.argv.slice(2).join(" ").split("--").filter(Boolean).map((a) => { const [k, ...v] = a.trim().split(/\s+/); return [k, v.join(" ") || true]; }));
const launch = JSON.parse(readFileSync("program-keys/devnet-meteora.json", "utf8"));
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const cp = new CpAmm(connection);
const MINT = new PublicKey(launch.MINT), SOL = new PublicKey("So11111111111111111111111111111111111111112");
const [found] = (await cp.fetchPoolStatesByTokenAMint(MINT)).filter((p) => p.account.tokenBMint.equals(SOL));
const pool = found.publicKey, ps = found.account;
if (args.info) {
  const fees = await cp.fetchPoolFees(pool).catch(() => null);
  console.log("pool", pool.toBase58(), "collectFeeMode", ps.collectFeeMode, "fees", JSON.stringify(fees, (k, v) => (v?.constructor?.name === "BN" ? v.toString() : v)).slice(0, 300));
  for (const p of await cp.getAllPositionsByPool(pool)) {
    const s = p.account; console.log("position", p.publicKey.toBase58(), "unlocked", String(s.unlockedLiquidity), "permanentLocked", String(s.permanentLockedLiquidity));
  }
  console.log("treasury positions", (await cp.getUserPositionByPool(pool, new PublicKey(launch.PAYOUT_WALLET))).length);
  process.exit(0);
}
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(args.keypair, "utf8"))));
let amountIn, input, output;
if (args.buy) { amountIn = new BN(Math.round(Number(args.buy) * 1e9)); input = SOL; output = MINT; }
else { const bal = BigInt((await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(MINT, kp.publicKey))).value.amount); amountIn = new BN(((bal * BigInt(Math.round(Number(args.sell) * 100))) / 10000n).toString()); input = MINT; output = SOL; }
const tx = await cp.swap({ payer: kp.publicKey, pool, inputTokenMint: input, outputTokenMint: output, amountIn, minimumAmountOut: new BN(0),
  tokenAMint: ps.tokenAMint, tokenBMint: ps.tokenBMint, tokenAVault: ps.tokenAVault, tokenBVault: ps.tokenBVault,
  tokenAProgram: getTokenProgram(ps.tokenAFlag), tokenBProgram: getTokenProgram(ps.tokenBFlag), referralTokenAccount: null, poolState: ps });
console.log(args.buy ? "bought" : "sold", await sendAndConfirmTransaction(connection, tx, [kp], { commitment: "confirmed" }));
