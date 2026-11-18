// Scratch: rent of the accounts a DAMM v2 pool creation allocates, measured from the earlier throwaway pool.
import { readFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
const S = JSON.parse(readFileSync(new URL("./state.json", import.meta.url), "utf8"));
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const cp = new CpAmm(conn);
const ps = await cp.fetchPoolState(new PublicKey(S.pool));
const pos = await cp.getAllPositionsByPool(new PublicKey(S.pool));
const accs = { pool: S.pool, position: pos[0].publicKey.toBase58(), vA: ps.tokenAVault.toBase58(), vB: ps.tokenBVault.toBase58() };
const nft = pos[0].account.nftMint;
const { derivePositionNftAccount } = await import("@meteora-ag/cp-amm-sdk");
accs.nftMint = nft.toBase58(); accs.nftAcc = derivePositionNftAccount(nft).toBase58();
let total = 0;
for (const [k, v] of Object.entries(accs)) {
  const a = await conn.getAccountInfo(new PublicKey(v));
  const r = await conn.getMinimumBalanceForRentExemption(a.data.length);
  total += r; console.log(k, a.data.length, "bytes", (r / 1e9).toFixed(5), "SOL");
}
console.log("sum", (total / 1e9).toFixed(5), "SOL");
