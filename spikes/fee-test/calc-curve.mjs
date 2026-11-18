// Scratch: numbers for a curve without touching the chain.
import BN from "bn.js";
import { buildCurveWithMarketCap, TokenType, TokenDecimal, TokenAuthorityOption, BaseFeeMode, CollectFeeMode, MigrationOption, MigrationFeeOption, ActivationType, getCurveBreakdown, getMigrationQuoteAmountFromThreshold, getMigrationBaseToken, getTokenomics, getTotalSupplyFromCurve, MigratedCollectFeeMode, getPriceFromSqrtPrice } from "@meteora-ag/dynamic-bonding-curve-sdk";
const [start, grad] = process.argv.slice(2).map(Number);
const c = buildCurveWithMarketCap({
  token: { tokenType: TokenType.Token2022, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: 9, tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: 1_000_000_000, leftover: 0 },
  fee: { baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: 25, endingFeeBps: 25, numberOfPeriod: 0, totalDuration: 0 } }, dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: 0, poolCreationFee: 0, enableFirstSwapWithMinFee: false },
  migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.Customizable, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 }, migratedPoolFee: { collectFeeMode: 2, dynamicFee: 0, poolFeeBps: 25, compoundingFeeBps: 0 } },
  liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 100, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0 },
  lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  activationType: ActivationType.Timestamp, initialMarketCap: start, migrationMarketCap: grad,
});
console.log(Object.keys(c).join(","));
const show = (k) => console.log(k, c[k]?.toString?.() ?? c[k]);
["migrationQuoteThreshold", "sqrtStartPrice", "migratedCollectFeeMode", "tokenSupply", "migrationOption", "migrationFeeOption"].forEach(show);
console.log("curve", c.curve.map((p) => ({ sqrtPrice: p.sqrtPrice.toString(), liquidity: p.liquidity.toString() })));
console.log("threshold SOL", Number(c.migrationQuoteThreshold.toString()) / 1e9);
console.log("tokenSupply", c.tokenSupply && { pre: c.tokenSupply.preMigrationTokenSupply.toString(), post: c.tokenSupply.postMigrationTokenSupply.toString() });
import { getBaseTokenForSwap, getSwapAmountWithBuffer, getMigrationThresholdPrice, getProtocolMigrationFee, PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS } from "@meteora-ag/dynamic-bonding-curve-sdk";
const sup = new BN("1000000000000000");
const th = c.migrationQuoteThreshold;
const mig = getMigrationThresholdPrice(th, c.sqrtStartPrice, c.curve);
const sold = getBaseTokenForSwap(c.sqrtStartPrice, mig, c.curve);
const buf = getSwapAmountWithBuffer(sold, c.sqrtStartPrice, c.curve);
const q = getMigrationQuoteAmountFromThreshold(th, 0);
const mb = getMigrationBaseToken(q, mig, MigrationOption.MET_DAMM_V2, 2);
const f = (x) => (Number(x.toString()) / 1e6).toLocaleString("en", { maximumFractionDigits: 0 });
console.log({ migrationSqrtPrice: mig.toString(), start_price_sol: Number(getPriceFromSqrtPrice(c.sqrtStartPrice, 6, 9)), mig_price_sol: Number(getPriceFromSqrtPrice(mig, 6, 9)) });
console.log("tokens sold on curve", f(sold), "| swap buffer total", f(buf), "| migration base", f(mb), "| sum sold+mig", f(sold.add(mb)), "| supply", f(sup), "| leftover = supply - buf - mig =", f(sup.sub(buf).sub(mb)), "| supply - sold - mig =", f(sup.sub(sold).sub(mb)));
const [pb, pq] = getProtocolMigrationFee(mb, q, mig, PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS, MigrationOption.MET_DAMM_V2, 2);
console.log("protocol migration fee base/quote", f(pb), Number(pq.toString())/1e9);
