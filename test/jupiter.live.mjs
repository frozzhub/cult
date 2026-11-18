// Real Jupiter answers (public lite-api, no key) for a SOL -> TCURVE buy: does inspect() accept the REAL swap-instructions, does the
// atomic refund fit in one transaction with Jupiter's lookup tables, and does a mainnet SIMULATION of it end with the buyer holding the
// whole amount. Nothing is signed or sent. The user is the public key of the test trader; the refund authority is the public key that
// holds withdraw authority of the TCURVE mint. No secret is read.
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { config, SOL_MINT } from "../src/config.js";
import * as jup from "../src/jupiter.js";
import * as chain from "../src/chain.js";
import { refundIx, parseTokenAccount } from "../src/token22.js";

const MINT = "2GHaaCNpbFzNSaSFRACaX7mPLLboUPykykSx9QGKpZPZ", AUTH = "KDpz3icbjmmib1DDeitywpk6ZdsQckHiqt6hKmKnnaq", USER = "ECFmvyQo7w1YtuAZbtkPxrbg1NX9ghF1rEECCRqNQg22";
const env = { SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com", JUP_API: "https://lite-api.jup.ag" };
const cfg = config({ ...env, MINT, PAYOUT_WALLET: AUTH });
const amount = 1_000_000n; // 0.001 SOL
const q = await jup.quote(env, cfg, { inputMint: SOL_MINT, outputMint: MINT, amount: String(amount), slippageBps: 100 });
console.log("quote out", q.outAmount, "impact (Jupiter)", q.priceImpactPct, "ex-tax bps", jup.impactBps(q, 1000));
const base = { quoteResponse: q, user: USER, mints: { [MINT]: TOKEN_2022_PROGRAM_ID.toBase58(), [SOL_MINT]: TOKEN_PROGRAM_ID.toBase58() }, maxWrap: amount + 2_100_000n };
// 1. the plain swap passes inspection (throws "refused" otherwise)
const plain = await jup.swapTx(env, cfg, base);
console.log("plain swap: instructions", plain.instructions.length, "bytes", plain.tx.serialize().length, "programs", [...new Set(plain.instructions.map((i) => i.programId.toBase58().slice(0, 6)))].join(","));
// 2. the atomic buy: refund appended, fee key as the only extra signer
const ata = getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(USER), false, TOKEN_2022_PROGRAM_ID);
const atomic = await jup.swapTx(env, cfg, { ...base, forbid: [AUTH], extra: [refundIx(MINT, ata, new PublicKey(AUTH))] });
console.log("atomic buy: bytes", atomic.tx.serialize().length, "required signatures", atomic.tx.message.header.numRequiredSignatures, "signers", atomic.tx.message.staticAccountKeys.slice(0, atomic.tx.message.header.numRequiredSignatures).map((k) => k.toBase58()));
// 3. simulate it on mainnet: the buyer's account should end with everything, nothing withheld
const before = parseTokenAccount((await chain.getAccounts(env, [ata.toBase58()])).get(ata.toBase58()));
const sim = await chain.simulate(env, atomic.tx, [ata.toBase58()]);
const after = parseTokenAccount(sim.after.get(ata.toBase58())?.data);
console.log("simulation err:", JSON.stringify(sim.err), "units", sim.units);
if (sim.err) console.log(sim.logs.slice(-8).join("\n"));
console.log("buyer account: amount", before?.amount, "->", after?.amount, "| withheld", before?.withheld, "->", after?.withheld);
const plainSim = await chain.simulate(env, plain.tx, [ata.toBase58()]);
const pa = parseTokenAccount(plainSim.after.get(ata.toBase58())?.data);
console.log("plain swap simulation: err", JSON.stringify(plainSim.err), "amount ->", pa?.amount, "withheld ->", pa?.withheld, "(the withheld part the refund engine returns)");
