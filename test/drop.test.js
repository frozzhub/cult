// End to end against a local D1 (wrangler's getPlatformProxy) with Solana RPC and Jupiter faked (test/engine-fakes.js):
// webhook sells -> tick (snapshot, sweep, swap of the CULT and of spare SOL, allocate, send) -> tick (confirm) -> API shows it.
// Also: a batch whose blockhash expired is re-sent once, and confirmed batches are never re-sent.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import worker from "../src/index.js";
import { tick } from "../src/indexer.js";
import { addr, tokenAccount } from "./fakes.js";
import { treasuryAta } from "../src/token22.js";
import { TOK, makeVault, boot, freshS, isSwap, enhancedSell, postHook, installFakes, fastTimers } from "./engine-fakes.js";

const PERSIST = ".wrangler/test-state";
const kp = Keypair.generate();
const MINT = addr(), TEAM = addr(), PAYOUT = kp.publicKey.toBase58(), VAULT = makeVault();
const HOUR = 3_600_000;

let proxy, env, S, restoreFetch, restoreTimers;
const holders = Array.from({ length: 21 }, () => addr());

before(async () => {
  restoreTimers = fastTimers();
  ({ proxy, env } = await boot(PERSIST, { MINT, PAYOUT, kp, EXCLUDE: TEAM, DROP_MINUTES: "60" }));
  S = freshS({ PAYOUT, vault: VAULT });
  holders.forEach((w, i) => S.balances.set(w, BigInt((i + 1) * 100_000) * TOK)); // 100k..2.1M tokens
  S.balances.set(holders[0], 10_000n * TOK); // $10 at $0.001: below the minimum
  S.balances.set(TEAM, 50_000_000n * TOK);
  S.atasAll = true; // every USDC account exists, so no holder pays rent and the whole pot is split (rent is tested in review-money)
  S.sol = 50_000_000 + 45_000 + 100_000_000; // the reserve, the 3 payout fees, and 0.1 SOL of partner fees ($20) to swap
  S.swapOut = (amount, input) => (input === MINT ? 30_000_000n : amount / 5n); // the CULT leg buys $30 of USDC; SOL is $200
  restoreFetch = installFakes({ S: () => S, MINT, PAYOUT, env: () => env });
});
after(async () => { await proxy?.dispose(); restoreFetch?.(); restoreTimers?.(); });

const api = async (p) => (await worker.fetch(new Request("http://x" + p), env)).json();

test("an hour of sells turns into one airdrop, paid exactly once", async () => {
  const t0 = Math.floor(Date.now() / HOUR) * HOUR - HOUR; // last hour
  const sellers = [holders[5], holders[9], addr()];
  // Three sells of 100,000 CULT: each pays 10,000 CULT (10%) into the vault's withheld amount, $10 at $0.001. That is the pot.
  const txs = sellers.map((w, i) => enhancedSell({ sig: "sell" + i, wallet: w, at: t0 + 600_000 * (i + 1), gross: 100_000n * TOK, MINT, vault: VAULT }));
  S.vaultWithheld = 30_000n * TOK;
  assert.equal((await postHook(worker, env, txs, "wrong")).status, 401);
  assert.equal((await (await postHook(worker, env, txs)).json()).added, 3);
  assert.equal((await (await postHook(worker, env, txs)).json()).added, 0, "Helius retries are ignored");

  // Lose one payout tx so we can check it's re-sent after its blockhash expires.
  const r1 = await tick(env);
  assert.equal(r1.status, "paying", JSON.stringify(r1));
  const d = await env.DB.prepare("SELECT * FROM drops").first();
  assert.ok(Math.abs(d.fee_usd - 30) < 1e-9, `the round's tax is $30 of CULT, not ${d.fee_usd}`); // was fee_lamports 300_000_000 (3 x 0.1 SOL) in the pool design
  assert.ok(d.swap_sig && d.swap_sig !== "dry-run" && d.swap_sig !== "none", "the SOL leg ran");
  assert.ok(d.cult_sig && d.cult_sig !== "dry-run" && d.cult_sig !== "none", "the CULT leg ran");
  assert.equal(d.cult_amount, String(30_000n * TOK), "all the swept tax was sold");
  assert.equal(S.cult, 0n, "the treasury's CULT is gone and the vault's tax is in it first");
  assert.equal(S.vaultWithheld, 0n, "the sweep moved the tax out of the vault");

  const batches = (await env.DB.prepare("SELECT * FROM batches ORDER BY i").all()).results;
  assert.equal(batches.length, 3, "20 eligible holders / 8 per tx"); // 21 holders, 1 under $50; pool, team, payout excluded
  const payouts = (await env.DB.prepare("SELECT * FROM payouts WHERE micro > 0").all()).results;
  assert.equal(payouts.length, 20);
  assert.ok(!payouts.some((p) => [VAULT.owner, TEAM, PAYOUT, holders[0]].includes(p.wallet)));
  const total = payouts.reduce((a, p) => a + p.micro, 0);
  assert.ok(total <= 50_000_000 && total > 49_999_000, "pays the whole $50 (30 from the CULT, 20 from the SOL) minus rounding dust");

  // Second tick: one batch got lost. Not expired yet -> left alone.
  const lostSig = batches[1].sig;
  S.status = (sig) => (sig === lostSig ? null : { confirmationStatus: "confirmed", err: null });
  const sentBefore = S.sent.length;
  assert.equal((await tick(env)).status, "paying");
  assert.equal(S.sent.length, sentBefore, "nothing re-sent while the old tx could still land");

  // Blockhash expires -> re-sent once, then it confirms.
  S.height += 1000;
  await tick(env); // marks it pending and re-sends in the same tick
  const resent = S.sent.slice(sentBefore);
  assert.equal(resent.length, 1, "only the lost batch is re-sent");
  const r4 = await tick(env);
  assert.equal(r4.status, "done", JSON.stringify(r4));

  const final = await env.DB.prepare("SELECT * FROM drops").first();
  assert.equal(final.holders, 20);
  assert.equal(final.usdc_micro, total);
  assert.equal(new Set(S.sent.map((s) => s.sig)).size, S.sent.length, "no transaction sent twice");
  assert.equal(S.sent.filter(isSwap).length, 2, "one swap for each leg");

  // Nothing new until the next hour (the idle answer carries the fee engine's summary now, so only the flag is compared).
  const sentDone = S.sent.length;
  assert.equal((await tick(env)).idle, true);
  assert.equal(S.sent.length, sentDone);
});

