// Throwaway mainnet test: a Token-2022 mint with a 15% transfer fee on a tokens-only Meteora DAMM v2 pool.
// Proves the venue accepts it, a buy works, the withheld 15% can be released back to the buyer, and a sell works.
//   node test.mjs mint | pool | fund | buy <sol> | refund | sell <pct> | naive | status
// State is kept in state.json so each step can be re-run or resumed. Keys never leave program-keys/mainnet.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import BN from "bn.js";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT, ExtensionType, getMintLen, getMint, getAccount, getTransferFeeAmount,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction, createInitializeMetadataPointerInstruction, createMintToInstruction,
  createSetAuthorityInstruction, AuthorityType, createWithdrawWithheldTokensFromAccountsInstruction, TYPE_SIZE, LENGTH_SIZE,
} from "@solana/spl-token";
import { createInitializeInstruction as createInitMetadata, pack as packMetadata } from "@solana/spl-token-metadata";
import { CpAmm, getSqrtPriceFromPrice, getBaseFeeParams, MAX_SQRT_PRICE, CollectFeeMode, ActivationType, BaseFeeMode } from "@meteora-ag/cp-amm-sdk";

const KEYS = new URL("../../program-keys/mainnet/", import.meta.url);
const key = (name) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL(name, KEYS), "utf8"))));
const rpc = readFileSync(process.env.USERPROFILE + "/.coined-preview/prod.vars", "utf8").match(/^SOLANA_RPC_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, "").replace("devnet.helius", "mainnet.helius");
const conn = new Connection(rpc, "confirmed");
const cp = new CpAmm(conn);
const admin = key("deployer.json"); // creates the mint and pool; holds the withdraw-withheld (refund) authority
const traderFile = new URL("test-trader.json", KEYS);
if (!existsSync(traderFile)) writeFileSync(traderFile, JSON.stringify([...Keypair.generate().secretKey]));
const trader = key("test-trader.json");

const S = existsSync("state.json") ? JSON.parse(readFileSync("state.json", "utf8")) : {};
const save = () => writeFileSync("state.json", JSON.stringify(S, null, 2));
const DEC = 6, FEE_BPS = 1500, SUPPLY = 1_000_000_000n * 10n ** BigInt(DEC);
const START_PRICE = "0.00000003"; // SOL per token: 1B supply starts at a 30 SOL market cap

const send = async (label, ixs, signers) => {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }), ...ixs);
  const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
  console.log(`ok ${label}  ${sig}`);
  (S.txs ||= []).push({ label, sig }); save();
  return sig;
};
const mintPk = () => new PublicKey(S.mint);
const ata = (owner) => getAssociatedTokenAddressSync(mintPk(), owner, true, TOKEN_2022_PROGRAM_ID);
const tokenInfo = async () => ({ mint: await getMint(conn, mintPk(), "confirmed", TOKEN_2022_PROGRAM_ID), currentEpoch: (await conn.getEpochInfo()).epoch });
async function bal(owner) {
  const sol = (await conn.getBalance(owner)) / LAMPORTS_PER_SOL;
  try {
    const a = await getAccount(conn, ata(owner), "confirmed", TOKEN_2022_PROGRAM_ID);
    return { sol, tokens: Number(a.amount) / 10 ** DEC, withheld: Number(getTransferFeeAmount(a)?.withheldAmount || 0n) / 10 ** DEC };
  } catch { return { sol, tokens: 0, withheld: 0 }; }
}

