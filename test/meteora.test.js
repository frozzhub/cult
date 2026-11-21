// Meteora launch: real devnet transactions in, trades/fees/refunds out. Then the refund payer end to end
// against a local D1 with the chain faked: every buy gets its 10% back exactly once.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { getPlatformProxy } from "wrangler";
import { Keypair, VersionedTransaction, SystemProgram, SystemInstruction, TransactionMessage } from "@solana/web3.js";
import { parseSwaps, recordSwaps, payRefunds, buildRefundTx, txKeys } from "../src/meteora.js";
import { config } from "../src/config.js";
import { weigh } from "../src/indexer.js";
import { sigOf } from "../src/chain.js";

const fx = (n) => JSON.parse(readFileSync(`test/fixtures/meteora-${n}.json`, "utf8"));
// The devnet launch these fixtures come from (program-keys/devnet-meteora.json).
const MINT = "EPZ4DMTfVdRHDk7dZepBm5DkpW2gNUZa5uXxicPya49u", POOL = "ELY4npxK6fYunq28Vm4JfPma85ARcW7aAg5xHG33NkJh";
const VAULTS = "75fsZKQoTw4uTZW5w36qHVXMELqqhK4HcueYAQesMXW9:CRqoNrVSJ5cbwPz7TpZah3tGgAcDjE93eTQJ2zc5Hugn";
const TRADER = "DKWtaJzTYdtNy2CsGXhP4TXtQEYkhmTvDBp45C9na5H";
const kp = Keypair.generate();
const cfg = config({ MINT, POOL_ACCOUNT: POOL, VAULTS, PAYOUT_WALLET: kp.publicKey.toBase58(), DRY_RUN: "0" });

test("config: VAULTS switches the engine to Meteora with a 10% fee", () => {
  assert.equal(cfg.venue, "meteora");
  assert.equal(cfg.feeBps, 1000);
  assert.deepEqual(cfg.vaults, [{ base: VAULTS.split(":")[0], quote: VAULTS.split(":")[1] }]);
  assert.equal(config({}).venue, "pool");
});

test("parseSwaps: a real devnet buy -> the buyer is refunded exactly the 10% they paid", () => {
  const [b] = parseSwaps("buy1", fx("buy"), cfg);
  assert.equal(b.side, "buy");
  assert.equal(b.gross, 50_000_000);          // 0.05 SOL in
  assert.equal(b.fee, 5_000_000);             // 10% = what the pool recorded (4M partner + 1M protocol)
  assert.deepEqual(b.buyers, [{ wallet: TRADER, lamports: 5_000_000 }]);
  assert.ok(b.tokens > 244_000_000 && b.tokens < 245_000_000);
});

test("parseSwaps: a real devnet sell -> its fee is 10% of the gross", () => {
  const [s] = parseSwaps("sell1", fx("sell"), cfg);
  assert.equal(s.side, "sell");
  assert.equal(s.wallet, TRADER);
  assert.equal(s.net, 22_297_752);                 // what the seller got
  assert.equal(s.fee, 2_477_528);                  // pool recorded 1,982,023 partner + 495,505 protocol
  assert.equal(s.gross, s.net + s.fee);
});

test("parseSwaps: launching the pool isn't a trade; nothing without vaults", () => {
  assert.deepEqual(parseSwaps("l", fx("launch"), cfg), []);
  assert.deepEqual(parseSwaps("b", fx("buy"), config({ MINT })), []);
  assert.deepEqual(parseSwaps("x", { ...fx("buy"), meta: { ...fx("buy").meta, err: { x: 1 } } }, cfg), []);
});

test("parseSwaps: a bundle buying for two wallets splits the refund by tokens received", () => {
  const tx = structuredClone(fx("buy"));
  const other = Keypair.generate().publicKey.toBase58();
  const b = tx.meta.postTokenBalances.find((x) => x.owner === TRADER);
  const half = (BigInt(b.uiTokenAmount.amount) / 4n);
  tx.meta.postTokenBalances.push({ ...b, accountIndex: 99, owner: other, uiTokenAmount: { ...b.uiTokenAmount, amount: String(half) } });
  b.uiTokenAmount.amount = String(BigInt(b.uiTokenAmount.amount) - half);
  const [s] = parseSwaps("bundle", tx, cfg);
  assert.equal(s.buyers.length, 2);
  assert.ok(Math.abs(s.buyers.reduce((a, x) => a + x.lamports, 0) - 5_000_000) <= 2);
  assert.ok(s.buyers[0].lamports > s.buyers[1].lamports * 2.9);
});

test("txKeys: lookup-table addresses count (Jupiter routes use them)", () => {
  const tx = { transaction: { message: { accountKeys: ["a", "b"] } }, meta: { loadedAddresses: { writable: ["c"], readonly: ["d"] } } };
  assert.deepEqual(txKeys(tx), ["a", "b", "c", "d"]);
});

test("weigh: the pool's vault authority never gets an airdrop", () => {
  const holders = new Map([["FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM", 10n ** 15n], [TRADER, 10n ** 14n]]);
  const rows = weigh(cfg, { holders, since: new Map(), lastSell: new Map(), decimals: 6, price: 1, now: Date.now() });
  assert.deepEqual(rows.map((r) => r.wallet), [TRADER]);
});

/* ---- refunds end to end (local D1, chain faked) ---- */

