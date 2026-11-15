// Update the token's on-chain name / symbol / uri (Token-2022 metadata). Needs the metadata update authority.
//   node scripts/rename-token.mjs --mint <MINT> --keypair <authority.json> --name Cult --symbol CULT [--uri URL] [--rpc URL]
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getTokenMetadata } from "@solana/spl-token";
import { createUpdateFieldInstruction, pack } from "@solana/spl-token-metadata";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const conn = new Connection(args.rpc || "https://api.devnet.solana.com", "confirmed");
const auth = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(args.keypair, "utf8"))));
const mint = new PublicKey(args.mint);

const before = await getTokenMetadata(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
console.log("before:", before.name, before.symbol, before.uri);
const next = { ...before, name: args.name ?? before.name, symbol: args.symbol ?? before.symbol, uri: args.uri ?? before.uri };

// Longer metadata needs more rent on the mint account; top it up first if so.
const acct = await conn.getAccountInfo(mint);
const grow = Math.max(0, pack(next).length - pack(before).length);
const ixs = [];
if (grow) {
  const need = (await conn.getMinimumBalanceForRentExemption(acct.data.length + grow)) - acct.lamports;
  if (need > 0) ixs.push(SystemProgram.transfer({ fromPubkey: auth.publicKey, toPubkey: mint, lamports: need }));
}
for (const field of ["name", "symbol", "uri"]) {
  if (next[field] !== before[field]) ixs.push(createUpdateFieldInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: mint, updateAuthority: auth.publicKey, field, value: next[field] }));
}
if (ixs.length) console.log("tx:", await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [auth]));
const after = await getTokenMetadata(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
console.log("after: ", after.name, after.symbol, after.uri);
