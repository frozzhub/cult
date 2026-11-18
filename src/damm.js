// The locked DAMM v2 position the payout wallet owns after graduation (docs/ROUTE-CURVE.md): its SOL fees are the wallet's only
// income once the curve is gone. Moved out of scripts/fee-ops.mjs `claim` so the Worker's hourly claim (src/dbc.js) and the script
// share one reading and one claim, not two copies. Plain ES module over the SDK: runs in the Worker and in Node.
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { getUnClaimLpFee } from "@meteora-ag/cp-amm-sdk";

// The positions `owner` holds in `pool`, each with its pending fees as of now (raw units, bigint): [{ ...position, feeA, feeB }].
// feeA is the coin (Token-2022), feeB is SOL. `dp` is the pool state (cp.fetchPoolState).
export async function positionsOf(cp, pool, dp, owner) {
  const list = await cp.getUserPositionByPool(pool, owner);
  return list.map((p) => {
    const f = getUnClaimLpFee(dp, p.positionState);
    return { ...p, feeA: BigInt(f.feeTokenA.toString()), feeB: BigInt(f.feeTokenB.toString()) };
  });
}

// The SDK transaction that claims one position's fees to its owner (an unsigned legacy transaction).
export const claimPositionTx = (cp, { owner, pool, dp, p }) => cp.claimPositionFee({
  owner, position: p.position, pool, positionNftAccount: p.positionNftAccount, tokenAMint: dp.tokenAMint, tokenBMint: dp.tokenBMint,
  tokenAVault: dp.tokenAVault, tokenBVault: dp.tokenBVault, tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
  // No receiver: with a receiver and a SOL side the SDK wants a temp wrapped-SOL owner (it throws on undefined). The owner is the
  // fee wallet already, so both accounts are its own ATAs and the wrapped SOL is closed back to it.
});
