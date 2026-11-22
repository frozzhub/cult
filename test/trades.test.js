// Buys and sells read from REAL transactions (test/fixtures/raw-txs.json: the signatures in spikes/fee-test/state.json and
// dbc-state.json, fetched 16 Nov 2026 with getTransaction jsonParsed, maxSupportedTransactionVersion 1), and from Helius's
// "enhanced" webhook shape. The enhanced fixtures are WRITTEN BY HAND in Helius's documented shape (accountData[].
// tokenBalanceChanges with raw amounts) with the numbers of the real transactions; no real Helius payload was available.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rpcChanges, enhancedChanges, touchedAccounts, readTrade } from "../src/trades.js";
import { addr, pda } from "./fakes.js";

const RAW = JSON.parse(readFileSync(new URL("./fixtures/raw-txs.json", import.meta.url), "utf8"));
const DBC = "2GHaaCNpbFzNSaSFRACaX7mPLLboUPykykSx9QGKpZPZ", DAMM = "FyZ6Pr7C8wkc7XvUxF31uvrxYaX27VfkFTWJu581NuXw";
const BUYER = "ECFmvyQo7w1YtuAZbtkPxrbg1NX9ghF1rEECCRqNQg22", FEE_KEY = "KDpz3icbjmmib1DDeitywpk6ZdsQckHiqt6hKmKnnaq";
const real = (k) => RAW[k].tx;
const trade = (k, mint, o) => readTrade(rpcChanges(real(k), mint), o);

test("real DBC buy: gross = what the vault lost, withheld = gross - what the wallet got", () => {
  const t = trade("dbc:buy", DBC);
  assert.deepEqual({ ...t, tokens: String(t.tokens), withheld: String(t.withheld), net: String(t.net) },
    { side: "buy", wallet: BUYER, tokens: "332397766917", withheld: "33239776692", net: "299157990225" });
  assert.equal(t.withheld, (t.tokens * 1000n + 9999n) / 10000n, "exactly the 10% token-2022 withheld, rounded up");
});

test("real DBC sell: the withheld tax is what the vault's withheld amount became (16,619,888,346)", () => {
  const t = trade("dbc:sell", DBC);
  assert.equal(t.side, "sell");
  assert.equal(t.wallet, BUYER);
  assert.equal(t.tokens, 166198883458n);
  assert.equal(t.withheld, 16619888346n, "the same number the pool vault holds on chain today (token22.test.js)");
  assert.equal(t.net, 149578995112n);
});

test("real DAMM v2 buy and sell: same rule on the other pool program (15% test token)", () => {
  const b = trade("damm:buy", DAMM), s = trade("damm:sell", DAMM);
  assert.deepEqual([b.side, b.tokens, b.withheld], ["buy", 664480142006n, 99672021301n]);
  assert.deepEqual([s.side, s.tokens, s.withheld], ["sell", 332240071003n, 49836010651n]);
});

test("a refund is not a trade, and neither is creating the pool or the mint", () => {
  assert.equal(trade("dbc:refund buyer's withheld 10%", DBC), null, "the account's balance rose with no program account losing");
  assert.equal(trade("damm:refund buyer's withheld 15%", DAMM), null);
  assert.equal(trade("dbc:config + curve pool: 10% transfer fee, no SOL in", DBC), null);
  assert.equal(trade("damm:mint: 15% transfer fee, fee rate locked, supply minted, minting revoked", DAMM), null);
});

test("the treasury's own sale never counts as a seller; other wallets selling does", () => {
  const sell = rpcChanges(real("dbc:sell"), DBC);
  assert.equal(readTrade(sell, { payout: BUYER }), null);
  assert.equal(readTrade(sell, { payout: addr() }).wallet, BUYER);
});

test("touched accounts: every token account of the mint the transaction named, even the vault", () => {
  const buy = touchedAccounts(rpcChanges(real("dbc:buy"), DBC));
  assert.equal(buy.length, 2);
  assert.ok(buy.includes("7WZWwgCGxmvJ1G15qmdXkz4EShWt6DdEW7T9bU7hjZXE") && buy.includes("C1chZPB4uUTgdqrBnxSHnTfW6b6dkKX8PH5855LPyAYS"));
  assert.deepEqual(touchedAccounts(rpcChanges(real("dbc:refund buyer's withheld 10%"), DBC)), ["C1chZPB4uUTgdqrBnxSHnTfW6b6dkKX8PH5855LPyAYS"]);
  assert.equal(rpcChanges(real("dbc:buy"), "11111111111111111111111111111111").changes.length, 0, "another mint: nothing");
});

test("failed transactions and missing ones read as nothing", () => {
  const failed = { ...real("dbc:buy"), meta: { ...real("dbc:buy").meta, err: { InstructionError: [0, "x"] } } };
  assert.equal(rpcChanges(failed, DBC), null);
  assert.equal(rpcChanges(null, DBC), null);
  assert.equal(readTrade(null), null);
  assert.equal(enhancedChanges({ transactionError: { x: 1 } }, DBC), null);
});

/* ---------- Helius enhanced, hand-written from the real numbers ---------- */

