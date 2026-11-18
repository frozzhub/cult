// Scratch, read only: SOL and token balance changes of the claim transactions (what did the fee wallet actually receive).
import { Connection } from "@solana/web3.js";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const FEE = "HrEKXpJvACWNxQJgQGhqNmJgQpwgC6kjtPD4dyDK2AH5";
const sigs = process.argv.slice(2);
for (const sig of sigs) {
  await new Promise((r) => setTimeout(r, 1500));
  const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 1 });
  if (!t) { console.log(sig.slice(0, 8), "not found"); continue; }
  const keys = t.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta.loadedAddresses }).keySegments().flat().map((k) => k.toBase58());
  const i = keys.indexOf(FEE);
  console.log(sig.slice(0, 8), "fee", t.meta.fee, "feeWallet lamports", t.meta.preBalances[i], "->", t.meta.postBalances[i], "delta", t.meta.postBalances[i] - t.meta.preBalances[i]);
  const rows = keys.map((k, n) => [k.slice(0, 6), t.meta.postBalances[n] - t.meta.preBalances[n]]).filter(([, d]) => d !== 0);
  console.log("  lamport changes:", JSON.stringify(rows));
  const tb = (a) => (a ?? []).map((x) => `${x.owner?.slice(0, 6)}:${x.mint.slice(0, 6)}:${x.uiTokenAmount.amount}`);
  console.log("  token pre ", tb(t.meta.preTokenBalances).join(" "));
  console.log("  token post", tb(t.meta.postTokenBalances).join(" "));
}
