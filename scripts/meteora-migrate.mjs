// Devnet only: graduate the curve to DAMM v2 by hand (on mainnet Meteora's keeper does this automatically).
//   node scripts/meteora-migrate.mjs --keypair program-keys/devnet-deployer.json
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { DynamicBondingCurveClient, DAMM_V2_MIGRATION_FEE_ADDRESS } from "@meteora-ag/dynamic-bonding-curve-sdk";
const args = Object.fromEntries(process.argv.slice(2).join(" ").split("--").filter(Boolean).map((a) => { const [k, ...v] = a.trim().split(/\s+/); return [k, v.join(" ") || true]; }));
const launch = JSON.parse(readFileSync("program-keys/devnet-meteora.json", "utf8"));
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(args.keypair, "utf8"))));
const client = new DynamicBondingCurveClient(connection, "confirmed");
const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await client.migration.migrateToDammV2({
  payer: payer.publicKey, pool: new PublicKey(launch.POOL_ACCOUNT), dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[6],
});
const sig = await sendAndConfirmTransaction(connection, transaction, [payer, firstPositionNftKeypair, secondPositionNftKeypair], { commitment: "confirmed" });
console.log("migrated", sig);
