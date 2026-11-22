// The RPC poller (indexer.pollMint) on a deployment's first run: the mint's whole history, oldest first, from real mainnet
// transactions (test/fixtures/raw-txs.json: the throwaway DBC token's buy and sell). A failed signature is never fetched.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { pollMint } from "../src/indexer.js";
import { config } from "../src/config.js";
import { addr } from "./fakes.js";
import { makeVault, CLEAR, boot, freshS, installFakes } from "./engine-fakes.js";

const RAW = JSON.parse(readFileSync(new URL("./fixtures/raw-txs.json", import.meta.url), "utf8"));
const PERSIST = ".wrangler/poller-test";
const kp = Keypair.generate(), PAYOUT = kp.publicKey.toBase58(), VAULT = makeVault();
const MINT = "2GHaaCNpbFzNSaSFRACaX7mPLLboUPykykSx9QGKpZPZ"; // the real throwaway mint the fixtures belong to
const BUY = RAW["dbc:buy"], SELL = RAW["dbc:sell"];
const T = 1_800_000_000_000;
let proxy, env, S, restoreFetch;
before(async () => {
  ({ proxy, env } = await boot(PERSIST, { MINT, PAYOUT, kp }));
  restoreFetch = installFakes({ S: () => S, MINT, PAYOUT, env: () => env });
});
after(async () => { await proxy?.dispose(); restoreFetch?.(); });
beforeEach(async () => {
  S = freshS({ PAYOUT, vault: VAULT });
  S.getTx = (sig) => (sig === BUY.sig ? BUY.tx : sig === SELL.sig ? SELL.tx : (() => { throw new Error("fetched " + sig); })());
  await env.DB.batch(CLEAR.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
const first = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const fetched = () => S.calls.filter((c) => c.method === "getTransaction").map((c) => c.params[0]);

test("the first poll of a new deployment reads the history oldest first, skips the failed signature without fetching it, records the buy and the sell once, and keeps a cursor", async () => {
  const failed = addr();
  S.sigs = [{ signature: SELL.sig }, { signature: failed, err: { InstructionError: [0, "x"] } }, { signature: BUY.sig }]; // newest first, as the RPC answers
  const r = await pollMint(env, config(env), T);
  assert.deepEqual([r.polled, r.added], [3, 1], "three signatures read; one sell added to the Wall (the buy is a trade, not a sell)");
  assert.deepEqual(fetched(), [BUY.sig, SELL.sig], "oldest first, and nothing fetched for the failed one");
  assert.equal((await first("SELECT COUNT(*) AS c FROM trades")).c, 2);
  assert.equal((await first("SELECT COUNT(*) AS c FROM sells")).c, 1);
  const buy = await first("SELECT * FROM trades WHERE side = 'buy'");
  assert.equal(buy.tokens, 332397766917, "what the vault gave up");
  assert.equal(buy.withheld, 33239776692, "the 10% held back in the buyer's account");
  assert.equal(JSON.parse((await first("SELECT v FROM kv WHERE k = 'poll_cursor'")).v), SELL.sig, "the newest signature, so the next poll starts after it");
  assert.equal((await first("SELECT COUNT(*) AS c FROM fee_accounts")).c, 2, "the trader's token account (one wallet bought and sold) and the pool vault are queued for the refund engine");
  // the next poll sees nothing new
  S.sigs = [];
  S.calls.length = 0;
  assert.deepEqual(await pollMint(env, config(env), T + 60_000), { polled: 0 });
  assert.deepEqual(fetched(), []);
});

test("with no price the poller records nothing and keeps its cursor, but still queues the accounts for refunds", async () => {
  S.tokenUsd = 0;
  S.sigs = [{ signature: SELL.sig }, { signature: BUY.sig }];
  const r = await pollMint(env, config(env), T);
  assert.equal(r.noPrice, true);
  assert.equal((await first("SELECT COUNT(*) AS c FROM trades")).c, 0);
  assert.equal(await first("SELECT v FROM kv WHERE k = 'poll_cursor'"), null, "the same signatures are read again once there is a price");
  assert.equal((await first("SELECT COUNT(*) AS c FROM fee_accounts")).c, 2);
});
