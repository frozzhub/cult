// Launches $CULT on Meteora's Dynamic Bonding Curve (shows up on Axiom, GMGN, Jupiter, Dexscreener).
//
//   10% fee on every buy and sell, taken in SOL. The treasury (PAYOUT_WALLET) is the partner and gets the
//   whole non-protocol share (Meteora keeps 20% of every fee, so the treasury receives 8% of volume).
//   The Worker refunds each buyer's full 10% within seconds; sellers' fees become the 10-minute USDC airdrop.
//   On graduation the coin moves to a DAMM v2 pool with the same 10% fee in SOL, and 100% of that
//   liquidity is permanently locked to the treasury (it earns the pool's fees, it can never be pulled).
//
//   node scripts/launch-meteora.mjs --cluster devnet --treasury program-keys/devnet-payout.json \
//     [--payer program-keys/devnet-deployer.json] [--start-mcap 30] [--grad-mcap 400] [--uri https://.../token.json]
//
// Prints the env vars for wrangler.jsonc (MINT, POOL_ACCOUNT, VAULTS) and writes them to program-keys/<cluster>-meteora.json.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  DynamicBondingCurveClient, buildCurveWithMarketCap, deriveDbcPoolAddress, validateConfigParameters,
  BaseFeeMode, CollectFeeMode, MigrationOption, MigrationFeeOption, MigratedCollectFeeMode, DammV2DynamicFeeMode,
  DammV2BaseFeeMode, TokenType, TokenDecimal, TokenAuthorityOption, ActivationType,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const args = Object.fromEntries(process.argv.slice(2).join(" ").split("--").filter(Boolean).map((a) => { const [k, ...v] = a.trim().split(/\s+/); return [k, v.join(" ") || true]; }));
const cluster = args.cluster === "mainnet" ? "mainnet" : "devnet";
const rpc = args.rpc || process.env.RPC || (cluster === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
const load = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
if (!args.treasury) { console.error("--treasury <keypair.json> is required (the payout wallet)"); process.exit(1); }
const treasury = load(args.treasury);
const payer = args.payer ? load(args.payer) : treasury;
const FEE_BPS = Number(args.fee || 1000);

// The whole launch config. Exported for the tests.
export function curveParams({ startMcap = 30, gradMcap = 400, feeBps = FEE_BPS } = {}) {
  return buildCurveWithMarketCap({
    token: { tokenType: TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: TokenDecimal.NINE,
      tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: 1_000_000_000, leftover: 0 },
    fee: {
      // Flat fee: a "scheduler" that starts and ends at the same rate.
      baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: feeBps, endingFeeBps: feeBps, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: false,            // never more than 10%
      collectFeeMode: CollectFeeMode.QuoteToken, // the fee is SOL on both buys and sells: nothing ever sells $CULT
      creatorTradingFeePercentage: 0,      // the treasury (partner) gets the full non-protocol share
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: { collectFeeMode: MigratedCollectFeeMode.QuoteToken, dynamicFee: DammV2DynamicFeeMode.Disabled, poolFeeBps: feeBps, baseFeeMode: DammV2BaseFeeMode.FeeTimeSchedulerLinear },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 100, partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
    initialMarketCap: startMcap,
    migrationMarketCap: gradMcap,
  });
}

if (args.dry) { for (const [s,g] of [[30,400],[28,420],[2,8],[1,4]]) { const p = curveParams({startMcap:s,gradMcap:g}); try { validateConfigParameters({...p, leftoverReceiver: treasury.publicKey}); console.log(s,g,"ok threshold SOL", Number(p.migrationQuoteThreshold)/1e9, "supply%", p.percentageSupplyOnMigration ?? "") } catch(e){ console.log(s,g,"ERR",e.message) } } process.exit(0); }
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const out = `program-keys/${cluster}-meteora.json`;
  if (existsSync(out) && !args.force && !args["config-only"]) { console.error(`${out} exists: $CULT is already launched on ${cluster}. Pass --force for another.`); process.exit(1); }
  const connection = new Connection(rpc, "confirmed");
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const params = curveParams({ startMcap: Number(args["start-mcap"] || 30), gradMcap: Number(args["grad-mcap"] || 400) });
  validateConfigParameters({ ...params, leftoverReceiver: treasury.publicKey });
  console.log(`graduates at ${Number(params.migrationQuoteThreshold) / 1e9} SOL raised; fee ${FEE_BPS / 100}% in SOL both ways`);

  // --config-only: just the config (10% fee, treasury as fee claimer). Any DBC launcher can then create the
  // coin on it by its pubkey. Saved to program-keys/<cluster>-config-<name>.json.
  if (args["config-only"]) {
    const configKp = Keypair.generate();
    const tx = await client.partner.createConfig2({ ...params, config: configKp.publicKey, feeClaimer: treasury.publicKey, leftoverReceiver: treasury.publicKey, quoteMint: NATIVE_MINT, payer: payer.publicKey });
    const sig = await sendAndConfirmTransaction(connection, tx, [payer, configKp], { commitment: "confirmed" });
    const file = `program-keys/${cluster}-config-${args.label || "test"}.json`;
    writeFileSync(file, JSON.stringify({ DBC_CONFIG: configKp.publicKey.toBase58(), PAYOUT_WALLET: treasury.publicKey.toBase58(), graduatesAtSol: Number(params.migrationQuoteThreshold) / 1e9, sig, cluster, at: new Date().toISOString() }, null, 2));
    console.log("config:", configKp.publicKey.toBase58(), "tx:", sig);
    process.exit(0);
  }

  const configKp = Keypair.generate(), mintKp = Keypair.generate();
  const tx = await client.partner.createConfigAndPool({
    ...params,
    config: configKp.publicKey, feeClaimer: treasury.publicKey, leftoverReceiver: treasury.publicKey,
    quoteMint: NATIVE_MINT, payer: payer.publicKey,
    preCreatePoolParam: { name: args.name || "CULT", symbol: args.symbol || "CULT", uri: args.uri || "https://cults.bid/token.json", poolCreator: treasury.publicKey, baseMint: mintKp.publicKey },
  });
  const signers = [payer, configKp, mintKp]; if (!payer.publicKey.equals(treasury.publicKey)) signers.push(treasury);
  const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
  const pool = deriveDbcPoolAddress(NATIVE_MINT, mintKp.publicKey, configKp.publicKey);
  const got = await client.state.getPool(pool); const state = got?.poolState || got?.account || got;
  const env = {
    MINT: mintKp.publicKey.toBase58(),
    POOL_ACCOUNT: pool.toBase58(),
    VAULTS: `${state.baseVault.toBase58()}:${state.quoteVault.toBase58()}`,
    DBC_CONFIG: configKp.publicKey.toBase58(),
    PAYOUT_WALLET: treasury.publicKey.toBase58(),
  };
  writeFileSync(out, JSON.stringify({ ...env, sig, cluster, at: new Date().toISOString() }, null, 2));
  console.log("launched:", sig);
  console.log(JSON.stringify(env, null, 2));
}