test("the API shows the airdrop, the Wall and a holder's share", async () => {
  const s = await api("/api/state");
  assert.equal(s.live, true);
  assert.equal(s.drops.length, 1);
  assert.equal(s.drops[0].n, 1);
  assert.ok(s.drops[0].tx);
  assert.ok(Math.abs(s.totals.paidUsdc - 50) < 0.01);
  assert.equal(s.wall.top.length, 3);
  assert.equal(Math.round(s.wall.top[0].paidUsdc), 10); // 10,000 CULT of tax at $0.001
  assert.equal(s.pending, 0);
  // Members leaderboard: the biggest bag got the most, and amounts match what was paid.
  assert.equal(s.members.length, 20);
  assert.equal(s.members[0].wallet, holders[20]);
  assert.ok(Math.abs(s.members[0].receivedUsdc - 50 * 2.1 / 23) < 0.001);
  assert.ok(s.members.every((m, i, a) => i === 0 || a[i - 1].receivedUsdc >= m.receivedUsdc), "sorted by USDC received");
  assert.ok(Math.abs(s.members.reduce((a, m) => a + m.receivedUsdc, 0) - s.totals.paidUsdc) < 0.001, "leaderboard adds up to total paid");

  const rich = holders[20];
  const onChain = (wallet, amount) => S.accounts.set(treasuryAta(MINT, wallet).toBase58(), tokenAccount({ mint: MINT, owner: wallet, amount }));
  // The balance is read from the wallet’s own account, so someone who bought a minute ago can sell before the next snapshot.
  const fresh = addr(); onChain(fresh, 5_000n * TOK);
  assert.equal((await api("/api/wallet/" + fresh)).balance, 5_000);
  onChain(rich, 2_100_000n * TOK);
  const w = await api("/api/wallet/" + rich);
  assert.equal(w.balance, 2_100_000);
  assert.equal(w.eligible, true);
  assert.ok(w.share > 0.09 && w.share < 0.11, String(w.share));
  assert.ok(Math.abs(w.receivedUsdc - 50 * 2.1 / 23) < 0.001, String(w.receivedUsdc)); // 2.1M of 23M weighted tokens
});

test("DRY_RUN completes the next airdrop without sending anything", async () => {
  const next = Math.floor(Date.now() / HOUR) * HOUR;
  const w = holders[7];
  await postHook(worker, env, [enhancedSell({ sig: "dry1", wallet: w, at: next + 60_000, gross: 100_000n * TOK, MINT, vault: VAULT })]); // $10 of tax
  const sentBefore = S.sent.length;
  const r = await tick({ ...env, DRY_RUN: "1" }, next + HOUR + 60_000);
  assert.equal(r.status, "done", JSON.stringify(r));
  assert.equal(S.sent.length, sentBefore, "nothing signed or sent");
  const d = await env.DB.prepare("SELECT * FROM drops ORDER BY n DESC").first();
  assert.equal(d.usdc_micro > 9_000_000 && d.usdc_micro <= 10_000_000, true, String(d.usdc_micro)); // the dry round's pot is the tax's USD value: $10
  assert.equal(d.cult_sig, "dry-run");
  assert.equal(d.swap_sig, "dry-run");
});
