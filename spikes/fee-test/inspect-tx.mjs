// Scratch: which accounts must sign the launch transactions, and how big are they.
import BN from "bn.js";
import { Connection, Keypair, PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { DynamicBondingCurveClient, TransferFeeWithheldAuthority, MigratedTransferFeeAuthorityOption } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { buildCurve, SOL_MINT, sizeOf } from "../../scripts/lib/curve.mjs";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const client = new DynamicBondingCurveClient(conn, "confirmed");
const creator = Keypair.generate(), mint = Keypair.generate(), config = Keypair.generate();
const cfg = buildCurve({ startMcap: 0.03, gradMcap: 0.033 });
const r = await client.partner.createConfigAndPoolWithFirstBuy({
  payer: creator.publicKey, config: config.publicKey, feeClaimer: creator.publicKey, leftoverReceiver: creator.publicKey, quoteMint: SOL_MINT, ...cfg,
  transferFeeParameters: { transferFeeBasisPoints: 1000, withheldAuthority: TransferFeeWithheldAuthority.Partner, migratedTransferFeeAuthorityOption: MigratedTransferFeeAuthorityOption.Immutable },
  preCreatePoolParam: { baseMint: mint.publicKey, name: "T", symbol: "T", uri: "", poolCreator: creator.publicKey },
  firstBuyParam: { buyer: creator.publicKey, buyAmount: new BN(3_000_000), minimumAmountOut: new BN(1), referralTokenAccount: null },
});
const name = (k) => (k.equals(creator.publicKey) ? "creator" : k.equals(mint.publicKey) ? "mint" : k.equals(config.publicKey) ? "config" : k.toBase58().slice(0, 8));
for (const [label, tx] of [["config", r.createConfigTx], ["pool+buy", r.createPoolWithFirstBuyTx]]) {
  const signers = new Set(); for (const ix of tx.instructions) for (const k of ix.keys) if (k.isSigner) signers.add(name(k.pubkey));
  console.log(label, "ixs", tx.instructions.map((i) => i.programId.toBase58().slice(0, 6) + ":" + i.data.length).join(" "), "signers", [...signers].join(","), "size", sizeOf(tx.instructions.filter((i) => !i.programId.equals(ComputeBudgetProgram.programId)), creator.publicKey));
}
const all = [...r.createConfigTx.instructions, ...r.createPoolWithFirstBuyTx.instructions].filter((i) => !i.programId.equals(ComputeBudgetProgram.programId));
console.log("merged size", sizeOf(all, creator.publicKey));
const noBuy = await client.partner.createConfigAndPoolWithFirstBuy({
  payer: creator.publicKey, config: config.publicKey, feeClaimer: creator.publicKey, leftoverReceiver: creator.publicKey, quoteMint: SOL_MINT, ...cfg,
  transferFeeParameters: { transferFeeBasisPoints: 1000, withheldAuthority: TransferFeeWithheldAuthority.Partner, migratedTransferFeeAuthorityOption: MigratedTransferFeeAuthorityOption.Immutable },
  preCreatePoolParam: { baseMint: mint.publicKey, name: "Cult", symbol: "CULT", uri: "https://cult.example/token.json", poolCreator: creator.publicKey },
});
console.log("no-buy merged size", sizeOf([...noBuy.createConfigTx.instructions, ...noBuy.createPoolWithFirstBuyTx.instructions].filter((i) => !i.programId.equals(ComputeBudgetProgram.programId)), creator.publicKey));
