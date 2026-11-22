// One fake chain + Jupiter for the round tests (drop, launch-fixes, review-money, round). The state object S is plain data
// the tests poke; `installFakes` answers fetch for https://rpc.test, https://cron.test and https://jup.test:
//   RPC      the calls the tick, the poller and the fee engine make: the mint's bytes (withdraw authority, withheld), the payout
//            wallet's USDC and CULT accounts, the pool vault's bytes, simulateTransaction against the last Jupiter quote, and
//            getProgramAccounts []. A landed sweep moves the vault's / mint's withheld CULT into the treasury (S.cult).
//   Jupiter  /price/v3, /swap/v1/quote and /swap/v1/swap-instructions in the real JSON shape (test/fakes.js).
// A swap is recognised by the Jupiter program in its static keys; one that sells the mint is the CULT leg.
import { VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import { sigOf, usdcAta } from "../src/chain.js";
import { treasuryAta, feeOn } from "../src/token22.js";
import { JUPITER_PROGRAM } from "../src/jupiter.js";
import { USDC_MINT } from "../src/config.js";
import { mintAccount, tokenAccount, jupQuote, jupSwapInstructions, simulation, SOL, b64, addr, pda } from "./fakes.js";

export const TOK = 1_000_000n; // 6 decimals
// The swap waits 2.5 s a look for its confirmation: don't. Returns the restore function.
export function fastTimers() {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => real(fn, ms >= 1000 ? 0 : ms, ...a);
  return () => { globalThis.setTimeout = real; };
}
export class RpcError extends Error { constructor(code, message) { super(message); this.code = code; } }
export const makeVault = () => ({ account: addr(), owner: pda() }); // a pool vault: its owner has no key
export const CLEAR = ["sells", "sellers", "holders", "drops", "payouts", "batches", "kv", "token_accounts", "trades", "fee_accounts", "fee_batches"];

// A local D1 with every migration applied and the env the round tests run in. Refunds are dry here (a test about refunds turns
// them on): the webhook and the tick then never send a refund while a round is under test.
export async function boot(persist, { MINT, PAYOUT, kp, ...over }) {
  rmSync(persist, { recursive: true, force: true });
  execSync(`node node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --local --persist-to ${persist}`, { stdio: "ignore", env: { ...process.env, CI: "1" } });
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc", persist: { path: persist + "/v3" } }); // the CLI nests under v3
  const env = {
    ...proxy.env, DEMO: "0", DRY_RUN: "0", REFUNDS_DRY_RUN: "1", SOL_RESERVE_LAMPORTS: "50000000" /* not the file's launch value: tests pin what they test */, MINT, PAYOUT_WALLET: PAYOUT, EXCLUDE: "", DBC_CONFIG: "",
    SOLANA_RPC_URL: "https://rpc.test", JUP_API: "https://jup.test", HELIUS_WEBHOOK_SECRET: "s3cret", HELIUS_KEY: "", CRON_RPC_URL: "",
    PAYOUT_SECRET_KEY: JSON.stringify([...kp.secretKey]), ASSETS: { fetch: () => new Response("") }, ...over,
  };
  return { proxy, env };
}

export const freshS = ({ PAYOUT, vault }) => ({
  vault,
  balances: new Map([[vault.owner, 500_000_000n * TOK], [PAYOUT, 1n]]), // the pool and the treasury: never paid either way
  atas: new Set(), atasAll: false, // holders' USDC accounts that exist (atasAll: every one does)
  sol: 2_000_000_000,         // payout wallet SOL
  usdc: 0n, usdcFinal: null,  // usdcFinal set: reads without commitment "confirmed" see that instead
  cult: 0n,                   // the treasury's CULT (raw): what the CULT leg sells
  vaultWithheld: 0n, mintWithheld: 0n, // withheld CULT in the pool vault and in the mint, until a sweep lands
  authority: PAYOUT,          // the mint's withdraw-withheld authority (the tick refuses unless it is PAYOUT_WALLET)
  mintBytes: undefined, mintFails: false, // the mint account as the RPC gives it (null: not there), or a failing read
  treasuryExists: true, usdcExists: true, // false: the treasury's CULT account / the payout wallet's USDC account are not on chain yet (a new deployment)
  accounts: new Map(),        // other token accounts by address (bytes): wallet accounts the refund engine can read and empty
  height: 1000, sent: [], calls: [],
  status: () => ({ confirmationStatus: "confirmed", err: null }), // for sigs that were sent; null = not seen
  onSend: null, onSwap: null, das: null, sigs: [], sigsFail: false, getTx: null,
  solUsd: 200, tokenUsd: 0.001,
  swapOut: () => 30_000_000n,  // (amount, inputMint) -> raw USDC the quote promises
  impact: "0.0001",           // Jupiter's priceImpactPct: a fraction, or (amount) => fraction; it counts the coin's own tax
  instructionsHook: null,     // (answer) => void: change Jupiter's swap-instructions answer (hostile tests)
  simShort: 0n, simTake: 0n, simErr: null, // the simulation pays out this much less / takes this much more / fails
  simOther: 0n,               // a USDC -> SOL simulation that also takes this much raw CULT out of the treasury
  lastSwapOut: 0n, lastSwapMeta: null, quotes: [],
});

export const isSwap = (x) => x.tx.message.staticAccountKeys.some((k) => k.toBase58() === JUPITER_PROGRAM);
export const touches = (x, a) => x.tx.message.staticAccountKeys.some((k) => k.toBase58() === a);

// A Helius enhanced sell: the wallet loses `gross` raw to a vault that has no key; the vault gains gross less the 10% withheld.
export function enhancedSell({ sig, wallet, at, gross, MINT, vault, account = addr() }) {
  const g = BigInt(gross), net = g - feeOn(g, 1000);
  const bc = (userAccount, tokenAccount, amount) => ({ account: tokenAccount, nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount, tokenAccount, mint: MINT, rawTokenAmount: { tokenAmount: String(amount), decimals: 6 } }] });
  return { signature: sig, timestamp: Math.floor(at / 1000), slot: 1, feePayer: wallet, transactionError: null, tokenTransfers: [], accountData: [bc(wallet, account, -g), bc(vault.owner, vault.account, net)] };
}
// A Helius enhanced buy: the vault loses `gross`; the wallet gets it less the 10% withheld in its own account.
export function enhancedBuy({ sig, wallet, at, gross, MINT, vault, account = addr() }) {
  const g = BigInt(gross), net = g - feeOn(g, 1000);
  const bc = (userAccount, tokenAccount, amount) => ({ account: tokenAccount, nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount, tokenAccount, mint: MINT, rawTokenAmount: { tokenAmount: String(amount), decimals: 6 } }] });
  return { signature: sig, timestamp: Math.floor(at / 1000), slot: 1, feePayer: wallet, transactionError: null, tokenTransfers: [], accountData: [bc(vault.owner, vault.account, -g), bc(wallet, account, net)] };
}
export const postHook = (worker, env, txs, auth = "s3cret") => worker.fetch(new Request("http://x/api/hook", { method: "POST", headers: { authorization: auth }, body: JSON.stringify(txs) }), env);

