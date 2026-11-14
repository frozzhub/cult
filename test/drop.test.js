// End to end against a local D1 (wrangler's getPlatformProxy) with Solana RPC and Jupiter faked:
// webhook sells -> tick (snapshot, swap, allocate, send) -> tick (confirm) -> API shows it.
// Also: a batch whose blockhash expired is re-sent once, and confirmed batches are never re-sent.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import worker from "../src/index.js";
import { tick } from "../src/indexer.js";
import { sigOf } from "../src/chain.js";

const PERSIST = ".wrangler/test-state";
const addr = () => Keypair.generate().publicKey.toBase58();
const kp = Keypair.generate();
const MINT = addr(), POOL = addr(), TEAM = addr(), PAYOUT = kp.publicKey.toBase58();
const BH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";
const HOUR = 3_600_000;

let proxy, env;
const holders = Array.from({ length: 21 }, () => addr());
const balances = new Map(holders.map((w, i) => [w, BigInt((i + 1) * 100_000) * 1_000_000n])); // 100k..2.1M tokens
balances.set(holders[0], 10_000n * 1_000_000n); // $10 at $0.001: below the minimum
balances.set(POOL, 500_000_000n * 1_000_000n);
balances.set(TEAM, 50_000_000n * 1_000_000n);
balances.set(PAYOUT, 1n);

// ---- fake chain ----
const chainState = { sent: [], confirmed: new Set(), height: 1000, usdc: 0n, lose: null };
const realFetch = globalThis.fetch;
function fakeRpc(method, params) {
  switch (method) {
    case "getAccountInfo": return { value: { owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", data: { parsed: { type: "mint", info: { decimals: 6 } } } } };
    case "getTokenAccounts": return { token_accounts: [...balances].map(([owner, amount]) => ({ owner, amount: Number(amount) })), cursor: null };
    case "getMultipleAccounts": return { value: params[0].map((_, i) => (i % 2 ? { lamports: 1 } : null)) };
    case "getBalance": return { value: 2_000_000_000 };
    case "getTokenAccountBalance": return { value: { amount: chainState.usdc.toString() } };
    case "getBlockHeight": return chainState.height;
    case "getLatestBlockhash": return { value: { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: chainState.height + 150 } };
    case "sendTransaction": {
      const tx = VersionedTransaction.deserialize(Buffer.from(params[0], "base64"));
      const sig = sigOf(tx);
      chainState.sent.push({ sig, tx });
      if (chainState.lose !== sig) chainState.confirmed.add(sig);
      if (tx.message.staticAccountKeys.length === 2) chainState.usdc += 30_000_000n; // the swap: +30 USDC
      return sig;
    }
    case "getSignatureStatuses": return { value: params[0].map((s) => (chainState.confirmed.has(s) ? { confirmationStatus: "confirmed", err: null } : null)) };
    default: throw new Error("unmocked " + method);
  }
}
const SOL = "So11111111111111111111111111111111111111112";
globalThis.fetch = async (input, init) => {
  const url = String(input?.url || input);
  if (url.startsWith("https://rpc.test")) {
    const { method, params } = JSON.parse(init.body);
    return Response.json({ jsonrpc: "2.0", id: 1, result: fakeRpc(method, params) });
  }
  if (url.startsWith("https://jup.test/price")) return Response.json({ [SOL]: { usdPrice: 200 }, [MINT]: { usdPrice: 0.001 } });
  if (url.startsWith("https://jup.test/swap/v1/quote")) return Response.json({ outAmount: "30000000" });
  if (url.startsWith("https://jup.test/swap/v1/swap")) {
    const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: BH, instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 })] }).compileToV0Message();
    return Response.json({ swapTransaction: Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64"), lastValidBlockHeight: chainState.height + 150 });
  }
  return realFetch(input, init);
};

before(async () => {
  rmSync(PERSIST, { recursive: true, force: true });
  execSync(`node node_modules/wrangler/bin/wrangler.js d1 migrations apply paper-hands --local --persist-to ${PERSIST}`, { stdio: "ignore", env: { ...process.env, CI: "1" } });
  proxy = await getPlatformProxy({ configPath: "wrangler.jsonc", persist: { path: PERSIST + "/v3" } }); // the CLI nests under v3
  env = {
    ...proxy.env, DEMO: "0", DRY_RUN: "0", MINT, POOL_ACCOUNT: POOL, PAYOUT_WALLET: PAYOUT, EXCLUDE: TEAM,
    SOLANA_RPC_URL: "https://rpc.test", JUP_API: "https://jup.test", HELIUS_WEBHOOK_SECRET: "s3cret",
    PAYOUT_SECRET_KEY: JSON.stringify([...kp.secretKey]),
    ASSETS: { fetch: () => new Response("") },
  };
});
after(async () => { await proxy?.dispose(); globalThis.fetch = realFetch; });

const hook = (txs, auth = "s3cret") => worker.fetch(new Request("http://x/api/hook", { method: "POST", headers: { authorization: auth }, body: JSON.stringify(txs) }), env);
const api = async (p) => (await worker.fetch(new Request("http://x" + p), env)).json();

