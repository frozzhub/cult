import { Connection, PublicKey } from "@solana/web3.js";
import { DAMM_V2_MIGRATION_FEE_ADDRESS, DYNAMIC_BONDING_CURVE_PROGRAM_ID, DAMM_V2_PROGRAM_ID } from "@meteora-ag/dynamic-bonding-curve-sdk";
console.log("DBC", DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58(), "DAMM", DAMM_V2_PROGRAM_ID.toBase58());
console.log(DAMM_V2_MIGRATION_FEE_ADDRESS.map((a, i) => i + ":" + a.toBase58()).join("\n"));
for (const [n, url] of [["mainnet", "https://api.mainnet-beta.solana.com"], ["devnet", "https://api.devnet.solana.com"]]) {
  const c = new Connection(url, "confirmed");
  const infos = await c.getMultipleAccountsInfo([DYNAMIC_BONDING_CURVE_PROGRAM_ID, DAMM_V2_PROGRAM_ID, DAMM_V2_MIGRATION_FEE_ADDRESS[6]]);
  console.log(n, "dbc exec", infos[0]?.executable, "damm exec", infos[1]?.executable, "cfg6 exists", !!infos[2], infos[2]?.owner.toBase58());
}
