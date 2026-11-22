// Money review 2026-11-16. Each test reproduces one finding; all but F7 pass on the fixed
// code. Same local-D1 + fake-chain harness as drop.test.js (test/engine-fakes.js), with a chain fake that can stall a send,
// report "processed", fail a tx, and lag "finalized". Ported to the curve design: the pot is the payout wallet's USDC after its
// swaps (the CULT leg is empty in these tests, so the SOL leg makes it), sells arrive as enhanced webhooks, and F10 (/api/send
// relaying a transaction with extra instructions) is gone with /api/send: there is no relay left to abuse.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import worker from "../src/index.js";
import { tick, pollMint } from "../src/indexer.js";
import { usdcAta } from "../src/chain.js";
import { config } from "../src/config.js";
import { addr, SOL } from "./fakes.js";
import { TOK, RpcError, makeVault, CLEAR, boot, freshS, isSwap, touches, enhancedSell, postHook, installFakes, fastTimers } from "./engine-fakes.js";

const PERSIST = ".wrangler/review-money";
const kp = Keypair.generate();
const MINT = addr(), PAYOUT = kp.publicKey.toBase58(), VAULT = makeVault();
const DAY = 86_400_000, PERIOD = 10 * 60_000; // DROP_MINUTES=10; 6 decimals; $0.001/token; SOL $200
const T0 = Math.floor(Date.now() / PERIOD) * PERIOD + 30_000;

