import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { parseSell, allocate, weigh } from "../src/indexer.js";
import { config, streakMult } from "../src/config.js";
import { buildPayoutTx } from "../src/chain.js";

const addr = () => Keypair.generate().publicKey.toBase58();
const MINT = addr(), POOL = addr(), PAYOUT = addr(), TEAM = addr();
const cfg = config({ MINT, POOL_ACCOUNT: POOL, PAYOUT_WALLET: PAYOUT, EXCLUDE: TEAM });

const sellTx = (seller, over = {}) => ({
  signature: "sig" + Math.random(), timestamp: 1_800_000_000, feePayer: seller, fee: 5000,
  tokenTransfers: [{ fromUserAccount: seller, toUserAccount: POOL, mint: MINT, tokenAmount: 2500 }],
  accountData: [{ account: PAYOUT, nativeBalanceChange: 150_000_000 }, { account: seller, nativeBalanceChange: 849_995_000 }],
  ...over,
});

test("parseSell reads a sell into the pool", () => {
  const w = addr();
  const s = parseSell(sellTx(w), cfg);
  assert.equal(s.wallet, w);
  assert.equal(s.tokens, 2500);
  assert.equal(s.fee, 150_000_000);
  assert.equal(s.solOut, 850_000_000); // tx fee added back since the seller paid it
  assert.equal(s.at, 1_800_000_000_000);
});

test("parseSell ignores buys, failed txs and other mints", () => {
  const w = addr();
  assert.equal(parseSell(sellTx(w, { tokenTransfers: [{ fromUserAccount: POOL, toUserAccount: w, mint: MINT, tokenAmount: 10 }] }), cfg), null);
  assert.equal(parseSell(sellTx(w, { transactionError: { InstructionError: [0, "x"] } }), cfg), null);
  assert.equal(parseSell(sellTx(w, { tokenTransfers: [{ fromUserAccount: w, toUserAccount: POOL, mint: addr(), tokenAmount: 10 }] }), cfg), null);
  assert.equal(parseSell(sellTx(PAYOUT), cfg), null);
});

test("allocate never pays more than the pot and drops dust", () => {
  const rows = [{ wallet: "a", weight: 1_000_000 }, { wallet: "b", weight: 333_333 }, { wallet: "c", weight: 1 }];
  const { paid, total } = allocate(rows, 10_000_000, 10_000, 8);
  assert.ok(total <= 10_000_000);
  assert.deepEqual(paid.map((p) => p.wallet), ["a", "b"]); // c's share is under 0.01 USDC
  assert.equal(paid[0].micro, Math.floor((10_000_000 * 1_000_000) / 1_333_334));
});

test("allocate numbers batches in fixed groups", () => {
  const rows = Array.from({ length: 19 }, (_, i) => ({ wallet: "w" + i, weight: 100 + i }));
  const { paid } = allocate(rows, 19_000_000, 1, 8);
  assert.deepEqual([...new Set(paid.map((p) => p.batch))], [0, 1, 2]);
  assert.equal(paid.filter((p) => p.batch === 2).length, 3);
});

test("weigh applies exclusions, the $50 minimum and streak boosts", () => {
  const now = Date.parse("2026-12-01T00:00:00Z"), day = 86_400_000;
  const old = addr(), fresh = addr(), seller = addr(), small = addr();
  const holders = new Map([[old, 100_000_000_000n], [fresh, 100_000_000_000n], [seller, 100_000_000_000n], [small, 1_000_000_000n], [POOL, 9n ** 20n], [PAYOUT, 9n ** 20n], [TEAM, 9n ** 20n]]);
  const since = new Map([[old, now - 31 * day], [seller, now - 31 * day], [fresh, now - 2 * day]]);
  const lastSell = new Map([[seller, now - 3 * day]]);
  const rows = weigh(cfg, { holders, since, lastSell, decimals: 6, price: 0.001, now }); // 100k tokens = $100; 1k = $1
  const w = Object.fromEntries(rows.map((r) => [r.wallet, r.weight]));
  assert.deepEqual(Object.keys(w).sort(), [old, fresh, seller].sort());
  assert.equal(w[old], 100_000 * 1.5);
  assert.equal(w[fresh], 100_000);
  assert.equal(w[seller], 100_000); // selling reset the streak
  assert.equal(streakMult(cfg, 7), 1.25);
});

test("a full batch of 8, all opening USDC accounts, fits in one transaction", () => {
  const kp = Keypair.generate();
  const items = Array.from({ length: cfg.batchSize }, () => ({ wallet: addr(), micro: 1_234_567, needs_ata: 1 }));
  const tx = buildPayoutTx(kp, "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", items);
  const size = tx.serialize().length;
  assert.ok(size <= 1232, `tx is ${size} bytes`);
});
