// Mainnet SIMULATION only (simulateTransaction, sigVerify off): sends nothing. The "authority" is the public key that holds
// the withdraw-withheld authority of both throwaway test mints; no secret is used, the signature is not checked.
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { buildFeeTx, parseTokenAccount, parseMint } from "../src/token22.js";
const F = JSON.parse(readFileSync("test/fixtures/accounts.json", "utf8"));
const AUTH = "KDpz3icbjmmib1DDeitywpk6ZdsQckHiqt6hKmKnnaq";
const kp = { publicKey: new PublicKey(AUTH), secretKey: new Uint8Array(64) };
const RPC = "https://api.mainnet-beta.solana.com";
const call = async (method, params) => { for (let i = 0; i < 6; i++) { const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const j = await r.json(); if (!j.error) return j.result; if (!/rate|429|many/i.test(JSON.stringify(j.error))) throw new Error(JSON.stringify(j.error)); await new Promise((r) => setTimeout(r, 1500 * (i + 1))); } throw new Error("rate limited"); };
const bh = (await call("getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash;
const sim = async (label, tx, accounts) => {
  const r = (await call("simulateTransaction", [Buffer.from(tx.serialize()).toString("base64"), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: accounts } }])).value;
  console.log(label, "err:", JSON.stringify(r.err), "units:", r.unitsConsumed, "size:", tx.serialize().length);
  if (r.err) console.log((r.logs || []).slice(-6).join("\n"));
  return r;
};
const read = (r, i) => { const a = r.accounts[i]; return a ? parseTokenAccount(new Uint8Array(Buffer.from(a.data[0], "base64"))) : null; };

// 1. refund of a real buyer's never-refunded withheld tokens (TTEST, DAMM test buyer)
const buyer = F.buyerDamm.address, mintD = F.mintDamm.address;
const before = parseTokenAccount(new Uint8Array(Buffer.from(F.buyerDamm.data, "base64")));
let r = await sim("refund x1 (real buyer)", buildFeeTx(kp, bh, { kind: "refund", mint: mintD, accounts: [buyer] }), [buyer]);
const after = read(r, 0);
console.log("  amount", before.amount, "->", after?.amount, " withheld", before.withheld, "->", after?.withheld, " refunded exactly:", after && after.amount - before.amount === before.withheld);
r = await sim("refund x18 (same account 18 times)", buildFeeTx(kp, bh, { kind: "refund", mint: mintD, accounts: Array(18).fill(buyer) }), [buyer]);
r = await sim("refund x23", buildFeeTx(kp, bh, { kind: "refund", mint: mintD, accounts: Array(23).fill(buyer) }), [buyer]);

// 2. sweep of the real pool vault (TCURVE, DBC vault) into the treasury account of the authority (created in the same transaction)
const mintC = F.mintDbc.address, vault = F.vaultDbc.address;
const vBefore = parseTokenAccount(new Uint8Array(Buffer.from(F.vaultDbc.data, "base64")));
const { treasuryAta } = await import("../src/token22.js");
const tre = treasuryAta(mintC, AUTH).toBase58();
r = await sim("sweep x1 (real DBC vault)", buildFeeTx(kp, bh, { kind: "sweep", mint: mintC, accounts: [vault] }), [vault, tre]);
console.log("  vault withheld", vBefore.withheld, "->", read(r, 0)?.withheld, " treasury amount ->", read(r, 1)?.amount, " swept exactly:", read(r, 1)?.amount === vBefore.withheld);
r = await sim("sweep x18 (same vault 18 times)", buildFeeTx(kp, bh, { kind: "sweep", mint: mintC, accounts: Array(18).fill(vault) }), [vault, tre]);
r = await sim("mint sweep (nothing in the mint)", buildFeeTx(kp, bh, { kind: "mint", mint: mintC }), [tre]);
void parseMint;
