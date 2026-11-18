// Scratch, read only: run grossGain on the three real claim transactions of the rehearsal.
import { Connection } from "@solana/web3.js";
import { grossGain } from "../../scripts/fee-ops.mjs";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
for (const sig of process.argv.slice(2)) {
  await new Promise((r) => setTimeout(r, 1500));
  const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 1 });
  const payer = t.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta.loadedAddresses }).get(0);
  console.log(sig.slice(0, 8), "gross gain of the fee payer:", String(await grossGain(conn, sig, payer)), "lamports");
}
