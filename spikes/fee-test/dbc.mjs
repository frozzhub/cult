// Throwaway mainnet test 2: a 10% transfer-fee token on Meteora's Dynamic Bonding Curve (virtual reserves, no SOL from us).
//   node dbc.mjs create | buy <sol> | refund | sell <pct> | status
// State in dbc-state.json. Uses the same deployer (fee key) and test trader as test.mjs.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import BN from "bn.js";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, NATIVE_MINT, getAccount, getTransferFeeAmount, getAssociatedTokenAddressSync, createWithdrawWithheldTokensFromAccountsInstruction } from "@solana/spl-token";
import {
  DynamicBondingCurveClient, buildCurveWithMarketCap, deriveDbcPoolAddress, getCurrentPoint,
  TokenType, TokenDecimal, TokenAuthorityOption, BaseFeeMode, CollectFeeMode, MigrationOption, MigrationFeeOption, ActivationType,
  TransferFeeWithheldAuthority, MigratedTransferFeeAuthorityOption,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

const KEYS = new URL("../../program-keys/mainnet/", import.meta.url);
const key = (name) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL(name, KEYS), "utf8"))));
const rpc = readFileSync(process.env.USERPROFILE + "/.coined-preview/prod.vars", "utf8").match(/^SOLANA_RPC_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, "").replace("devnet.helius", "mainnet.helius");
const conn = new Connection(rpc, "confirmed");
const client = new DynamicBondingCurveClient(conn, "confirmed");
const admin = key("deployer.json"), trader = key("test-trader.json");
const FILE = "dbc-state.json";
const S = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
const save = () => writeFileSync(FILE, JSON.stringify(S, null, 2));
const DEC = 6;

const send = async (label, tx, signers) => {
  const t = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }), ...tx.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId) || ix.data[0] !== 3));
  const sig = await sendAndConfirmTransaction(conn, t, signers, { commitment: "confirmed" });
  console.log(`ok ${label}  ${sig}`);
  (S.txs ||= []).push({ label, sig }); save();
};
const ata = (owner) => getAssociatedTokenAddressSync(new PublicKey(S.mint), owner, true, TOKEN_2022_PROGRAM_ID);
async function bal(owner) {
  const sol = (await conn.getBalance(owner)) / LAMPORTS_PER_SOL;
  try {
    const a = await getAccount(conn, ata(owner), "confirmed", TOKEN_2022_PROGRAM_ID);
    return { sol, tokens: Number(a.amount) / 10 ** DEC, withheld: Number(getTransferFeeAmount(a)?.withheldAmount || 0n) / 10 ** DEC };
  } catch { return { sol, tokens: 0, withheld: 0 }; }
}

const steps = {
  async create() {
    if (S.pool) return console.log("pool exists", S.pool);
    const curve = buildCurveWithMarketCap({
      token: { tokenType: TokenType.Token2022, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: 9, tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: 1_000_000_000, leftover: 0 },
      fee: {
        baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: 25, endingFeeBps: 25, numberOfPeriod: 0, totalDuration: 0 } },
        dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: 0, poolCreationFee: 0, enableFirstSwapWithMinFee: false,
      },
      migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.Customizable, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
        // transfer-fee coins must graduate into a Compounding-mode pool; 0 compounding = fee collected in SOL
        migratedPoolFee: { collectFeeMode: 2, dynamicFee: 0, poolFeeBps: 25, compoundingFeeBps: 0 } },
      liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 100, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0 },
      lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
      activationType: ActivationType.Timestamp,
      initialMarketCap: 30, migrationMarketCap: 400, // in SOL
    });
    const config = Keypair.generate(), mint = Keypair.generate();
    writeFileSync(new URL(`test-dbc-mint-${mint.publicKey.toBase58()}.json`, KEYS), JSON.stringify([...mint.secretKey]));
    const tx = await client.partner.createConfigAndPool({
      payer: admin.publicKey, config: config.publicKey, feeClaimer: admin.publicKey, leftoverReceiver: admin.publicKey, quoteMint: NATIVE_MINT,
      ...curve,
      transferFeeParameters: { transferFeeBasisPoints: 1000, withheldAuthority: TransferFeeWithheldAuthority.Creator, migratedTransferFeeAuthorityOption: MigratedTransferFeeAuthorityOption.Immutable },
      preCreatePoolParam: { baseMint: mint.publicKey, name: "Tithe Curve", symbol: "TCURVE", uri: "", poolCreator: admin.publicKey },
    });
    S.mint = mint.publicKey.toBase58(); S.config = config.publicKey.toBase58();
    S.pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, config.publicKey).toBase58(); save();
    try { await send("config + curve pool: 10% transfer fee, no SOL in", tx, [admin, mint, config]); }
    catch (e) { delete S.pool; delete S.mint; delete S.config; save(); throw e; }
  },

  async swap(sell, amountIn) {
    const pool = new PublicKey(S.pool);
    const virtualPool = await client.state.getPool(pool), config = await client.state.getPoolConfig(S.config);
    const q = client.pool.swapQuote({
      virtualPool, config, swapBaseForQuote: sell, amountIn, slippageBps: 100, hasReferral: false, eligibleForFirstSwapWithMinFee: false,
      currentPoint: await getCurrentPoint(conn, config.activationType),
    });
    console.log(`${sell ? "sell" : "buy"} quote: out ${q.outputAmount?.toString()}, min out ${q.minimumAmountOut?.toString()}`);
    const tx = await client.pool.swap({ owner: trader.publicKey, pool, amountIn, minimumAmountOut: q.minimumAmountOut, swapBaseForQuote: sell, referralTokenAccount: null });
    await send(sell ? "sell" : "buy", tx, [trader]);
  },
  async buy(sol = "0.01") {
    const b = await bal(trader.publicKey);
    await steps.swap(false, new BN(Math.round(Number(sol) * LAMPORTS_PER_SOL)));
    const a = await bal(trader.publicKey);
    console.log(`bought with ${sol} SOL: ${a.tokens - b.tokens} usable, ${a.withheld - b.withheld} withheld in the buyer's account`);
  },
  async refund() {
    const b = await bal(trader.publicKey);
    await send("refund buyer's withheld 10%", new Transaction().add(createWithdrawWithheldTokensFromAccountsInstruction(new PublicKey(S.mint), ata(trader.publicKey), admin.publicKey, [], [ata(trader.publicKey)], TOKEN_2022_PROGRAM_ID)), [admin]);
    const a = await bal(trader.publicKey);
    console.log(`refund: usable ${b.tokens} -> ${a.tokens}, withheld ${b.withheld} -> ${a.withheld}`);
  },
  async sell(pct = "50") {
    const b = await bal(trader.publicKey);
    await steps.swap(true, new BN(Math.floor(b.tokens * 10 ** DEC * (Number(pct) / 100))));
    const a = await bal(trader.publicKey);
    console.log(`sold ${pct}% (${b.tokens - a.tokens} tokens): SOL ${b.sol} -> ${a.sol}`);
  },
  async status() {
    console.log({ mint: S.mint, pool: S.pool, config: S.config });
    console.log("admin ", await bal(admin.publicKey));
    console.log("trader", await bal(trader.publicKey));
  },
};
const [cmd, arg] = process.argv.slice(2);
if (!steps[cmd] || cmd === "swap") { console.log("usage: node dbc.mjs create|buy <sol>|refund|sell <pct>|status"); process.exit(1); }
await steps[cmd](arg);
