import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { allocate, weigh } from "../src/indexer.js";
import { enhancedChanges, readTrade } from "../src/trades.js";
import { feeOn } from "../src/token22.js";
import { config, streakMult } from "../src/config.js";
import { buildPayoutTx } from "../src/chain.js";
import { pda } from "./fakes.js";

const addr = () => Keypair.generate().publicKey.toBase58();
const MINT = addr(), PAYOUT = addr(), TEAM = addr();
const VAULT = { account: addr(), owner: pda() }; // the pool's vault: its owner has no key, so it can be neither paid nor a seller
const cfg = config({ MINT, PAYOUT_WALLET: PAYOUT, EXCLUDE: TEAM });
const TOK = 1_000_000n;

// A Helius enhanced transaction: `from` loses `gross`, `to` gains it less what the mint withholds when `taxed`.
const move = (from, to, gross, { taxed = true, mint = MINT, ...over } = {}) => {
  const g = BigInt(gross), net = taxed ? g - feeOn(g, 1000) : g;
  const bc = (userAccount, tokenAccount, amount) => ({ account: tokenAccount, nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount, tokenAccount, mint, rawTokenAmount: { tokenAmount: String(amount), decimals: 6 } }] });
  return { signature: "sig" + Math.random(), timestamp: 1_800_000_000, slot: 7, feePayer: from.owner || from, transactionError: null, tokenTransfers: [],
    accountData: [bc(from.owner || from, from.account || addr(), -g), bc(to.owner || to, to.account || addr(), net)], ...over };
};

test("readTrade reads a sell into a program-owned account: the whole loss is the size, the 10% withheld is the tax", () => {
  const w = addr();
  const c = enhancedChanges(move(w, VAULT, 2500n * TOK), MINT);
  const s = readTrade(c, { payout: PAYOUT, taxBps: 1000 });
  assert.deepEqual([s.side, s.wallet, s.tokens, s.withheld, s.net], ["sell", w, 2500n * TOK, 250n * TOK, 2250n * TOK]);
  assert.equal(c.at, 1_800_000_000_000);
  assert.equal(c.sig.startsWith("sig"), true);
});

test("readTrade: a buy is a buy, and failed txs, other mints, wallet-to-wallet sends and the treasury's own sale are not sells", () => {
  const w = addr();
  assert.equal(readTrade(enhancedChanges(move(VAULT, w, 10n * TOK), MINT), { payout: PAYOUT }).side, "buy");
  assert.equal(enhancedChanges(move(w, VAULT, 10n * TOK, { transactionError: { InstructionError: [0, "x"] } }), MINT), null);
  assert.equal(readTrade(enhancedChanges(move(w, VAULT, 10n * TOK, { mint: addr() }), MINT), { payout: PAYOUT }), null, "another mint: nothing of ours moved");
  assert.equal(readTrade(enhancedChanges(move(w, addr(), 10n * TOK), MINT), { payout: PAYOUT }), null, "a send between wallets is neither");
  assert.equal(readTrade(enhancedChanges(move(PAYOUT, VAULT, 10n * TOK), MINT), { payout: PAYOUT }), null, "the treasury selling its CULT isn't a seller on the Wall");
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
  const holders = new Map([[old, 100_000_000_000n], [fresh, 100_000_000_000n], [seller, 100_000_000_000n], [small, 1_000_000_000n], [VAULT.owner, 9n ** 20n], [PAYOUT, 9n ** 20n], [TEAM, 9n ** 20n]]);
  const since = new Map([[old, now - 31 * day], [seller, now - 31 * day], [fresh, now - 2 * day]]);
  const lastSell = new Map([[seller, now - 3 * day]]);
  const rows = weigh(cfg, { holders, since, lastSell, decimals: 6, price: 0.001, now }); // 100k tokens = $100; 1k = $1
  const w = Object.fromEntries(rows.map((r) => [r.wallet, r.weight]));
  assert.deepEqual(Object.keys(w).sort(), [old, fresh, seller].sort(), "the vault (no key), the payout wallet and the team wallet are out");
  assert.equal(w[old], 100_000 * 1.5);
  assert.equal(w[fresh], 100_000);
  assert.equal(w[seller], 100_000); // selling reset the streak
  assert.equal(streakMult(cfg, 7), 1.25);
});

test("weigh: the streak boost only covers the part held since the streak began (review F7); no base means all of it", () => {
  const now = Date.parse("2026-12-01T00:00:00Z"), day = 86_400_000;
  const a = addr(), b = addr(), c = addr();
  const holders = new Map([[a, 100_000_000_000n], [b, 100_000_000_000n], [c, 100_000_000_000n]]);
  const since = new Map([a, b, c].map((w) => [w, now - 31 * day]));
  const base = new Map([[a, 40_000_000_000n], [b, 100_000_000_000n], [c, 250_000_000_000n]]); // c's base above its balance: capped
  const w = Object.fromEntries(weigh(cfg, { holders, since, lastSell: new Map(), base, decimals: 6, price: 0.001, now }).map((r) => [r.wallet, r.weight]));
  assert.equal(w[a], 40_000 * 1.5 + 60_000, "the 60k added later counts at 1x");
  assert.equal(w[b], 100_000 * 1.5);
  assert.equal(w[c], 100_000 * 1.5);
});

test("a full batch of 8, all opening USDC accounts, fits in one transaction", () => {
  const kp = Keypair.generate();
  const items = Array.from({ length: cfg.batchSize }, () => ({ wallet: addr(), micro: 1_234_567, needs_ata: 1 }));
  const tx = buildPayoutTx(kp, "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", items);
  const size = tx.serialize().length;
  assert.ok(size <= 1232, `tx is ${size} bytes`);
});
