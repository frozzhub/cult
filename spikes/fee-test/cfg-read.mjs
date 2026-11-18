import { Connection, PublicKey } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const client = new DynamicBondingCurveClient(conn, "confirmed");
const cfg = await client.state.getPoolConfig("25yysRWpscFw6RMeTwFL78duEWgnB6oxAbr8mzq17yZZ");
const show = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !/padding|curve|reserved/i.test(k)).map(([k, v]) => [k, v?.toBase58 ? v.toBase58() : v?.toString && typeof v === "object" && !Array.isArray(v) && v.constructor?.name === "BN" ? v.toString() : v]));
console.log(show(cfg));
const pool = await client.state.getPool("8TDrWn1UhLUz1F6zvpN7aHCAFkWabr8avZp1rEx1Rsu5");
console.log(Object.keys(pool), show(pool.poolState ?? pool));
