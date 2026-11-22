// A brand-new deployment goes straight to a real paid round (no practice rounds: DRY_RUN "0" and refunds live from the first
// minute). Everything is empty: a fresh D1 with only the migrations applied, no price cached, no snapshot to compare with,
// no treasury token account, no USDC account for the payout wallet, a webhook that can arrive before the first cron tick.
// Same local-D1 + fake-chain harness as the round tests (test/engine-fakes.js). The launch state these tests pin is in
// ("A brand-new deployment").
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import worker from "../src/index.js";
import { tick, weigh } from "../src/indexer.js";
import { config } from "../src/config.js";
import { feeOn, treasuryAta } from "../src/token22.js";
import { addr } from "./fakes.js";
import { tokenAccount } from "./fakes.js";
import { TOK, makeVault, CLEAR, boot, freshS, isSwap, touches, installFakes, fastTimers, enhancedBuy, enhancedSell, postHook } from "./engine-fakes.js";

const PERSIST = ".wrangler/cold-test";
const kp = Keypair.generate();
const MINT = addr(), PAYOUT = kp.publicKey.toBase58(), VAULT = makeVault();
const TREASURY = treasuryAta(MINT, PAYOUT).toBase58();
const PERIOD = 10 * 60_000;
const T0 = Math.floor(Date.now() / PERIOD) * PERIOD + 30_000;

