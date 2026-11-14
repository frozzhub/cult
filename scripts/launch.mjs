// One-time launch: create the $PAPER Token-2022 mint (transfer hook + on-chain metadata), mint the
// supply, set up the hook, seed the pool, then revoke mint authority for good.
//
//   node scripts/launch.mjs --keypair ~/.config/solana/id.json --payout <PAYOUT_WALLET> \
//     --sol 20 --supply 1000000000 --name "Paper Hands" --symbol PAPER --uri https://.../meta.json [--rpc URL] [--go]
//
// Without --go it only prints the plan. NOT RUN YET: test on devnet first, after the programs are built
// and deployed (their ids must match POOL_PROGRAM / HOOK_PROGRAM below).
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, ExtensionType, getMintLen, getAssociatedTokenAddressSync,
  createInitializeMintInstruction, createInitializeTransferHookInstruction, createInitializeMetadataPointerInstruction,
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, createSetAuthorityInstruction, AuthorityType,
  TYPE_SIZE, LENGTH_SIZE,
} from "@solana/spl-token";
import { createInitializeInstruction as createInitMetadata, pack as packMetadata } from "@solana/spl-token-metadata";

const POOL_PROGRAM = new PublicKey("J6zYGwRTLX17ms2dDZ6yGXP21xfigBwLKvYXho2Aw9Bu");
const HOOK_PROGRAM = new PublicKey("794MkqjE5VxXMVX9pJFK9D6YeK9pKp59K5BkBULfnSG2");
const DECIMALS = 6;
const FEE_BPS = 1500;

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]]] : a), []));
const need = (k) => { if (!args[k]) { console.error(`Missing --${k}`); process.exit(1); } return args[k]; };

const creator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(String(args.keypair || "~/.config/solana/id.json").replace("~", homedir()), "utf8"))));
const payout = new PublicKey(need("payout"));
const sol = Number(need("sol"));
const supply = BigInt(need("supply")) * 10n ** BigInt(DECIMALS);
const meta = { name: need("name"), symbol: need("symbol"), uri: need("uri") };
const conn = new Connection(args.rpc || "https://api.devnet.solana.com", "confirmed");
const mint = Keypair.generate();
const enc = new TextEncoder();
const disc = (name) => createHash("sha256").update("global:" + name).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };

const pool = PublicKey.findProgramAddressSync([enc.encode("pool"), mint.publicKey.toBytes()], POOL_PROGRAM)[0];
const metas = PublicKey.findProgramAddressSync([enc.encode("extra-account-metas"), mint.publicKey.toBytes()], HOOK_PROGRAM)[0];
const creatorAta = getAssociatedTokenAddressSync(mint.publicKey, creator.publicKey, false, TOKEN_2022_PROGRAM_ID);
const vault = getAssociatedTokenAddressSync(mint.publicKey, pool, true, TOKEN_2022_PROGRAM_ID);

console.log(`
Plan (${args.go ? "LIVE" : "dry run, add --go to send"}) on ${conn.rpcEndpoint}
  creator      ${creator.publicKey.toBase58()}
  mint         ${mint.publicKey.toBase58()}  (${meta.name} / $${meta.symbol}, ${DECIMALS} decimals, ${need("supply")} supply)
  pool         ${pool.toBase58()}  seeded with all tokens + ${sol} SOL, ${FEE_BPS / 100}% sell fee
  payout       ${payout.toBase58()}
  then         mint authority revoked (no more tokens can ever be minted)
`);
if (!args.go) process.exit(0);

const send = (label, ixs, signers = []) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [creator, ...signers]).then((s) => console.log(`✔ ${label}  ${s}`));

// 1. Mint with transfer hook + metadata pointer, then the metadata itself.
const extensions = [ExtensionType.TransferHook, ExtensionType.MetadataPointer];
const mintLen = getMintLen(extensions);
const metaLen = TYPE_SIZE + LENGTH_SIZE + packMetadata({ mint: mint.publicKey, updateAuthority: creator.publicKey, ...meta, additionalMetadata: [] }).length;
await send("mint created", [
  SystemProgram.createAccount({ fromPubkey: creator.publicKey, newAccountPubkey: mint.publicKey, space: mintLen, lamports: await conn.getMinimumBalanceForRentExemption(mintLen + metaLen), programId: TOKEN_2022_PROGRAM_ID }),
  createInitializeTransferHookInstruction(mint.publicKey, creator.publicKey, HOOK_PROGRAM, TOKEN_2022_PROGRAM_ID),
  createInitializeMetadataPointerInstruction(mint.publicKey, creator.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
  createInitializeMintInstruction(mint.publicKey, DECIMALS, creator.publicKey, null, TOKEN_2022_PROGRAM_ID),
  createInitMetadata({ programId: TOKEN_2022_PROGRAM_ID, metadata: mint.publicKey, updateAuthority: creator.publicKey, mint: mint.publicKey, mintAuthority: creator.publicKey, ...meta }),
], [mint]);

// 2. Hook's extra-account list (must exist before any transfer).
await send("hook set up", [new TransactionInstruction({
  programId: HOOK_PROGRAM, data: disc("initialize_extra_account_meta_list"),
  keys: [
    { pubkey: creator.publicKey, isSigner: true, isWritable: true },
    { pubkey: metas, isSigner: false, isWritable: true },
    { pubkey: mint.publicKey, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
})]);

// 3. Mint the whole supply to the creator.
await send("supply minted", [
  createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, creatorAta, creator.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
  createMintToInstruction(mint.publicKey, creatorAta, creator.publicKey, supply, [], TOKEN_2022_PROGRAM_ID),
]);

// 4. Create the pool with all of it plus the SOL side.
await send("pool seeded", [new TransactionInstruction({
  programId: POOL_PROGRAM, data: Buffer.concat([disc("initialize"), u16(FEE_BPS), u64(supply), u64(Math.round(sol * 1e9))]),
  keys: [
    { pubkey: creator.publicKey, isSigner: true, isWritable: true },
    { pubkey: mint.publicKey, isSigner: false, isWritable: false },
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: creatorAta, isSigner: false, isWritable: true },
    { pubkey: payout, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: HOOK_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: metas, isSigner: false, isWritable: false },
  ],
})]);

// 5. No more minting, ever.
await send("mint authority revoked", [createSetAuthorityInstruction(mint.publicKey, creator.publicKey, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID)]);

console.log(`
Done. Put these in wrangler.jsonc:
  "MINT": "${mint.publicKey.toBase58()}",
  "POOL_PROGRAM": "${POOL_PROGRAM.toBase58()}",
  "HOOK_PROGRAM": "${HOOK_PROGRAM.toBase58()}",
  "PAYOUT_WALLET": "${payout.toBase58()}"
`);
