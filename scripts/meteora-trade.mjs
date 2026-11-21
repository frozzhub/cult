// Devnet helper: buy or sell $CULT on its Meteora bonding curve, like a terminal would.
//   node scripts/meteora-trade.mjs --keypair program-keys/devnet-trader.json --buy 0.05
//   node scripts/meteora-trade.mjs --keypair program-keys/devnet-trader.json --sell 50      (percent of the bag)
//   node scripts/meteora-trade.mjs --keypair ... --buy 0.05 --fill                         (fill the rest of the curve)
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";

const args = Object.fromEntries(process.argv.slice(2).join(" ").split("--").filter(Boolean).map((a) => { const [k, ...v] = a.trim().split(/\s+/); return [k, v.join(" ") || true]; }));
const cluster = args.cluster === "mainnet" ? "mainnet" : "devnet";
const launch = JSON.parse(readFileSync(`program-keys/${cluster}-meteora.json`, "utf8"));
const connection = new Connection(args.rpc || process.env.RPC || "https://api.devnet.solana.com", "confirmed");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(args.keypair, "utf8"))));
const client = new DynamicBondingCurveClient(connection, "confirmed");
const pool = new PublicKey(launch.POOL_ACCOUNT);

let amountIn, swapBaseForQuote;
if (args.buy) { amountIn = new BN(Math.round(Number(args.buy) * 1e9)); swapBaseForQuote = false; }
else if (args.sell) {
  const ata = getAssociatedTokenAddressSync(new PublicKey(launch.MINT), kp.publicKey);
  const bal = BigInt((await connection.getTokenAccountBalance(ata)).value.amount);
  amountIn = new BN(((bal * BigInt(Math.round(Number(args.sell) * 100))) / 10000n).toString()); swapBaseForQuote = true;
} else { console.error("--buy <SOL> or --sell <percent>"); process.exit(1); }

// --fill: buy whatever is left on the curve (partial fill), which completes it and triggers graduation.
const tx = args.fill ? await client.pool.swap2({ owner: kp.publicKey, pool, amountIn, minimumAmountOut: new BN(0), swapBaseForQuote, referralTokenAccount: null, swapMode: SwapMode.PartialFill })
  : await client.pool.swap({ owner: kp.publicKey, pool, amountIn, minimumAmountOut: new BN(0), swapBaseForQuote, referralTokenAccount: null });
const sig = await sendAndConfirmTransaction(connection, tx, [kp], { commitment: "confirmed" });
console.log(args.buy ? "bought" : "sold", sig);
