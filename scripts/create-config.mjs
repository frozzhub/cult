// Create only the Meteora DBC config for $CULT, so the token itself can be launched from a tool that takes a
// "DBC config" address (Proxima, launch.meteora.ag). The config carries everything that matters: the 10% transfer fee
// (rate locked for good), the fee wallet (feeClaimer + withdraw-withheld authority), the curve and locked liquidity.
// Same settings as scripts/launch-curve.mjs (both use lib/curve.mjs buildCurve).
//
//   node scripts/create-config.mjs --rpc <URL> --keypair <payer file> [--fee-wallet <addr>] \
//     [--start-mcap 27.96 --grad-mcap 410.8 --pool-fee-bps 25] [--token-authority immutable|creator|partner] [--state-dir <dir>] [--go]
//
// Dry run by default. With --go the config key is saved before anything is sent, and the config is read back from chain.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, ComputeBudgetProgram } from "@solana/web3.js";
import { DynamicBondingCurveClient, TransferFeeWithheldAuthority, MigratedTransferFeeAuthorityOption } from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  FEE_WALLET, SOL_MINT, TRANSFER_FEE_BPS, TOKEN_AUTHORITY, Refuse, refuse, sol, parseArgs, positiveNumber, loadKey, pubkeyOf,
  connect, clusterOf, tilde, writeJson, saveSecret, buildCurve, curvePlan, makeSender,
} from "./lib/curve.mjs";
import { configMismatches } from "./launch-curve.mjs";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const FLAGS = { value: ["rpc", "keypair", "fee-wallet", "start-mcap", "grad-mcap", "pool-fee-bps", "token-authority", "state-dir"], flag: ["go"] };

try {
  const { args } = parseArgs(process.argv.slice(2), FLAGS);
  const payer = loadKey({ file: args.keypair, envName: "CREATOR_KEY", label: "keypair" }) ?? refuse("Give the paying wallet's key with --keypair <file>.");
  const num = (k, d) => (args[k] === undefined ? d : positiveNumber(args[k], k));
  const o = { startMcap: num("start-mcap", 27.96), gradMcap: num("grad-mcap", 410.8), poolFeeBps: args["pool-fee-bps"] === undefined ? 25 : Number(args["pool-fee-bps"]), tokenAuthority: args["token-authority"] ?? "immutable" };
  const feeWallet = pubkeyOf(args["fee-wallet"] ?? FEE_WALLET, "fee-wallet");
  const stateDir = typeof args["state-dir"] === "string" ? tilde(args["state-dir"]) : join(REPO, "program-keys", "mainnet");
  const conn = connect(args.rpc), client = new DynamicBondingCurveClient(conn, "confirmed");
  const cfg = buildCurve(o), plan = curvePlan(cfg, { poolFeeBps: o.poolFeeBps });
  const configKp = Keypair.generate(), config = configKp.publicKey;

  const tx = await client.partner.createConfig2({
    payer: payer.publicKey, config, feeClaimer: feeWallet, leftoverReceiver: feeWallet, quoteMint: SOL_MINT, ...cfg,
    transferFeeParameters: { transferFeeBasisPoints: TRANSFER_FEE_BPS, withheldAuthority: TransferFeeWithheldAuthority.Partner, migratedTransferFeeAuthorityOption: MigratedTransferFeeAuthorityOption.Immutable },
  });
  const ixs = tx.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
  console.log(`
Config plan (${args.go ? "LIVE" : "dry run, add --go to send"}) on ${conn.rpcEndpoint} (${await clusterOf(conn)})
  payer        ${payer.publicKey}  holds ${sol(await conn.getBalance(payer.publicKey))}
  fee wallet   ${feeWallet}  (feeClaimer, withdraw-withheld authority, leftover receiver, owner of the locked LP)
  token        Token-2022, ${TRANSFER_FEE_BPS / 100}% transfer fee, rate locked for good; metadata authority: ${o.tokenAuthority}
  curve        market cap ${o.startMcap} SOL -> graduates at ${o.gradMcap} SOL after ${sol(plan.thresholdLamports)} raised; pool fee ${o.poolFeeBps / 100}%
  config       ${config}  (anyone who launches a token with this address gets exactly these settings)
`);
  if (!args.go) process.exit(0);

  saveSecret(join(stateDir, `config-${config.toBase58()}.json`), configKp);
  const sender = makeSender({ conn, dir: stateDir, name: "create-config" });
  const r = await sender.send("config", ixs, [payer, configKp]);
  const onChain = await client.state.getPoolConfig(config);
  if (!onChain) refuse(`The config isn't on chain yet (${r.status}, ${r.sig}). Check the signature before trying again.`);
  const bad = configMismatches(onChain, { feeWallet, poolFeeBps: o.poolFeeBps, tokenAuthorityCode: TOKEN_AUTHORITY[o.tokenAuthority], thresholdLamports: plan.thresholdLamports, sqrtStartPrice: BigInt(cfg.sqrtStartPrice.toString()) });
  if (bad.length) refuse(`The config on chain differs from the plan:\n  ${bad.join("\n  ")}`);
  writeJson(join(stateDir, `config-${config.toBase58()}.info.json`), { config: config.toBase58(), feeWallet: feeWallet.toBase58(), ...o, sig: r.sig, at: new Date().toISOString() });
  console.log(`Done and checked on chain.\nDBC config: ${config}\nPaste that into the launch tool's "DBC Config" field.`);
} catch (e) { console.error(e instanceof Refuse ? "REFUSING: " + e.message : e.stack || String(e)); process.exitCode = 1; }