test("an hour of sells turns into one airdrop, paid exactly once", async () => {
  const t0 = Math.floor(Date.now() / HOUR) * HOUR - HOUR; // last hour
  const sellers = [holders[5], holders[9], addr()];
  const txs = sellers.map((w, i) => ({
    signature: "sell" + i, timestamp: Math.floor((t0 + 600_000 * (i + 1)) / 1000), feePayer: w, fee: 5000,
    tokenTransfers: [{ fromUserAccount: w, toUserAccount: POOL, mint: MINT, tokenAmount: 1_000_000 }],
    accountData: [{ account: PAYOUT, nativeBalanceChange: 100_000_000 }, { account: w, nativeBalanceChange: 566_000_000 }],
  }));
  assert.equal((await hook(txs, "wrong")).status, 401);
  assert.equal((await (await hook(txs)).json()).added, 3);
  assert.equal((await (await hook(txs)).json()).added, 0, "Helius retries are ignored");

  // Lose one payout tx so we can check it's re-sent after its blockhash expires.
  const r1 = await tick(env);
  assert.equal(r1.status, "paying", JSON.stringify(r1));
  const d = await env.DB.prepare("SELECT * FROM drops").first();
  assert.equal(d.fee_lamports, 300_000_000);
  assert.ok(d.swap_sig && d.swap_sig !== "dry-run");

  const batches = (await env.DB.prepare("SELECT * FROM batches ORDER BY i").all()).results;
  assert.equal(batches.length, 3, "20 eligible holders / 8 per tx"); // 21 holders, 1 under $50; pool, team, payout excluded
  const payouts = (await env.DB.prepare("SELECT * FROM payouts WHERE micro > 0").all()).results;
  assert.equal(payouts.length, 20);
  assert.ok(!payouts.some((p) => [POOL, TEAM, PAYOUT, holders[0]].includes(p.wallet)));
  const total = payouts.reduce((a, p) => a + p.micro, 0);
  assert.ok(total <= 30_000_000 && total > 29_999_000, "pays the whole 30 USDC minus rounding dust");

  // Second tick: one batch got lost. Not expired yet -> left alone.
  const lostSig = batches[1].sig;
  chainState.confirmed.delete(lostSig);
  const sentBefore = chainState.sent.length;
  assert.equal((await tick(env)).status, "paying");
  assert.equal(chainState.sent.length, sentBefore, "nothing re-sent while the old tx could still land");

  // Blockhash expires -> re-sent once, then it confirms.
  chainState.height += 1000;
  await tick(env); // marks it pending and re-sends in the same tick
  const resent = chainState.sent.slice(sentBefore);
  assert.equal(resent.length, 1, "only the lost batch is re-sent");
  const r4 = await tick(env);
  assert.equal(r4.status, "done", JSON.stringify(r4));

  const final = await env.DB.prepare("SELECT * FROM drops").first();
  assert.equal(final.holders, 20);
  assert.equal(final.usdc_micro, total);
  const payoutSigs = chainState.sent.filter((s) => s.sig !== d.swap_sig).map((s) => s.sig);
  assert.equal(new Set(payoutSigs).size, payoutSigs.length, "no transaction sent twice");

  // Nothing new until the next hour.
  assert.deepEqual(await tick(env), { idle: true });
});

test("the API shows the airdrop, the Wall and a holder's share", async () => {
  const s = await api("/api/state");
  assert.equal(s.live, true);
  assert.equal(s.drops.length, 1);
  assert.equal(s.drops[0].n, 1);
  assert.ok(s.drops[0].tx);
  assert.ok(Math.abs(s.totals.paidUsdc - 30) < 0.01);
  assert.equal(s.wall.top.length, 3);
  assert.equal(Math.round(s.wall.top[0].paidUsdc), 20); // 0.1 SOL at $200
  assert.equal(s.pending, 0);

  const rich = holders[20];
  const w = await api("/api/wallet/" + rich);
  assert.equal(w.balance, 2_100_000);
  assert.equal(w.eligible, true);
  assert.ok(w.share > 0.09 && w.share < 0.11, String(w.share));
  assert.ok(Math.abs(w.receivedUsdc - 30 * 2.1 / 23) < 0.001, String(w.receivedUsdc)); // 2.1M of 23M weighted tokens
});

test("DRY_RUN completes the next airdrop without sending anything", async () => {
  const next = Math.floor(Date.now() / HOUR) * HOUR;
  const w = holders[7];
  await hook([{ signature: "dry1", timestamp: Math.floor((next + 60_000) / 1000), feePayer: w, fee: 5000,
    tokenTransfers: [{ fromUserAccount: w, toUserAccount: POOL, mint: MINT, tokenAmount: 5 }],
    accountData: [{ account: PAYOUT, nativeBalanceChange: 50_000_000 }, { account: w, nativeBalanceChange: 1 }] }]);
  const sentBefore = chainState.sent.length;
  const r = await tick({ ...env, DRY_RUN: "1" }, next + HOUR + 60_000);
  assert.equal(r.status, "done", JSON.stringify(r));
  assert.equal(chainState.sent.length, sentBefore, "nothing signed or sent");
  const d = await env.DB.prepare("SELECT * FROM drops ORDER BY n DESC").first();
  assert.equal(d.usdc_micro > 9_000_000 && d.usdc_micro <= 10_000_000, true, String(d.usdc_micro)); // 0.05 SOL at $200
});