export function installFakes({ S: getS, MINT, PAYOUT, env: getEnv }) {
  const realFetch = globalThis.fetch;
  const treasury = treasuryAta(MINT, PAYOUT).toBase58();
  const usdcOf = () => usdcAta(PAYOUT, getEnv()).toBase58();
  const T22 = TOKEN_2022_PROGRAM_ID.toBase58();

  // What a landed Token-2022 withdraw-withheld transaction does to the fake: the vault's / mint's withheld CULT reaches the treasury.
  function land(S, tx) {
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    for (const ix of tx.message.compiledInstructions) {
      if (keys[ix.programIdIndex] === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" && keys[ix.accountKeyIndexes[1]] === treasury) S.treasuryExists = true; // create-idempotent
      if (keys[ix.programIdIndex] !== T22 || ix.data[0] !== 26) continue;
      const a = [...ix.accountKeyIndexes].map((i) => keys[i]);
      if (ix.data[1] === 3 && a[1] === a[3] && S.accounts.has(a[1])) { // a refund: the account's own withheld tokens back into it
        const dv = new DataView(S.accounts.get(a[1]).buffer), w = dv.getBigUint64(174, true);
        dv.setBigUint64(64, dv.getBigUint64(64, true) + w, true); dv.setBigUint64(174, 0n, true);
        continue;
      }
      if (ix.data[1] === 2) { S.cult += S.mintWithheld; S.mintWithheld = 0n; }
      else if (ix.data[1] === 3 && a[1] === treasury) { // a sweep: every listed source gives its withheld CULT to the treasury
        for (const src of a.slice(3)) {
          if (src === S.vault.account) { S.cult += S.vaultWithheld; S.vaultWithheld = 0n; }
          else if (S.accounts.has(src)) { const dv = new DataView(S.accounts.get(src).buffer); S.cult += dv.getBigUint64(174, true); dv.setBigUint64(174, 0n, true); }
        }
      }
    }
  }

  async function rpcResult(method, params) {
    const S = getS();
    switch (method) {
      case "getAccountInfo": return { value: { owner: T22, data: { parsed: { type: "mint", info: { decimals: 6 } } } } };
      case "getTokenAccounts": return S.das ? S.das(params) : { token_accounts: [...S.balances].map(([owner, a]) => ({ owner, amount: a.toString() })), cursor: null };
      case "getProgramAccounts": { // the backstop scan: every token account of the mint (base64); the holder fallback asks for jsonParsed and gets none
        if (params[1]?.encoding !== "base64") return [];
        const all = [...S.accounts].map(([pubkey, bytes]) => [pubkey, bytes]);
        if (S.vaultWithheld > 0n) all.push([S.vault.account, tokenAccount({ mint: MINT, owner: S.vault.owner, amount: 500_000_000n * TOK, withheld: S.vaultWithheld })]);
        return all.map(([pubkey, bytes]) => ({ pubkey, account: { data: [b64(bytes), "base64"] } }));
      }
      case "getMultipleAccounts": {
        if (S.mintFails && params[0].includes(MINT)) throw new RpcError(-32000, "node is behind");
        if (params[1]?.dataSlice) return { value: params[0].map((a) => (S.atasAll || S.atas.has(a) ? { lamports: 2_039_280 } : null)) }; // "does the holder's USDC account exist"
        const bytes = (a) => a === MINT ? (S.mintBytes !== undefined ? S.mintBytes : mintAccount({ withdraw: S.authority, withheld: S.mintWithheld }))
          : a === usdcOf() ? (S.usdcExists ? tokenAccount({ mint: USDC_MINT, owner: PAYOUT, amount: S.usdc, ext: false }) : null)
          : a === treasury ? (S.treasuryExists ? tokenAccount({ mint: MINT, owner: PAYOUT, amount: S.cult }) : null)
          : S.accounts.has(a) ? S.accounts.get(a).slice()
          : a === S.vault.account ? tokenAccount({ mint: MINT, owner: S.vault.owner, amount: 500_000_000n * TOK, withheld: S.vaultWithheld }) : null;
        return { value: params[0].map((a) => { const b = bytes(a); return b ? { lamports: 1_461_600, data: [b64(b), "base64"] } : null; }) };
      }
      case "getBalance": return { value: S.sol };
      case "getTokenAccountBalance": {
        if (params[0] === treasury) { if (!S.treasuryExists) throw new RpcError(-32602, "Invalid param: could not find account"); return { value: { amount: String(S.cult) } }; }
        if (!S.usdcExists) throw new RpcError(-32602, "Invalid param: could not find account");
        const confirmed = ["confirmed", "processed"].includes(params[1]?.commitment);
        return { value: { amount: String(S.usdcFinal != null && !confirmed ? S.usdcFinal : S.usdc) } };
      }
      case "getBlockHeight": return S.height;
      case "getRecentPrioritizationFees": return []; // no history: the sweep pays its floor
      case "getLatestBlockhash": return { value: { blockhash: addr(), lastValidBlockHeight: S.height + 150 } };
      case "sendTransaction": {
        const tx = VersionedTransaction.deserialize(Buffer.from(params[0], "base64"));
        const sig = sigOf(tx);
        if (S.onSend) await S.onSend(tx, sig);
        S.sent.push({ sig, tx });
        if (isSwap({ tx }) && S.lastSwapMeta && S.lastSwapMeta.outputMint === SOL) { // the refill lands: USDC out, native SOL in (Jupiter closes the wrapped-SOL account to the wallet)
          S.usdc -= BigInt(S.lastSwapMeta.amount); S.sol += Number(S.lastSwapOut);
        } else if (isSwap({ tx }) && S.lastSwapMeta) { // the fake Jupiter swap lands: USDC in, and the CULT out when it was a CULT sale
          S.usdc += S.lastSwapOut; S.usdcExists = true; // Jupiter's setup opens the payout wallet's USDC account
          if (S.lastSwapMeta.inputMint === MINT) S.cult -= BigInt(S.lastSwapMeta.amount);
        }
        land(S, tx);
        return sig;
      }
      case "simulateTransaction": {
        const m = S.lastSwapMeta;
        const toSol = m.outputMint === SOL, fromUsdc = m.inputMint === USDC_MINT; // the refill: USDC -> native SOL
        return simulation(params, (a) => {
          if (a === PAYOUT) return { lamports: BigInt(S.sol) - (m.inputMint === SOL ? BigInt(m.amount) + S.simTake : 0n) + (toSol ? S.lastSwapOut - S.simShort : 0n) };
          if (a === usdcOf()) return { lamports: 2_039_280, bytes: tokenAccount({ mint: USDC_MINT, owner: PAYOUT, amount: fromUsdc ? S.usdc - BigInt(m.amount) - S.simTake : S.usdc + S.lastSwapOut - S.simShort, ext: false }) };
          if (a === treasury) { const left = S.cult - (fromUsdc ? S.simOther : BigInt(m.amount) + S.simTake); return { lamports: 2_039_280, bytes: tokenAccount({ mint: MINT, owner: PAYOUT, amount: left < 0n ? 0n : left }) }; } // a run that lost a race sells what is already gone
          return null;
        }, { err: S.simErr });
      }
      case "getSignatureStatuses": return { value: params[0].map((s) => (S.sent.some((x) => x.sig === s) ? S.status(s) : null)) };
      case "getSignaturesForAddress": {
        if (S.sigsFail) throw new RpcError(-32000, "node is behind");
        const i = params[1]?.until ? S.sigs.findIndex((s) => s.signature === params[1].until) : -1;
        return i < 0 ? S.sigs : S.sigs.slice(0, i);
      }
      case "getTransaction":
        if (S.getTx) return S.getTx(params[0], params[1]);
        return S.sent.some((x) => x.sig === params[0]) && S.status(params[0]) ? { meta: { err: null } } : null; // asked before an expired batch is re-sent
      default: throw new Error("unmocked " + method);
    }
  }

  globalThis.fetch = async (input, init) => {
    const S = getS(), url = String(input?.url || input);
    if (url.startsWith("https://rpc.test") || url.startsWith("https://cron.test")) {
      const { method, params } = JSON.parse(init.body);
      S.calls.push({ method, params, url });
      try { return Response.json({ jsonrpc: "2.0", id: 1, result: await rpcResult(method, params) }); }
      catch (e) { if (e instanceof RpcError) return Response.json({ jsonrpc: "2.0", id: 1, error: { code: e.code, message: e.message } }); throw e; }
    }
    if (url.startsWith("https://jup.test/price")) {
      S.priceCalls = (S.priceCalls || 0) + 1;
      if (S.priceDown) return new Response("busy", { status: 503 });
      return Response.json({ [SOL]: { usdPrice: S.solUsd }, [MINT]: { usdPrice: S.tokenUsd } });
    }
    if (url.startsWith("https://jup.test/swap/v1/quote")) {
      const q = new URL(url).searchParams, amount = q.get("amount"), inputMint = q.get("inputMint");
      S.quotes.push({ inputMint, amount });
      return Response.json(jupQuote({ inputMint, outputMint: q.get("outputMint"), amount, out: S.swapOut(BigInt(amount), inputMint), impact: typeof S.impact === "function" ? S.impact(BigInt(amount)) : S.impact }));
    }
    if (url.startsWith("https://jup.test/swap/v1/swap-instructions")) {
      if (S.onSwap) await S.onSwap();
      const b = JSON.parse(init.body), q = b.quoteResponse;
      S.lastSwapOut = BigInt(q.outAmount);
      S.lastSwapMeta = { inputMint: q.inputMint, outputMint: q.outputMint, amount: q.inAmount };
      const prog = (m) => (m === MINT ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
      const answer = jupSwapInstructions({ user: b.userPublicKey, inputMint: q.inputMint, outputMint: q.outputMint, inputProgram: prog(q.inputMint), outputProgram: prog(q.outputMint), amount: q.inAmount });
      if (S.instructionsHook) S.instructionsHook(answer);
      return Response.json(answer);
    }
    return realFetch(input, init);
  };
  return () => { globalThis.fetch = realFetch; };
}