let proxy, env, S, restoreFetch, restoreTimers;
before(async () => {
  restoreTimers = fastTimers();
  ({ proxy, env } = await boot(PERSIST, { MINT, PAYOUT, kp }));
  restoreFetch = installFakes({ S: () => S, MINT, PAYOUT, env: () => env });
});
after(async () => { await proxy?.dispose(); restoreFetch?.(); restoreTimers?.(); });
beforeEach(async () => {
  S = freshS({ PAYOUT, vault: VAULT });
  await env.DB.batch(CLEAR.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

const ata = (w) => usdcAta(w, env).toBase58();
const holder = (tokens, { hasAta = true } = {}) => {
  const w = addr();
  S.balances.set(w, BigInt(tokens) * TOK);
  if (hasAta) S.atas.add(ata(w));
  return w;
};
const paidTo = (w) => S.sent.filter((x) => touches(x, ata(w)));
const untilDone = async (now) => { for (let i = 0; i < 12; i++) { const r = await tick(env, now + i * 1000); if (r.status === "done" || r.idle) return r; } };

// Lead 1. Tick A (slow RPC) is still sending batches when its lock expires. Tick B takes the lock,
// reads the batches A hasn't reached yet as 'pending' and sends them. A then sends the same batches from its
// stale list with its own blockhash and overwrites B's signature. Both copies can land.
// (The lock is 15 minutes now and A refreshes it before every send, so B at +5 minutes finds it held. The lock really expiring
// is tested in launch-fixes.test.js.)
test("F1: a tick that outlives its 4-minute lock and a second tick both send the same payout batch", async () => {
  const ws = Array.from({ length: 20 }, (_, i) => holder(100_000 * (i + 1)));
  let release, stalled = false;
  const gate = new Promise((r) => (release = r));
  S.onSend = async (tx) => { if (!isSwap({ tx }) && !stalled) { stalled = true; await gate; } };
  const a = tick(env, T0);
  while (!stalled) await new Promise((r) => setTimeout(r, 20));
  await tick(env, T0 + 5 * 60_000); // the next cron that finds A's lock expired
  release();
  await a;
  const twice = ws.filter((w) => paidTo(w).length > 1);
  assert.equal(twice.length, 0, `${twice.length} of ${ws.length} holders were sent their payout in two different transactions`);
});

// Lead 8. sigStatuses maps "processed" (in a block, not yet confirmed) to null, and paying reads statuses
// BEFORE the block height. A batch that landed near its last valid block is then treated as lost and re-sent.
test("F2: a payout already in a block ('processed') is re-sent once the height passes its blockhash", async () => {
  Array.from({ length: 9 }, (_, i) => holder(100_000 * (i + 1)));
  await tick(env, T0);
  const b0 = await env.DB.prepare("SELECT sig, lvbh FROM batches WHERE i = 0").first();
  assert.ok(b0?.sig, "batch 0 was sent");
  const sentBefore = S.sent.length;
  S.status = (sig) => ({ confirmationStatus: sig === b0.sig ? "processed" : "confirmed", err: null });
  S.height = b0.lvbh + 1;
  await tick(env, T0 + 60_000);
  const again = await env.DB.prepare("SELECT sig, tries FROM batches WHERE i = 0").first();
  assert.equal(S.sent.length, sentBefore, `re-sent batch 0 (tries ${again.tries}, new sig ${again.sig !== b0.sig}) though its first transaction was already in a block`);
});

// Not in the leads. needs_ata is fixed at the snapshot. A holder who closes their USDC account afterwards makes
// their whole batch of 8 fail on every retry; after 5 tries the batch is 'failed' and 7 other holders get nothing.
test("F3: one holder closing their USDC account after the snapshot blocks the 7 others in their batch", async () => {
  const ws = Array.from({ length: 9 }, (_, i) => holder(1_000_000 * (i + 1)));
  const closer = ata(ws[8]); // biggest bag, so batch 0 with the next 7 biggest
  const hits = (sig) => S.sent.find((x) => x.sig === sig).tx.message.staticAccountKeys.some((k) => k.toBase58() === closer);
  S.status = (sig) => ({ confirmationStatus: "confirmed", err: hits(sig) ? { InstructionError: [3, "InvalidAccountData"] } : null });
  const r = await untilDone(T0);
  assert.equal(r?.status, "done");
  const landed = (w) => paidTo(w).some((x) => !S.status(x.sig).err);
  const unpaid = ws.slice(1, 8).filter((w) => !landed(w));
  assert.equal(unpaid.length, 0, `${unpaid.length} holders got nothing this round because another holder closed their USDC account`);
});

// Lead 6/7. The rent to open each new holder's USDC account (0.00204 SOL, ~$0.41) comes off the top of the pot
// before the swap. The holder can close that account and keep the rent, and wallet-to-wallet moves are free,
// so fresh $50 wallets each round farm it out of everyone's share.
// Under the curve design the pot is the wallet's USDC and `allocate` charges a new wallet's rent to its own share, so the whale's
// share is exactly its weight's part of the pot.
test("F4: existing holders pay for new wallets' USDC accounts (rent the new wallet can reclaim)", async () => {
  const whale = holder(10_000_000);
  Array.from({ length: 20 }, () => holder(50_001, { hasAta: false })); // just over the $50 minimum
  S.sol = 550_000_000;
  S.swapOut = (amount, input) => (input === SOL ? amount / 5n : 0n); // $200/SOL: 1 lamport = 0.2 micro-USDC
  await tick(env, T0);
  const d = await env.DB.prepare("SELECT swap_lamports, rent_lamports FROM drops").first();
  const p = await env.DB.prepare("SELECT micro FROM payouts WHERE wallet = ?").bind(whale).first();
  const W = 10_000_000 + 20 * 50_001;
  const pot = Number(S.usdc); // everything the round's swap bought
  const fair = pot * (10_000_000 / W); // whale's weight share of the whole pot
  assert.equal(d.rent_lamports, 0, "nothing is held back from the swap for rent");
  assert.ok(p.micro >= fair * 0.999, `whale got ${(p.micro / 1e6).toFixed(2)} USDC of a fair ${(fair / 1e6).toFixed(2)}; the rent of 20 new wallets came off the whale's share`);
});

// Lead 7 (display). DRY_RUN rounds are stored as 'done' with usdc_micro and 'confirmed' dry-run batches, and the
// site counts them as USDC airdropped. After a mainnet DRY_RUN watch, the site claims payouts that never happened.
test("F5: DRY_RUN rounds show on the site as USDC paid to holders, though nothing was sent", async () => {
  const ws = Array.from({ length: 3 }, (_, i) => holder(100_000 * (i + 1)));
  const sell = enhancedSell({ sig: "dry-sell", wallet: ws[0], at: T0 - PERIOD, gross: 100_000n * TOK, MINT, vault: VAULT }); // 10,000 CULT of tax = $10
  await postHook(worker, env, [sell]);
  const dry = { ...env, DRY_RUN: "1" };
  assert.equal((await tick(dry, T0)).status, "done");
  assert.equal(S.sent.length, 0, "dry run sent nothing");
  const s = await (await worker.fetch(new Request("http://x/api/state"), dry)).json();
  assert.equal(s.totals.paidUsdc, 0, `the site says ${s.totals.paidUsdc} USDC was airdropped`);
});

// Lead 6. An empty snapshot (one bad RPC page) is taken as "nobody holds": every holder row is deleted, so
// every 7/30-day streak restarts from zero at the next snapshot. Unknown should fail closed.
test("F6: one empty holder snapshot erases every holder's streak for good", async () => {
  const w = holder(1_000_000);
  await env.DB.prepare("INSERT INTO holders (wallet, balance, since, seen) VALUES (?, ?, ?, 0)").bind(w, String(1_000_000n * TOK), T0 - 40 * DAY).run();
  S.sol = 0; // no swap: keep the rounds short
  S.das = () => ({ token_accounts: [], cursor: null });
  await tick(env, T0);
  S.das = null;
  await tick(env, T0 + PERIOD);
  const p = await env.DB.prepare("SELECT weight FROM payouts WHERE wallet = ?").bind(w).first();
  assert.equal(p?.weight, 1_000_000 * 1.5, `a 40-day holder's weight is ${p?.weight}: the 1.5x boost was lost after one empty snapshot`);
});

// Lead 6. `since` is set when a wallet is first seen holding anything and never moves when the balance grows.
// A dust wallet aged 30 days gets 1.5x on a bag it bought yesterday (or received wallet-to-wallet, untaxed).
test("F7: a dust wallet aged 30 days gets the 1.5x boost on a bag it bought the day before", async () => {
  const w = holder(1); // 1 token: under $50, not paid, but its streak starts
  S.sol = 0;
  await tick(env, T0 - 31 * DAY);
  S.balances.set(w, 10_000_000n * TOK);
  await tick(env, T0);
  const p = await env.DB.prepare("SELECT weight FROM payouts WHERE wallet = ?").bind(w).first();
  assert.ok(p.weight <= 10_000_000 + 1, `weight ${p.weight}: the whole new bag got the 30-day boost`);
});

// Lead 7. allocate reads the USDC balance with the RPC default commitment (finalized) seconds after the swap
// confirmed, so the round usually pays without its own swap; the USDC goes to next round's holders instead.
test("F8: a round pays the USDC its own swap just bought", async () => {
  Array.from({ length: 3 }, (_, i) => holder(100_000 * (i + 1)));
  S.usdcFinal = 0n; // finalized view hasn't caught up with the swap yet
  await tick(env, T0);
  const d = await env.DB.prepare("SELECT usdc_micro FROM drops").first();
  assert.ok(d.usdc_micro > 29_000_000, `round paid ${d.usdc_micro / 1e6} USDC of the 30 its swap bought`);
});

// Not in the leads. pollMint asks getTransaction with maxSupportedTransactionVersion 0. Mainnet carries version-1
// transactions; the RPC answers -32015 for one, pollMint throws, and the cursor never moves past it.
test("F9: one version-1 transaction on the mint stalls the history poller for good", async () => {
  const V1 = "v1sig", NEXT = "nextsig";
  S.sigs = [{ signature: NEXT, err: null }, { signature: V1, err: null }]; // newest first
  S.getTx = (sig, opts) => {
    if (sig === V1 && !(opts?.maxSupportedTransactionVersion >= 1)) throw new RpcError(-32015, "Transaction version (1) is not supported by the requesting client");
    return { slot: 5, blockTime: 1, meta: { err: null, fee: 5000, preTokenBalances: [], postTokenBalances: [], preBalances: [], postBalances: [] }, transaction: { message: { accountKeys: [] } } };
  };
  const cfg = config(env);
  await pollMint(env, cfg, T0).catch(() => {});
  await pollMint(env, cfg, T0 + 60_000).catch(() => {});
  const cur = await env.DB.prepare("SELECT v FROM kv WHERE k = 'poll_cursor'").first();
  assert.equal(cur ? JSON.parse(cur.v) : null, NEXT, "the poller never got past the version-1 transaction");
});