const PERSIST = ".wrangler/test-meteora";
let proxy, env;
const chainState = { balance: 2_000_000_000, sent: [], lose: new Set(), confirmed: new Set(), height: 100, claims: 0 };
const realFetch = globalThis.fetch;
before(async () => {
  rmSync(PERSIST, { recursive: true, force: true });
  execSync(`node node_modules/wrangler/bin/wrangler.js d1 migrations apply paper-hands --local --persist-to ${PERSIST}`, { stdio: "ignore", env: { ...process.env, CI: "1" } });
  proxy = await getPlatformProxy({ configPath: "wrangler.jsonc", persist: { path: PERSIST + "/v3" } });
  env = { ...proxy.env, HELIUS_KEY: "", SOLANA_RPC_URL: "https://rpc.test", PAYOUT_SECRET_KEY: JSON.stringify([...kp.secretKey]) };
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url || input);
    if (!url.startsWith("https://rpc.test")) return realFetch(input, init);
    const { method, params } = JSON.parse(init.body);
    const result = (() => {
      switch (method) {
        case "getBalance": return { value: chainState.balance };
        case "getLatestBlockhash": return { value: { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: chainState.height + 150 } };
        case "getBlockHeight": return chainState.height;
        case "sendTransaction": {
          const tx = VersionedTransaction.deserialize(Buffer.from(params[0], "base64"));
          const sig = sigOf(tx);
          chainState.sent.push(tx);
          if (!chainState.lose.has(chainState.sent.length)) chainState.confirmed.add(sig);
          return sig;
        }
        case "getSignatureStatuses": return { value: params[0].map((s) => (chainState.confirmed.has(s) ? { confirmationStatus: "confirmed", err: null } : null)) };
        default: throw new Error("unmocked " + method);
      }
    })();
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  };
});
after(async () => { await proxy?.dispose(); globalThis.fetch = realFetch; });

const transfers = (tx) => tx.message.compiledInstructions
  .filter((ix) => tx.message.staticAccountKeys[ix.programIdIndex].equals(SystemProgram.programId))
  .map((ix) => ({ to: tx.message.staticAccountKeys[ix.accountKeyIndexes[1]].toBase58(), lamports: Number(Buffer.from(ix.data).readBigUInt64LE(4)) }));

test("refunds: a buy is paid back once, even when the webhook and poller both see it", async () => {
  const live = { ...cfg, solReserve: 50_000_000 };
  const swaps = parseSwaps("buy-sig-1111", fx("buy"), live);
  assert.equal(await recordSwaps(env, live, swaps, 200), 1);
  assert.equal(await recordSwaps(env, live, swaps, 200), 0, "seen twice, queued once");
  const r = await payRefunds(env, live, { claim: async () => {} });
  assert.equal(r.sent, 1);
  assert.deepEqual(transfers(chainState.sent[0]), [{ to: TRADER, lamports: 5_000_000 }]);
  const r2 = await payRefunds(env, live, { claim: async () => {} });
  assert.equal(r2.confirmed, 1);
  assert.equal(chainState.sent.length, 1, "never sent twice");
  const row = await env.DB.prepare("SELECT * FROM refunds").first();
  assert.equal(row.status, "confirmed");
  const t = await env.DB.prepare("SELECT * FROM trades WHERE sig = 'buy-sig-1111'").first();
  assert.equal(t.side, "buy");
});

test("refunds: a lost refund is re-sent only after its blockhash expires", async () => {
  const live = { ...cfg, solReserve: 50_000_000 };
  chainState.lose.add(chainState.sent.length + 1);
  await recordSwaps(env, live, parseSwaps("buy-sig-2222", fx("buy"), live), 200);
  await payRefunds(env, live, { claim: async () => {} });
  const n = chainState.sent.length;
  await payRefunds(env, live, { claim: async () => {} });
  assert.equal(chainState.sent.length, n, "still could land: left alone");
  chainState.height += 500;
  await payRefunds(env, live, { claim: async () => {} });
  assert.equal(chainState.sent.length, n + 1, "expired: re-sent once");
  await payRefunds(env, live, { claim: async () => {} });
  assert.equal((await env.DB.prepare("SELECT status FROM refunds WHERE sig = 'buy-sig-2222'").first()).status, "confirmed");
});

test("refunds: a short treasury claims the pool fees first, and waits if that isn't enough", async () => {
  const live = { ...cfg, solReserve: 50_000_000 };
  chainState.balance = 52_000_000; // below reserve + refund
  let claimed = 0;
  await recordSwaps(env, live, parseSwaps("buy-sig-3333", fx("buy"), live), 200);
  const r = await payRefunds(env, live, { claim: async () => { claimed++; } });
  assert.equal(claimed, 1);
  assert.equal(r.waiting, 1);
  assert.equal((await env.DB.prepare("SELECT status FROM refunds WHERE sig = 'buy-sig-3333'").first()).status, "pending");
  chainState.balance = 2_000_000_000; // fees came in
  assert.equal((await payRefunds(env, live, { claim: async () => { claimed++; } })).sent, 1);
});

test("sells: recorded for the Wall with the fee they paid; no refund", async () => {
  const live = { ...cfg };
  assert.equal(await recordSwaps(env, live, parseSwaps("sell-sig-1", fx("sell"), live), 200), 0);
  const s = await env.DB.prepare("SELECT * FROM sells WHERE sig = 'sell-sig-1'").first();
  assert.equal(s.fee_lamports, 2_477_528);
  assert.equal(s.wallet, TRADER);
});

test("buildRefundTx: one transfer to the buyer, with a memo", () => {
  const tx = buildRefundTx(kp, Keypair.generate().publicKey.toBase58(), { wallet: TRADER, lamports: 123, sig: "abcdefghijk" });
  assert.deepEqual(transfers(tx), [{ to: TRADER, lamports: 123 }]);
  assert.equal(tx.message.compiledInstructions.length, 4);
});