let proxy, env, S, restoreFetch, restoreTimers;
before(async () => {
  restoreTimers = fastTimers();
  // The launch state: DRY_RUN "0", refunds live, nobody excluded. Every other var is the file's own default.
  ({ proxy, env } = await boot(PERSIST, { MINT, PAYOUT, kp, REFUNDS_DRY_RUN: "0", EXCLUDE: "", MIN_SWAP_USD: "1" }));
  restoreFetch = installFakes({ S: () => S, MINT, PAYOUT, env: () => env });
});
after(async () => { await proxy?.dispose(); restoreFetch?.(); restoreTimers?.(); });
beforeEach(async () => {
  S = freshS({ PAYOUT, vault: VAULT });
  S.treasuryExists = false; S.usdcExists = false; // nothing of ours is on chain yet
  S.sol = 40_000_000;                             // under the reserve: no SOL leg in these rounds
  await env.DB.batch(CLEAR.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

const first = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const rows = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then((r) => r.results);
const person = (tokens) => { const w = addr(); S.balances.set(w, BigInt(tokens) * TOK); return w; };
const cultSwap = (x) => isSwap(x) && touches(x, TREASURY);
const hook = (txs) => postHook(worker, env, txs);

test("the first tick of a new deployment: sweep creates the treasury account, the sale opens the USDC account, everyone with $50 of coin is paid, the creator and a bundle wallet included", async () => {
  const creator = person(300_000), bundle = person(200_000), buyer = person(100_000), tiny = person(10); // $0.01 of coin: under MIN_HOLD_USD
  S.vaultWithheld = 10_000n * TOK;                // the tax of the first sells, sitting in the pool vault
  S.swapOut = () => 5_000_000n;                   // Jupiter pays $5 for it
  // The webhook arrives before any tick: a sell into the pool (queues the vault) and a buy (its refund goes out at once).
  const gross = 111_111n * TOK, withheld = feeOn(gross, 1000), A = addr();
  S.accounts.set(A, tokenAccount({ mint: MINT, owner: buyer, amount: gross - withheld, withheld }));
  const res = await hook([enhancedSell({ sig: "s1", wallet: bundle, at: T0 - 20_000, gross: 20_000n * TOK, MINT, vault: VAULT }), enhancedBuy({ sig: "b1", wallet: buyer, at: T0 - 10_000, gross, MINT, vault: VAULT, account: A })]);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(S.sent.length, 1, "the buyer's refund went out from the webhook, with no tick and no price needed");
  assert.equal(new DataView(S.accounts.get(A).buffer).getBigUint64(174, true), 0n, "and it landed");
  assert.equal((await first("SELECT COUNT(*) AS c FROM trades")).c, 2, "both recorded");
  assert.equal(await first("SELECT COUNT(*) AS c FROM drops").then((r) => r.c), 0, "no round exists yet");

  const r = await tick(env, T0);
  assert.equal(r.status, "paying", JSON.stringify(r)); // the payout batch is sent in this tick and confirmed in the next
  assert.equal((await tick(env, T0 + 2000)).status, "done");
  assert.equal(S.treasuryExists, true, "the first sweep opened the treasury's token account (idempotent create in the same transaction)");
  assert.equal(S.usdcExists, true, "the sale opened the payout wallet's USDC account");
  assert.equal(S.vaultWithheld, 0n);
  assert.equal(S.sent.filter(cultSwap).length, 1);
  assert.equal(S.cult, 0n, "all of the swept tax was sold");
  assert.equal(S.usdc, 5_000_000n);
  const paid = Object.fromEntries((await rows("SELECT wallet, micro FROM payouts WHERE drop_n = ? AND micro > 0", (await first("SELECT n FROM drops")).n)).map((x) => [x.wallet, x.micro]));
  assert.deepEqual(Object.keys(paid).sort(), [buyer, bundle, creator].sort(), "the creator and the bundle wallet are paid like anyone; the $0.01 wallet, the pool and the treasury are not");
  assert.ok(Object.values(paid).every((m) => m > 0));
  assert.ok(paid[creator] > paid[bundle] && paid[bundle] > paid[buyer], "by weight");
  const total = Object.values(paid).reduce((a, b) => a + b, 0);
  assert.ok(total >= 5_000_000 - 3 * 407_856 - 3 && total <= 5_000_000 - 3 * 407_856, `the $5 pot less the rent of opening three USDC accounts (taken from each holder's own share, it stays in the wallet): ${total}`);
  const d = await first("SELECT * FROM drops");
  assert.deepEqual([d.status, d.error, d.holders], ["done", null, 3]);
  assert.equal(S.sent.length, 4, "refund, sweep, sale, payout: nothing sent twice");
  assert.equal((await first("SELECT COUNT(*) AS c FROM batches WHERE status = 'confirmed'")).c, 1);
});

test("a first round with nothing to sweep and nothing to sell finishes cleanly: no transaction, no account created, no error", async () => {
  person(300_000); person(200_000);
  const r = await tick(env, T0);
  assert.equal(r.status, "done", JSON.stringify(r));
  assert.equal(S.sent.length, 0);
  assert.equal(S.treasuryExists || S.usdcExists, false);
  const d = await first("SELECT * FROM drops");
  assert.deepEqual([d.status, d.error, d.usdc_micro, d.holders, d.cult_sig], ["done", null, 0, 0, "none"]);
  // and the next round, with the first one as its baseline, does the same
  const r2 = await tick(env, T0 + PERIOD);
  assert.equal(r2.status, "done", JSON.stringify(r2));
  assert.equal(S.sent.length, 0);
});

test("the holder-drop guard has no baseline on the first snapshot (nothing to compare) and a lone holder is a valid first round", async () => {
  const only = person(500_000);
  S.vaultWithheld = 10_000n * TOK; S.swapOut = () => 3_000_000n;
  await hook([enhancedSell({ sig: "s1", wallet: only, at: T0 - 5000, gross: 1_000n * TOK, MINT, vault: VAULT })]);
  const r = await tick(env, T0);
  assert.equal(r.status, "paying", JSON.stringify(r));
  assert.equal((await tick(env, T0 + 2000)).status, "done");
  assert.deepEqual((await rows("SELECT wallet FROM payouts")).map((x) => x.wallet), [only], "the pool's owner and the treasury are in the holder list but never in the round");
  assert.ok((await first("SELECT micro FROM payouts WHERE wallet = ?", only)).micro > 2_000_000);
});

test("no price yet (Jupiter hasn't priced the coin, no curve read): the round waits and says so, nothing is sent; the next tick with a curve price pays", async () => {
  const a = person(300_000), b = person(200_000);
  S.tokenUsd = 0; // Jupiter answers the SOL price and nothing for the coin
  S.vaultWithheld = 10_000n * TOK; S.swapOut = () => 5_000_000n;
  await hook([enhancedSell({ sig: "s0", wallet: a, at: T0 - 20_000, gross: 20_000n * TOK, MINT, vault: VAULT })]).then((r) => assert.equal(r.status, 503, "a trade with no price is asked for again, not recorded at 0"));
  assert.equal((await first("SELECT COUNT(*) AS c FROM trades")).c, 0);
  const r1 = await tick(env, T0);
  assert.notEqual(r1.status, "done", JSON.stringify(r1));
  const d = await first("SELECT * FROM drops");
  assert.equal(d.status, "snapshot");
  assert.match(d.error, /No \$CULT price yet/);
  assert.equal(S.sent.filter(isSwap).length, 0, "no sale without a price");
  assert.equal((await first("SELECT COUNT(*) AS c FROM payouts")).c, 0, "and nobody is counted or paid");
  assert.deepEqual(S.sent.map((x) => touches(x, VAULT.account)), [true], "the only thing sent is the sweep of the tax into the treasury, which needs no price and keeps the money ours");
  // the cron's read of the curve gives a price (SOL per coin x SOL's USD price): $0.001
  await env.DB.prepare("INSERT INTO kv (k, v, at) VALUES ('curve', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify({ stage: "curve", priceSol: 0.000005, at: T0 + 61_000 }), T0 + 61_000).run();
  await env.DB.prepare("DELETE FROM kv WHERE k = 'price'").run(); // the 60-second price cache has run out (the webhook above used the real clock, this test's ticks a simulated one)
  const r2 = await tick(env, T0 + 61_000);
  assert.equal(r2.status, "paying", JSON.stringify(r2));
  assert.equal((await tick(env, T0 + 63_000)).status, "done");
  assert.equal(S.sent.filter(cultSwap).length, 1, "the swept tax is sold once the price is known");
  assert.deepEqual((await rows("SELECT wallet FROM payouts WHERE micro > 0")).map((x) => x.wallet).sort(), [a, b].sort());
  assert.equal((await first("SELECT price_usd FROM drops")).price_usd, 0.001);
});

test("the curve is read in the first tick AFTER the price was first asked for: the round still prices and pays in that same tick", async () => {
  const a = person(300_000), b = person(200_000);
  S.tokenUsd = 0; S.vaultWithheld = 10_000n * TOK; S.swapOut = () => 5_000_000n;
  assert.equal((await hook([enhancedSell({ sig: "s0", wallet: a, at: T0 - 20_000, gross: 20_000n * TOK, MINT, vault: VAULT })])).status, 503);
  let read = false;
  // The cron reads the curve after it fetched the prices (it does, in this order): seed that read while the first tick's sweep goes out.
  S.onSend = async () => {
    if (read) return;
    read = true;
    await env.DB.prepare("INSERT INTO kv (k, v, at) VALUES ('curve', ?, ?)").bind(JSON.stringify({ stage: "curve", priceSol: 0.000005, at: T0 }), T0).run();
  };
  await env.DB.prepare("DELETE FROM kv WHERE k = 'price'").run(); // (the hook used the real clock, the tick a simulated one: start from an empty cache)
  const r = await tick(env, T0);
  assert.equal(r.status, "paying", JSON.stringify(r));
  assert.deepEqual((await rows("SELECT wallet FROM payouts WHERE micro > 0")).map((x) => x.wallet).sort(), [a, b].sort());
});

test("a webhook with no price: the refund still goes out, the trade is answered 503, and Helius's second delivery records it once without a second refund", async () => {
  const buyer = person(100_000);
  S.tokenUsd = 0;
  const gross = 100_000n * TOK, withheld = feeOn(gross, 1000), A = addr();
  S.accounts.set(A, tokenAccount({ mint: MINT, owner: buyer, amount: gross - withheld, withheld }));
  const tx = enhancedBuy({ sig: "b9", wallet: buyer, at: T0 - 5000, gross, MINT, vault: VAULT, account: A });
  const r1 = await hook([tx]);
  assert.equal(r1.status, 503);
  assert.equal(S.sent.length, 1, "refunded all the same");
  S.tokenUsd = 0.001;
  await env.DB.prepare("DELETE FROM kv WHERE k = 'price'").run();
  const r2 = await hook([tx]);
  assert.equal(r2.status, 200);
  assert.equal((await first("SELECT COUNT(*) AS c FROM trades")).c, 1);
  assert.equal(S.sent.length, 1, "no second refund: the account was read fresh and holds nothing");
  assert.equal((await hook([tx])).status, 200);
  assert.equal((await first("SELECT COUNT(*) AS c FROM trades")).c, 1, "a third delivery changes nothing");
});

test("buys and sells from before the deployment: the first tick's scan finds every account with withheld tokens, refunds the buyers and sweeps the vault, with no webhook ever seen", async () => {
  const b1 = person(100_000), b2 = person(150_000);
  const mk = (owner, gross) => { const w = feeOn(gross, 1000), a = addr(); S.accounts.set(a, tokenAccount({ mint: MINT, owner, amount: gross - w, withheld: w })); return a; };
  const a1 = mk(b1, 111_111n * TOK), a2 = mk(b2, 166_666n * TOK);
  S.vaultWithheld = 7_000n * TOK; S.swapOut = () => 4_000_000n;
  await tick(env, T0);
  const w = (a) => new DataView(S.accounts.get(a).buffer).getBigUint64(174, true);
  assert.deepEqual([w(a1), w(a2)], [0n, 0n], "both buyers were refunded");
  assert.equal(S.vaultWithheld, 0n, "the vault's tax was swept");
  assert.equal(S.sent.filter(cultSwap).length, 1, "and sold in the same first round");
  assert.equal((await first("SELECT COUNT(*) AS c FROM fee_accounts WHERE state IN ('queued', 'claimed', 'sent')")).c, 0, "nothing left in flight");
  assert.equal((await first("SELECT COUNT(*) AS c FROM fee_batches WHERE status = 'confirmed'")).c, 2, "one refund batch, one sweep batch");
});

test("a deployment with no webhook secret (or an empty one) refuses every hook, and a wrong header is refused too", async () => {
  const tx = [enhancedBuy({ sig: "b1", wallet: person(1), at: T0, gross: 1000n * TOK, MINT, vault: VAULT })];
  assert.equal((await postHook(worker, env, tx, "wrong")).status, 401);
  assert.equal((await postHook(worker, { ...env, HELIUS_WEBHOOK_SECRET: undefined }, tx, "undefined")).status, 401);
  assert.equal((await postHook(worker, { ...env, HELIUS_WEBHOOK_SECRET: "" }, tx, "")).status, 401, "an empty secret matched by an empty header is not a secret");
  assert.equal((await first("SELECT COUNT(*) AS c FROM trades")).c, 0);
  assert.equal((await first("SELECT COUNT(*) AS c FROM fee_accounts")).c, 0);
});

test("the webhook only refunds: a buyer's account with a delegate is left for the cron to sweep, and the webhook never touches the vault", async () => {
  const buyer = person(100_000), gross = 100_000n * TOK, withheld = feeOn(gross, 1000), A = addr();
  S.accounts.set(A, tokenAccount({ mint: MINT, owner: buyer, amount: gross - withheld, withheld, delegate: addr() }));
  const res = await hook([enhancedBuy({ sig: "b1", wallet: buyer, at: T0 - 5000, gross, MINT, vault: VAULT, account: A })]);
  assert.equal(res.status, 200);
  assert.equal(S.sent.length, 0, "nothing sent by the webhook: a delegated account is swept, not refunded, and sweeping is the cron's job");
  assert.equal((await first("SELECT state FROM fee_accounts WHERE address = ?", A)).state, "queued");
  await tick(env, T0);
  assert.equal(new DataView(S.accounts.get(A).buffer).getBigUint64(174, true), 0n, "the cron swept it into the treasury");
});

test("with REFUNDS_DRY_RUN \"1\" the webhook only queues: nothing is sent; with it off the next tick refunds what was queued", async () => {
  const buyer = person(100_000), gross = 100_000n * TOK, withheld = feeOn(gross, 1000), A = addr();
  S.accounts.set(A, tokenAccount({ mint: MINT, owner: buyer, amount: gross - withheld, withheld }));
  const dry = { ...env, REFUNDS_DRY_RUN: "1" };
  const res = await postHook(worker, dry, [enhancedBuy({ sig: "b1", wallet: buyer, at: T0 - 5000, gross, MINT, vault: VAULT, account: A })]);
  assert.equal(res.status, 200);
  assert.equal(S.sent.length, 0);
  assert.equal((await first("SELECT state FROM fee_accounts WHERE address = ?", A)).state, "queued");
  await tick(env, T0);
  assert.equal(new DataView(S.accounts.get(A).buffer).getBigUint64(174, true), 0n, "refunds live: the first tick refunds it");
});

test("nobody is excluded unless EXCLUDE says so: the pool creator and a bundle wallet weigh like any holder; the payout wallet, a listed address and a program's address do not", () => {
  const cfg = config({ MINT, PAYOUT_WALLET: PAYOUT, MIN_HOLD_USD: "50" });
  assert.deepEqual(cfg.exclude, []);
  const creator = addr(), bundle = addr(), listed = addr();
  const holders = new Map([[creator, 900_000n * TOK], [bundle, 100_000n * TOK], [PAYOUT, 10n ** 9n * TOK], [VAULT.owner, 10n ** 9n * TOK], [listed, 50_000n * TOK]]);
  const weighed = (c) => weigh(c, { holders, since: new Map(), lastSell: new Map(), decimals: 6, price: 0.001, now: T0 }).map((r) => r.wallet).sort();
  assert.deepEqual(weighed(cfg), [bundle, creator, listed].sort());
  assert.deepEqual(weighed(config({ MINT, PAYOUT_WALLET: PAYOUT, EXCLUDE: listed })), [bundle, creator].sort());
});