const steps = {
  async mint() {
    if (S.mint) return console.log("mint exists", S.mint);
    const mint = Keypair.generate();
    writeFileSync(new URL(`test-mint-${mint.publicKey.toBase58()}.json`, KEYS), JSON.stringify([...mint.secretKey]));
    const meta = { name: "Tithe Test", symbol: "TTEST", uri: "" };
    const mintLen = getMintLen([ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer]);
    const metaLen = TYPE_SIZE + LENGTH_SIZE + packMetadata({ mint: mint.publicKey, updateAuthority: admin.publicKey, ...meta, additionalMetadata: [] }).length;
    S.mint = mint.publicKey.toBase58(); save();
    await send("mint: 15% transfer fee, fee rate locked, supply minted, minting revoked", [
      SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: mint.publicKey, space: mintLen, lamports: await conn.getMinimumBalanceForRentExemption(mintLen + metaLen), programId: TOKEN_2022_PROGRAM_ID }),
      // config authority null = the 15% can never be changed; withdraw authority = admin (collects fees, refunds buyers)
      createInitializeTransferFeeConfigInstruction(mint.publicKey, null, admin.publicKey, FEE_BPS, 2n ** 64n - 1n, TOKEN_2022_PROGRAM_ID),
      createInitializeMetadataPointerInstruction(mint.publicKey, admin.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(mint.publicKey, DEC, admin.publicKey, null, TOKEN_2022_PROGRAM_ID),
      createInitMetadata({ programId: TOKEN_2022_PROGRAM_ID, metadata: mint.publicKey, updateAuthority: admin.publicKey, mint: mint.publicKey, mintAuthority: admin.publicKey, ...meta }),
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, getAssociatedTokenAddressSync(mint.publicKey, admin.publicKey, false, TOKEN_2022_PROGRAM_ID), admin.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
      createMintToInstruction(mint.publicKey, getAssociatedTokenAddressSync(mint.publicKey, admin.publicKey, false, TOKEN_2022_PROGRAM_ID), admin.publicKey, SUPPLY, [], TOKEN_2022_PROGRAM_ID),
      createSetAuthorityInstruction(mint.publicKey, admin.publicKey, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
    ], [admin, mint]);
  },

  async pool() {
    if (S.pool) return console.log("pool exists", S.pool);
    const init = getSqrtPriceFromPrice(START_PRICE, DEC, 9);
    const amountA = new BN(SUPPLY.toString());
    const liquidityDelta = cp.preparePoolCreationSingleSide({ tokenAAmount: amountA, minSqrtPrice: init, maxSqrtPrice: MAX_SQRT_PRICE, initSqrtPrice: init, tokenAInfo: await tokenInfo(), collectFeeMode: CollectFeeMode.OnlyB });
    const nft = Keypair.generate();
    const { tx, pool, position } = await cp.createCustomPool({
      payer: admin.publicKey, creator: admin.publicKey, positionNft: nft.publicKey,
      tokenAMint: mintPk(), tokenBMint: NATIVE_MINT, tokenAAmount: amountA, tokenBAmount: new BN(0),
      sqrtMinPrice: init, sqrtMaxPrice: MAX_SQRT_PRICE, initSqrtPrice: init, liquidityDelta,
      poolFees: {
        baseFee: getBaseFeeParams({ baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear, feeTimeSchedulerParam: { startingFeeBps: 25, endingFeeBps: 25, numberOfPeriod: 0, totalDuration: 0 } }),
        compoundingFeeBps: 0, padding: 0, dynamicFee: null,
      },
      hasAlphaVault: false, activationType: ActivationType.Timestamp, activationPoint: null, collectFeeMode: CollectFeeMode.OnlyB,
      tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, isLockLiquidity: true,
    });
    S.pool = pool.toBase58(); S.position = position.toBase58(); save();
    await send("pool: tokens only, no SOL, liquidity locked", tx.instructions, [admin, nft]);
  },

  async fund() {
    await send("fund test trader 0.06 SOL", [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: trader.publicKey, lamports: 0.06 * LAMPORTS_PER_SOL })], [admin]);
  },

  // Quote and swap the way a fee-aware client does (Meteora's own SDK).
  async swap(inputMint, outputMint, amountIn, { naive = false, simulateOnly = false } = {}) {
    const poolState = await cp.fetchPoolState(new PublicKey(S.pool));
    const info = await tokenInfo();
    const slot = await conn.getSlot(), time = (await conn.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
    const buying = inputMint.equals(NATIVE_MINT);
    const q = cp.getQuote({
      inAmount: amountIn, inputTokenMint: inputMint, slippage: 1, poolState, currentTime: time, currentSlot: slot,
      ...(naive ? {} : buying ? { outputTokenInfo: info } : { inputTokenInfo: info }), // naive = a client that ignores the transfer fee
      tokenADecimal: DEC, tokenBDecimal: 9,
    });
    const tx = await cp.swap({
      payer: trader.publicKey, pool: new PublicKey(S.pool), inputTokenMint: inputMint, outputTokenMint: outputMint,
      amountIn, minimumAmountOut: q.minSwapOutAmount, tokenAMint: poolState.tokenAMint, tokenBMint: poolState.tokenBMint,
      tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault, tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
    });
    console.log(`${buying ? "buy" : "sell"} quote (${naive ? "ignores" : "includes"} transfer fee): out ${q.swapOutAmount.toString()}, min out at 1% slippage ${q.minSwapOutAmount.toString()}`);
    if (simulateOnly) {
      tx.feePayer = trader.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      const r = await conn.simulateTransaction(tx, [trader]);
      const why = (r.value.logs || []).filter((l) => /Error|failed|exceeded/i.test(l)).slice(-2).join(" | ");
      console.log(r.value.err ? `  simulated: FAILS  ${why}` : "  simulated: succeeds");
      return !r.value.err;
    }
    return send(buying ? "buy" : "sell", tx.instructions, [trader]);
  },

  async buy(sol = "0.02") {
    const before = await bal(trader.publicKey);
    await steps.swap(NATIVE_MINT, mintPk(), new BN(Math.round(Number(sol) * LAMPORTS_PER_SOL)));
    const after = await bal(trader.publicKey);
    console.log(`bought with ${sol} SOL: received ${after.tokens - before.tokens} tokens, ${after.withheld - before.withheld} withheld in the buyer's own account`);
  },

  // The refund: the fee authority moves the buyer's withheld tokens back into the same account. The buyer signs nothing.
  async refund() {
    const before = await bal(trader.publicKey);
    await send("refund buyer's withheld 15%", [createWithdrawWithheldTokensFromAccountsInstruction(mintPk(), ata(trader.publicKey), admin.publicKey, [], [ata(trader.publicKey)], TOKEN_2022_PROGRAM_ID)], [admin]);
    const after = await bal(trader.publicKey);
    console.log(`refund: usable tokens ${before.tokens} -> ${after.tokens}, withheld ${before.withheld} -> ${after.withheld}`);
  },

  async sell(pct = "50") {
    const before = await bal(trader.publicKey);
    const amount = new BN(Math.floor(before.tokens * 10 ** DEC * (Number(pct) / 100)));
    await steps.swap(mintPk(), NATIVE_MINT, amount);
    const after = await bal(trader.publicKey);
    console.log(`sold ${pct}% (${before.tokens - after.tokens} tokens): SOL ${before.sol} -> ${after.sol}`);
  },

  // What a terminal that ignores the transfer fee would send, at 1% slippage. Simulated only; costs nothing.
  async naive() {
    const t = await bal(trader.publicKey);
    console.log("naive buy 0.01 SOL:"); await steps.swap(NATIVE_MINT, mintPk(), new BN(0.01 * LAMPORTS_PER_SOL), { naive: true, simulateOnly: true });
    console.log("fee-aware buy 0.01 SOL:"); await steps.swap(NATIVE_MINT, mintPk(), new BN(0.01 * LAMPORTS_PER_SOL), { simulateOnly: true });
    if (t.tokens > 0) {
      const amt = new BN(Math.floor(t.tokens * 10 ** DEC * 0.25));
      console.log("naive sell 25%:"); await steps.swap(mintPk(), NATIVE_MINT, amt, { naive: true, simulateOnly: true });
      console.log("fee-aware sell 25%:"); await steps.swap(mintPk(), NATIVE_MINT, amt, { simulateOnly: true });
    }
  },

  async status() {
    console.log({ mint: S.mint, pool: S.pool, admin: admin.publicKey.toBase58(), trader: trader.publicKey.toBase58() });
    console.log("admin ", await bal(admin.publicKey));
    console.log("trader", await bal(trader.publicKey));
    if (S.pool) {
      const p = await cp.fetchPoolState(new PublicKey(S.pool));
      const v = await getAccount(conn, p.tokenAVault, "confirmed", TOKEN_2022_PROGRAM_ID);
      console.log("pool vault", { tokens: Number(v.amount) / 10 ** DEC, withheld: Number(getTransferFeeAmount(v)?.withheldAmount || 0n) / 10 ** DEC, sol: (await conn.getTokenAccountBalance(p.tokenBVault)).value.uiAmount });
    }
  },
};

const [cmd, arg] = process.argv.slice(2);
if (!steps[cmd] || cmd === "swap") { console.log("usage: node test.mjs mint|pool|fund|buy <sol>|refund|sell <pct>|naive|status"); process.exit(1); }
await steps[cmd](arg);
