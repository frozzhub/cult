import { readFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
const KEYS = new URL("../../program-keys/mainnet/", import.meta.url);
const pub = (n) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL(n, KEYS), "utf8")))).publicKey;
for (const url of ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"]) {
  const c = new Connection(url, "confirmed");
  const t = Date.now();
  try {
    const [d, t2] = [pub("deployer.json"), pub("test-trader.json")];
    const [a, b] = await Promise.all([c.getBalance(d), c.getBalance(t2)]);
    console.log(url, "ok", Date.now() - t, "ms", "deployer", d.toBase58(), a / 1e9, "trader", t2.toBase58(), b / 1e9, "genesis", (await c.getGenesisHash()).slice(0, 6));
  } catch (e) { console.log(url, "FAIL", String(e.message).slice(0, 120)); }
}
