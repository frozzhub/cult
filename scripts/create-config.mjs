// Create only the Meteora DBC config for $CULT, so the token itself can be launched from a tool that takes a
// "DBC config" address (such as launch.meteora.ag). The config carries everything that matters: the 10% transfer fee
// (rate locked for good), the fee wallet (feeClaimer + withdraw-withheld authority), the curve and locked liquidity.
// Same settings as scripts/launch-curve.mjs (both use lib/curve.mjs buildCurve).
//
//   node scripts/create-config.mjs --rpc <URL> --keypair <payer file> [--fee-wallet <addr>] \
//     [--quote sol|usdc] [--start-mcap 27.96 --grad-mcap 410.8 --pool-fee-bps 25] [--token-authority immutable|creator|partner] [--state-dir <dir>] [--go]
//
// --quote is the token the curve is quoted in (default sol). With usdc the market caps and the graduation threshold are in USDC, and
// --start-mcap and --grad-mcap are required (the defaults are SOL amounts). The USDC config for $CULT, start $1,935 and graduation $28,400:
//   node scripts/create-config.mjs --rpc <URL> --keypair <payer file> --quote usdc --start-mcap 1935 --grad-mcap 28400
//
// Dry run by default. With --go the config key is saved before anything is sent, and the config is read back from chain.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, ComputeBudgetProgram } from "@solana/web3.js";
import { DynamicBondingCurveClient, TransferFeeWithheldAuthority, MigratedTransferFeeAuthorityOption } from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  FEE_WALLET, TRANSFER_FEE_BPS, TOKEN_AUTHORITY, Refuse, refuse, sol, money, quoteOf, mcapsOf, parseArgs, loadKey, pubkeyOf,
  connect, clusterOf, tilde, writeJson, saveSecret, buildCurve, curvePlan, makeSender,
} from "./lib/curve.mjs";
import { configMismatches } from "./launch-curve.mjs";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const FLAGS = { value: ["rpc", "keypair", "fee-wallet", "quote", "start-mcap", "grad-mcap", "pool-fee-bps", "token-authority", "state-dir"], flag: ["go"] };

try {
  const { args } = parseArgs(process.argv.slice(2), FLAGS);
  const payer = loadKey({ file: args.keypair, envName: "CREATOR_KEY", label: "keypair" }) ?? refuse("Give the paying wallet's key with --keypair <file>.");
  const quote = args.quote ?? "sol", Q = quoteOf(quote);
  const o = { quote, ...mcapsOf(args, quote, { startMcap: 27.96, gradMcap: 410.8 }), poolFeeBps: args["pool-fee-bps"] === undefined ? 25 : Number(args["pool-fee-bps"]), tokenAuthority: args["token-authority"] ?? "immutable" };
  const feeWallet = pubkeyOf(args["fee-wallet"] ?? FEE_WALLET, "fee-wallet");
  const stateDir = typeof args["state-dir"] === "string" ? tilde(args["state-dir"]) : join(REPO, "program-keys", "mainnet");
  const conn = connect(args.rpc), client = new DynamicBondingCurveClient(conn, "confirmed");
  const cfg = buildCurve(o), plan = curvePlan(cfg, { poolFeeBps: o.poolFeeBps, quote });
  const configKp = Keypair.generate(), config = configKp.publicKey;

  const tx = await client.partner.createConfig2({
    payer: payer.publicKey, config, feeClaimer: feeWallet, leftoverReceiver: feeWallet, quoteMint: Q.mint, ...cfg,
    transferFeeParameters: { transferFeeBasisPoints: TRANSFER_FEE_BPS, withheldAuthority: TransferFeeWithheldAuthority.Partner, migratedTransferFeeAuthorityOption: MigratedTransferFeeAuthorityOption.Immutable },
  });
  const ixs = tx.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
  // What the SDK built is read back before anything is sent: the transaction must name the quote mint we asked for.
  if (!ixs.some((ix) => ix.keys.some((k) => k.pubkey.equals(Q.mint)))) refuse(`The config transaction doesn't name the ${Q.sym} mint. Nothing was sent.`);
  console.log(`
Config plan (${args.go ? "LIVE" : "dry run, add --go to send"}) on ${conn.rpcEndpoint} (${await clusterOf(conn)})
  payer        ${payer.publicKey}  holds ${sol(await conn.getBalance(payer.publicKey))}
  fee wallet   ${feeWallet}  (feeClaimer, withdraw-withheld authority, leftover receiver, owner of the locked LP)
  token        Token-2022, ${TRANSFER_FEE_BPS / 100}% transfer fee, rate locked for good; metadata authority: ${o.tokenAuthority}
  curve        quoted in ${Q.sym}: market cap ${o.startMcap} ${Q.sym} -> graduates at ${o.gradMcap} ${Q.sym} after ${money(plan.thresholdLamports, quote)} raised; pool fee ${o.poolFeeBps / 100}%
  config       ${config}  (anyone who launches a token with this address gets exactly these settings)
`);
  // A dry run ends by unwinding, not process.exit(): exit right after network calls aborts Node on Windows (libuv assertion, exit 0xC0000409).
  if (args.go) {
    saveSecret(join(stateDir, `config-${config.toBase58()}.json`), configKp);
    const sender = makeSender({ conn, dir: stateDir, name: "create-config" });
    const r = await sender.send("config", ixs, [payer, configKp]);
    const onChain = await client.state.getPoolConfig(config);
    if (!onChain) refuse(`The config isn't on chain yet (${r.status}, ${r.sig}). Check the signature before trying again.`);
    const bad = configMismatches(onChain, { feeWallet, poolFeeBps: o.poolFeeBps, tokenAuthorityCode: TOKEN_AUTHORITY[o.tokenAuthority], thresholdLamports: plan.thresholdLamports, sqrtStartPrice: BigInt(cfg.sqrtStartPrice.toString()), quote });
    if (bad.length) refuse(`The config on chain differs from the plan:\n  ${bad.join("\n  ")}`);
    writeJson(join(stateDir, `config-${config.toBase58()}.info.json`), { config: config.toBase58(), feeWallet: feeWallet.toBase58(), ...o, sig: r.sig, at: new Date().toISOString() });
    console.log(`Done and checked on chain.\nDBC config: ${config}\nPaste that into the launch tool's "DBC Config" field.`);
  }
} catch (e) { console.error(e instanceof Refuse ? "REFUSING: " + e.message : e.stack || String(e)); process.exitCode = 1; }