const enhanced = (changes, extra = {}) => ({
  signature: "sigx", timestamp: 1_763_270_000, slot: 470003122, feePayer: BUYER, transactionError: null,
  accountData: changes.map((c) => ({ account: c.tokenAccount, nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: c.owner, tokenAccount: c.tokenAccount, mint: DBC, rawTokenAmount: { tokenAmount: String(c.delta), decimals: 6 } }] })),
  tokenTransfers: [], ...extra,
});

test("enhanced buy and sell give the same trade as the RPC reading of the real transaction", () => {
  const vault = "7WZWwgCGxmvJ1G15qmdXkz4EShWt6DdEW7T9bU7hjZXE", vowner = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM", ata = "C1chZPB4uUTgdqrBnxSHnTfW6b6dkKX8PH5855LPyAYS";
  const buy = readTrade(enhancedChanges(enhanced([{ tokenAccount: vault, owner: vowner, delta: -332397766917n }, { tokenAccount: ata, owner: BUYER, delta: 299157990225n }]), DBC), {});
  assert.deepEqual([buy.side, buy.tokens, buy.withheld], ["buy", 332397766917n, 33239776692n]);
  const sell = readTrade(enhancedChanges(enhanced([{ tokenAccount: ata, owner: BUYER, delta: -166198883458n }, { tokenAccount: vault, owner: vowner, delta: 149578995112n }]), DBC), {});
  assert.deepEqual([sell.side, sell.tokens, sell.withheld], ["sell", 166198883458n, 16619888346n]);
});

test("enhanced: a transfer touching accounts with no balance change still queues them", () => {
  const c = enhancedChanges(enhanced([], { tokenTransfers: [{ mint: DBC, fromTokenAccount: "A", toTokenAccount: "B" }, { mint: addr(), fromTokenAccount: "X", toTokenAccount: "Y" }] }), DBC);
  assert.deepEqual(touchedAccounts(c).sort(), ["A", "B"]);
});

test("wallet to wallet, program to program (the migration) and refunded-in-one buys", () => {
  const w1 = addr(), w2 = addr(), p1 = pda(), p2 = pda();
  const mk = (a, b) => enhancedChanges(enhanced([{ tokenAccount: addr(), owner: a[0], delta: a[1] }, { tokenAccount: addr(), owner: b[0], delta: b[1] }]), DBC);
  assert.equal(readTrade(mk([w1, -1000n], [w2, 900n]), {}), null, "a send between wallets is neither a buy nor a sell");
  assert.equal(readTrade(mk([p1, -1000n], [p2, 900n]), {}), null, "the DBC to DAMM v2 migration moves tokens between vaults");
  const atomic = readTrade(mk([p1, -1000n], [w1, 1000n]), {});
  assert.deepEqual([atomic.side, atomic.tokens, atomic.withheld], ["buy", 1000n, 0n], "refunded in the same transaction: nothing withheld");
});

test("a wallet that sells and a pool that also pays another program: the sale is still the wallet's whole loss", () => {
  const w = addr(), v = pda();
  const c = enhancedChanges(enhanced([{ tokenAccount: addr(), owner: w, delta: -1000n }, { tokenAccount: addr(), owner: v, delta: 900n }]), DBC);
  const t = readTrade(c, { taxBps: 1000 });
  assert.deepEqual([t.side, t.tokens, t.withheld, t.net], ["sell", 1000n, 100n, 900n]);
});

test("edges of the rule: a wallet that gains more than the pool lost withholds 0 (never negative); a sale the pool received whole falls back to the nominal tax; the treasury buying is not a trade either", () => {
  const w = addr(), p = pda();
  const mk = (a, b) => enhancedChanges(enhanced([{ tokenAccount: addr(), owner: a[0], delta: a[1] }, { tokenAccount: addr(), owner: b[0], delta: b[1] }]), DBC);
  const over = readTrade(mk([p, -1000n], [w, 1200n]), {});
  assert.deepEqual([over.side, over.tokens, over.withheld, over.net], ["buy", 1000n, 0n, 1200n]);
  const whole = readTrade(mk([w, -1000n], [p, 1000n]), { taxBps: 1000 });
  assert.deepEqual([whole.side, whole.withheld, whole.net], ["sell", 100n, 900n], "no measurable fee: the nominal 10%, rounded up");
  assert.equal(readTrade(mk([p, -1000n], [w, 900n]), { payout: w }), null, "the treasury's own buy of the coin");
});

test("enhanced: balance changes of other mints in the same transaction are ignored", () => {
  const tx = enhanced([]);
  tx.accountData = [{ account: "a", tokenBalanceChanges: [{ userAccount: addr(), tokenAccount: "a", mint: addr(), rawTokenAmount: { tokenAmount: "-500" } }, { userAccount: addr(), tokenAccount: "b", mint: DBC, rawTokenAmount: { tokenAmount: "7" } }] }];
  const c = enhancedChanges(tx, DBC);
  assert.deepEqual(c.changes.map((x) => [x.address, x.delta]), [["b", 7n]]);
});
