// The HTTP side of trading (docs/API.md): quote, trade, tx status, refund hint, and the state fields that changed. Jupiter and the RPC are
// faked in their real answer shapes; the refund hint reads the REAL buy transaction from test/fixtures/raw-txs.json.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import { Keypair, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ed25519 } from "@noble/curves/ed25519.js";
import worker from "../src/index.js";
import { jupQuote, jupSwapInstructions, tokenAccount, SOL, addr, b64 } from "./fakes.js";
import { JUPITER_PROGRAM } from "../src/jupiter.js";

const PERSIST = ".wrangler/api-test";
const RAW = JSON.parse(readFileSync(new URL("./fixtures/raw-txs.json", import.meta.url), "utf8"));
const fee = Keypair.generate(), PAYOUT = fee.publicKey.toBase58(), MINT = "2GHaaCNpbFzNSaSFRACaX7mPLLboUPykykSx9QGKpZPZ"; // the real DBC test mint, for the real buy fixture
const buyer = Keypair.generate().publicKey.toBase58();
const BUYER_ATA = getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(buyer), false, TOKEN_2022_PROGRAM_ID).toBase58();
let proxy, env, J, R;
const RL = { calls: [], block: new Set(), throws: false }; // stand-ins for the two rate-limit bindings
const bucket = (name) => ({ limit: async ({ key }) => { if (RL.throws) throw new Error("binding down"); RL.calls.push([name, key]); return { success: !RL.block.has(name) }; } });
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = String(input?.url || input);
  if (url.startsWith("https://jup.test/swap/v1/quote")) {
    const p = new URL(url).searchParams, [i, o] = [p.get("inputMint"), p.get("outputMint")];
    if (J.noRoute) return Response.json({ error: "Could not find any route" }, { status: 400 });
    if (J.emptyRoute) return Response.json({ ...jupQuote({ inputMint: i, outputMint: o, amount: p.get("amount"), out: 1n }), routePlan: [] });
    const out = J.out ? J.out(BigInt(p.get("amount")), i) : 1_000_000n;
    return Response.json(jupQuote({ inputMint: i, outputMint: o, amount: p.get("amount"), out, impact: J.impact ?? "0.1049" }));
  }
  if (url.startsWith("https://jup.test/swap/v1/swap-instructions")) {
    const b = JSON.parse(init.body), q = b.quoteResponse, inMint = q.inputMint;
    const a = jupSwapInstructions({ user: b.userPublicKey, inputMint: inMint, inputProgram: inMint === MINT ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, outputMint: q.outputMint, outputProgram: q.outputMint === MINT ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, amount: BigInt(q.inAmount) });
    J.calls.push(b);
    return Response.json(J.mutate ? J.mutate(a) : a);
  }
  if (url.startsWith("https://jup.test/price")) return Response.json({ [SOL]: { usdPrice: 200 }, [MINT]: { usdPrice: 0.001 } });
  if (url.startsWith("https://rpc.test")) {
    const { method, params } = JSON.parse(init.body);
    R.calls.push(method);
    const result = R.answer(method, params);
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  }
  return realFetch(input, init);
};

before(async () => {
  rmSync(PERSIST, { recursive: true, force: true });
  execSync(`node node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --local --persist-to ${PERSIST}`, { stdio: "ignore", env: { ...process.env, CI: "1" } });
  proxy = await getPlatformProxy({ configPath: "wrangler.jsonc", persist: { path: PERSIST + "/v3" } });
  env = { ...proxy.env, DEMO: "0", DRY_RUN: "1", REFUNDS_DRY_RUN: "1", MINT, PAYOUT_WALLET: PAYOUT, RL_TRADE: bucket("trade"), RL_READ: bucket("read"), SOLANA_RPC_URL: "https://rpc.test", JUP_API: "https://jup.test", PAYOUT_SECRET_KEY: JSON.stringify([...fee.secretKey]), ASSETS: { fetch: () => new Response("") } };
});
after(async () => { await proxy?.dispose(); globalThis.fetch = realFetch; rmSync(PERSIST, { recursive: true, force: true }); });
beforeEach(async () => {
  J = { calls: [], out: null };
  RL.calls = []; RL.block = new Set(); RL.throws = false;
  R = { calls: [], accounts: new Map(), answer: (method, params) => {
    if (method === "getLatestBlockhash") return { value: { blockhash: addr(), lastValidBlockHeight: 5000 } };
    if (method === "getMultipleAccounts") return { value: params[0].map((a) => (R.accounts.has(a) ? { lamports: 1, data: [b64(R.accounts.get(a)), "base64"] } : null)) };
    if (method === "getTransaction") return R.tx || null;
    if (method === "getSignatureStatuses") return { value: params[0].map(() => R.status ?? null) };
    throw new Error("unmocked " + method);
  } };
  await env.DB.batch(["kv", "fee_accounts", "fee_batches"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

const get = (p, e = env) => worker.fetch(new Request("http://x" + p), e);
const post = (p, body, e = env) => worker.fetch(new Request("http://x" + p, { method: "POST", body: JSON.stringify(body) }), e);
const trade = (body, e = env) => post("/api/trade", { wallet: buyer, side: "buy", amount: "1000000", slippageBps: 100, ...body }, e);

/* ---------- quote ---------- */

test("quote: a sell shows the 10% explicitly, with the impact counted without it", async () => {
  J.out = () => 2_693_936n; J.impact = "0.1044472262835";
  const r = await get("/api/quote?side=sell&amount=100000000000&slippageBps=100");
  assert.equal(r.status, 200);
  const q = await r.json();
  assert.deepEqual([q.side, q.amountIn, q.outAmount, q.minOut], ["sell", "100000000000", "2693936", "2666996"]);
  assert.deepEqual(q.tax, { bps: 1000, amount: "10000000000" }, "the withheld coin, raw");
  assert.equal(q.priceImpactBps, 49);
  assert.equal(q.refund, undefined);
  assert.equal(q.route, "Fake");
  assert.ok(Math.abs(q.taxUsd - 10) < 1e-9, "10,000 coin withheld x $0.001 = $10");
});

test("quote: a buy shows what comes back: outAfterRefund = out + out x 10/90, and no tax", async () => {
  J.out = () => 900_000_000n; J.impact = "0.1002";
  const q = await (await get("/api/quote?side=buy&amount=10000000")).json();
  assert.deepEqual(q.tax, { bps: 0, amount: "0" });
  assert.equal(q.refund.amount, "100000000");
  assert.equal(q.outAfterRefund, "1000000000");
  assert.equal(q.slippageBps, 100, "the default");
  assert.equal(q.priceImpactBps, 2);
});

test("quote: bad input and no route are answered in plain words", async () => {
  assert.equal((await get("/api/quote?side=hold&amount=5")).status, 400);
  for (const amount of ["", "0", "-5", "1.5", "abc"]) { const r = await get(`/api/quote?side=buy&amount=${amount}`); assert.equal(r.status, 400, amount); assert.equal((await r.json()).error, "Enter an amount."); }
  J.noRoute = true;
  const r = await get("/api/quote?side=sell&amount=5");
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /no route/i);
  assert.equal((await get("/api/quote?side=sell&amount=5", { ...env, MINT: "" })).status, 503);
});

test("quote: slippage is held between 0.1% and 20%", async () => {
  assert.equal((await (await get("/api/quote?side=buy&amount=5&slippageBps=1")).json()).slippageBps, 10);
  assert.equal((await (await get("/api/quote?side=buy&amount=5&slippageBps=99999")).json()).slippageBps, 2000);
});

/* ---------- trade ---------- */

const decode = async (r) => { const b = await r.json(); return { ...b, tx: b.transaction && VersionedTransaction.deserialize(Buffer.from(b.transaction, "base64")) }; };
const signers = (tx) => tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58());

test("a sell: Jupiter's swap, the wallet the only signer, no refund, nothing for the fee key", async () => {
  const b = await decode(await trade({ side: "sell", amount: "5000000" }));
  assert.equal(b.refund, "none");
  assert.deepEqual(signers(b.tx), [buyer]);
  assert.ok(b.lastValidBlockHeight > 0);
  assert.equal(b.tax.amount, "500000");
  assert.ok(Math.abs(b.taxUsd - 0.0005) < 1e-12, "the trade answer carries taxUsd like the quote: 0.5 coin x $0.001");
  assert.ok(!b.tx.message.staticAccountKeys.some((k) => k.toBase58() === PAYOUT), "our key is nowhere in a sell");
});

test("a buy by default: a plain swap, the refund comes after ('after'), the wallet the only signer", async () => {
  const b = await decode(await trade({}));
  assert.equal(b.refund, "after");
  assert.deepEqual(signers(b.tx), [buyer]);
  assert.equal(b.refundAmount, "111111", "1,000,000 out x 10 / 90, rounded down: the expected refund travels as refundAmount; refund is the mode");
  assert.equal(b.outAfterRefund, "1111111");
  assert.equal(J.calls.length, 1);
});

test("a buy with ATOMIC_REFUND: the refund is in the same transaction, signed by the fee key over the very message the wallet will sign", async () => {
  const b = await decode(await trade({}, { ...env, ATOMIC_REFUND: "1" }));
  assert.equal(b.refund, "atomic");
  assert.deepEqual(signers(b.tx), [buyer, PAYOUT]);
  const keys = b.tx.message.staticAccountKeys.map((k) => k.toBase58());
  const ixs = b.tx.message.compiledInstructions;
  const r = ixs.at(-1);
  assert.equal(keys[r.programIdIndex], TOKEN_2022_PROGRAM_ID.toBase58());
  assert.deepEqual([...r.data], [26, 3, 1]);
  assert.deepEqual(r.accountKeyIndexes.map((i) => keys[i]), [MINT, BUYER_ATA, PAYOUT, BUYER_ATA], "the refund is for the buyer's own token account, after the swap");
  assert.ok(ixs.slice(0, -1).some((i) => keys[i.programIdIndex] === JUPITER_PROGRAM), "and the swap comes before it");
  assert.ok(b.tx.signatures[0].every((x) => x === 0), "the wallet's slot is empty");
  assert.ok(ed25519.verify(b.tx.signatures[1], b.tx.message.serialize(), fee.publicKey.toBytes()), "the fee key's signature is valid for this exact message");
  assert.equal(J.calls[0].userPublicKey, buyer);
});

test("atomic: the request can force either way, per trade", async () => {
  assert.equal((await decode(await trade({ atomic: true }))).refund, "atomic");
  assert.equal((await decode(await trade({ atomic: false }, { ...env, ATOMIC_REFUND: "1" }))).refund, "after");
});

test("atomic falls back to the plain swap ('after') when the key is missing, Jupiter's answer mentions the fee key, or it would not fit", async () => {
  assert.equal((await decode(await trade({ atomic: true }, { ...env, PAYOUT_SECRET_KEY: "" }))).refund, "after", "no key");
  J.mutate = (a) => ({ ...a, swapInstruction: { ...a.swapInstruction, accounts: [...a.swapInstruction.accounts, { pubkey: PAYOUT, isSigner: false, isWritable: true }] } });
  const dirty = await decode(await trade({ atomic: true }));
  assert.equal(dirty.refund, "after", "Jupiter's instructions named our key: the co-signed version is refused");
  assert.deepEqual(signers(dirty.tx), [buyer], "and the plain version is still safe to hand out");
  J.mutate = (a) => ({ ...a, setupInstructions: [...a.setupInstructions, ...Array(150).fill(a.setupInstructions[0])] });
  const big = await trade({ atomic: true });
  assert.equal(big.status, 503, "an oversize route is refused in words, not a crash");
  assert.match((await big.json()).error, /too big for one transaction/);
});

test("a buyer whose token account has a delegate pays the tax like any program-owned account: no refund is built for it", async () => {
  R.accounts.set(BUYER_ATA, tokenAccount({ mint: MINT, owner: buyer, amount: 5n, delegate: addr() }));
  const b = await decode(await trade({ atomic: true }));
  assert.equal(b.refund, "none");
  assert.deepEqual(signers(b.tx), [buyer]);
});

test("trade: the payout wallet can't be the buyer, and bad bodies get plain answers", async () => {
  assert.equal((await trade({ wallet: PAYOUT })).status, 400);
  assert.equal((await trade({ wallet: "nope" })).status, 400);
  assert.equal((await trade({ side: "hodl" })).status, 400);
  assert.equal((await trade({ amount: "0" })).status, 400);
  assert.equal((await post("/api/trade", "not json")).status, 400);
  J.out = () => 0n;
  const r = await trade({});
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "That amount is too small.");
});

test("trade: a hostile Jupiter answer is never handed to a wallet", async () => {
  J.mutate = (a) => ({ ...a, setupInstructions: [...a.setupInstructions, { programId: "11111111111111111111111111111111", accounts: [{ pubkey: buyer, isSigner: true, isWritable: true }, { pubkey: addr(), isSigner: false, isWritable: true }], data: Buffer.from([2, 0, 0, 0, 0, 0xca, 0x9a, 0x3b, 0, 0, 0, 0]).toString("base64") }] });
  const r = await trade({});
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /Couldn't build that trade/);
});

/* ---------- tx status, hint, removed routes ---------- */

test("GET /api/tx/:sig: sent until it is confirmed", async () => {
  const sig = "5".repeat(88);
  R.status = null; assert.deepEqual(await (await get("/api/tx/" + sig)).json(), { status: "sent" });
  R.status = { confirmationStatus: "processed", err: null }; assert.deepEqual(await (await get("/api/tx/" + sig)).json(), { status: "sent" });
  R.status = { confirmationStatus: "confirmed", err: null }; assert.deepEqual(await (await get("/api/tx/" + sig)).json(), { status: "confirmed" });
  R.status = { confirmationStatus: "finalized", err: { InstructionError: [0, "x"] } }; assert.deepEqual(await (await get("/api/tx/" + sig)).json(), { status: "failed" });
});

test("POST /api/refund/hint reads the chain (here the real DBC buy) and queues the buyer's account and the vault; the browser's word is only a nudge", async () => {
  R.tx = RAW["dbc:buy"].tx;
  const BUYER_REAL = "ECFmvyQo7w1YtuAZbtkPxrbg1NX9ghF1rEECCRqNQg22", ATA_REAL = "C1chZPB4uUTgdqrBnxSHnTfW6b6dkKX8PH5855LPyAYS", VAULT = "7WZWwgCGxmvJ1G15qmdXkz4EShWt6DdEW7T9bU7hjZXE", VAULT_OWNER = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM";
  R.accounts.set(VAULT, tokenAccount({ mint: MINT, owner: VAULT_OWNER, withheld: 9_000n })); // a pool vault's tax is not the buyer's business
  R.accounts.set(ATA_REAL, tokenAccount({ mint: MINT, owner: BUYER_REAL, amount: 5n, withheld: 7_000n }));
  const hint = async () => (await post("/api/refund/hint", { sig: RAW["dbc:buy"].sig })).json();
  assert.deepEqual(await hint(), { queued: 2, refunded: false }, "the buyer's account still holds withheld tokens");
  R.accounts.set(ATA_REAL, tokenAccount({ mint: MINT, owner: BUYER_REAL, amount: 5_007n, withheld: 0n }));
  assert.deepEqual(await hint(), { queued: 2, refunded: true }, "the page polls this until the refund has landed (the vault's withheld tokens don't count)");
  R.accounts.set(ATA_REAL, tokenAccount({ mint: "11111111111111111111111111111111", owner: BUYER_REAL, withheld: 7_000n }));
  assert.equal((await hint()).refunded, true, "an account of another mint is not ours to wait for");
  R.accounts.set(ATA_REAL, tokenAccount({ mint: MINT, owner: BUYER_REAL, withheld: 7_000n }));
  const down = R.answer; R.answer = (m, p) => { if (m === "getMultipleAccounts") throw new Error("rpc down"); return down(m, p); };
  assert.equal((await hint()).refunded, false, "a read that fails is 'not yet', never 'refunded'");
  R.answer = down;
  assert.ok(R.calls.includes("getTransaction"));
  const rows = (await env.DB.prepare("SELECT address, owner, state FROM fee_accounts ORDER BY address").all()).results;
  assert.deepEqual(rows.map((x) => x.address), ["7WZWwgCGxmvJ1G15qmdXkz4EShWt6DdEW7T9bU7hjZXE", "C1chZPB4uUTgdqrBnxSHnTfW6b6dkKX8PH5855LPyAYS"]);
  assert.ok(rows.every((x) => x.state === "queued"), "refunds are dry in this environment: queued, not acted on");
  assert.equal((await (await post("/api/refund/hint", { sig: RAW["dbc:buy"].sig })).json()).queued, 2, "twice is safe");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS c FROM fee_accounts").first()).c, 2);
  assert.equal((await post("/api/refund/hint", { sig: "short" })).status, 400);
  R.tx = RAW["damm:buy"].tx; // a real transaction of ANOTHER coin: nothing of ours in it
  assert.deepEqual(await (await post("/api/refund/hint", { sig: RAW["damm:buy"].sig })).json(), { queued: 0, refunded: false }, "nothing touched means nothing refunded, not 'refunded'");
  R.tx = null;
  assert.deepEqual(await (await post("/api/refund/hint", { sig: "7".repeat(88) })).json(), { queued: 0, refunded: false }, "a signature the chain doesn't know queues nothing and has refunded nothing");
});

test("a buy may wrap what it sells plus 2,100,000 lamports of account rent, not a lamport more; a sell wraps nothing", async () => {
  const wrapOf = (L) => { const d = Buffer.alloc(12); d.writeUInt32LE(2, 0); d.writeBigUInt64LE(BigInt(L), 4); return d.toString("base64"); };
  const SYS = SystemProgram.programId.toBase58();
  J.mutate = (a) => ({ ...a, setupInstructions: a.setupInstructions.map((i) => (i.programId === SYS ? { ...i, data: wrapOf(1_000_000n + 2_100_000n) } : i)) });
  assert.equal((await trade({})).status, 200);
  J.mutate = (a) => ({ ...a, setupInstructions: a.setupInstructions.map((i) => (i.programId === SYS ? { ...i, data: wrapOf(1_000_000n + 2_100_001n) } : i)) });
  assert.equal((await trade({})).status, 503);
  const wsol = getAssociatedTokenAddressSync(new PublicKey(SOL), new PublicKey(buyer), true, TOKEN_PROGRAM_ID).toBase58();
  J.mutate = (a) => ({ ...a, setupInstructions: [...a.setupInstructions, { programId: SYS, accounts: [{ pubkey: buyer, isSigner: true, isWritable: true }, { pubkey: wsol, isSigner: false, isWritable: true }], data: wrapOf(1) }] });
  assert.equal((await trade({ side: "sell", amount: "5000000" })).status, 503, "a sell has nothing to wrap: even one lamport is refused");
});

test("a buyer on REFUND_DENY with no token account yet gets the plain swap and refund 'none' even when atomic is asked for", async () => {
  const b = await decode(await trade({ atomic: true }, { ...env, REFUND_DENY: buyer }));
  assert.equal(b.refund, "none");
  assert.deepEqual(signers(b.tx), [buyer]);
});

test("amounts: 2^62 and above are refused (nothing real is that large), and a quote with no route in it is a no-route answer", async () => {
  assert.equal((await trade({ amount: "4611686018427387904" })).status, 400);
  assert.equal((await get("/api/quote?side=buy&amount=4611686018427387904")).status, 400);
  assert.equal((await trade({ amount: "4611686018427387903" })).status, 200);
  J.emptyRoute = true;
  const r = await get("/api/quote?side=buy&amount=5");
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /no route/i);
});

test("rate limits: trades and refund hints share one bucket, quotes and status reads another; over the limit is a plain 429; a broken binding lets requests through", async () => {
  const sig = "5".repeat(88);
  await trade({}); await post("/api/refund/hint", { sig: "short" }); await get("/api/quote?side=buy&amount=5"); await get("/api/tx/" + sig);
  assert.deepEqual(RL.calls.map((c) => c[0]), ["trade", "trade", "read", "read"]);
  assert.deepEqual(new Set(RL.calls.map((c) => c[1])).size, 4, "each endpoint has its own counter per caller");
  RL.block = new Set(["trade"]);
  for (const r of [await trade({}), await post("/api/refund/hint", { sig })]) { assert.equal(r.status, 429); assert.equal((await r.json()).error, "Too many requests. Wait a minute and try again."); }
  assert.equal((await get("/api/quote?side=buy&amount=5")).status, 200, "quotes use the other bucket");
  RL.block = new Set(["read"]);
  assert.equal((await get("/api/quote?side=buy&amount=5")).status, 429);
  assert.equal((await get("/api/tx/" + sig)).status, 429);
  assert.equal((await trade({})).status, 200, "trades use the other bucket");
  RL.throws = true; RL.block = new Set(["read", "trade"]);
  assert.equal((await get("/api/quote?side=buy&amount=5")).status, 200, "a binding that throws never blocks anyone");
});

test("demo data follows sellTaxBps: the wall pays 10% of what was sold (5% when the var says so), not the old 15%", async () => {
  for (const [bps, tax] of [["1000", 0.1], ["500", 0.05]]) {
    const s = await (await get("/api/state", { ...env, DEMO: "1", SELL_TAX_BPS: bps })).json();
    assert.equal(s.sellTaxBps, Number(bps));
    assert.ok(s.wall.latest.length > 0 && s.wall.latest.every((l) => Math.abs(l.paidUsdc - l.soldUsd * tax) <= 0.005), bps);
    assert.ok(Math.abs(s.totals.volumeUsd / s.totals.paidUsdc - 2.1 / tax) < 0.05, "volume = paid / tax x 2.1: " + s.totals.volumeUsd / s.totals.paidUsdc);
  }
});

test("with no MINT, or a PAYOUT_WALLET that is not an address, every trading route says 'Trading opens at launch.' (503) and the state's trade flag is false", async () => {
  const sig = "5".repeat(88);
  for (const off of [{ MINT: "" }, { PAYOUT_WALLET: "nope" }, { PAYOUT_WALLET: "" }]) {
    const e = { ...env, ...off };
    for (const r of [await get("/api/quote?side=buy&amount=5", e), await trade({}, e), await get("/api/tx/" + sig, e), await post("/api/refund/hint", { sig }, e)]) {
      assert.equal(r.status, 503, JSON.stringify(off));
      assert.equal((await r.json()).error, "Trading opens at launch.");
    }
    assert.equal((await (await get("/api/state", e)).json()).trade, false, JSON.stringify(off));
  }
  assert.equal((await (await get("/api/state")).json()).trade, true);
});

test("demo data with SELL_TAX_BPS 0 stays finite (the volume divides by the tax)", async () => {
  const s = await (await get("/api/state", { ...env, DEMO: "1", SELL_TAX_BPS: "0" })).json();
  assert.ok(Number.isFinite(s.totals.volumeUsd) && s.totals.volumeUsd > 0, String(s.totals.volumeUsd));
  assert.ok(s.wall.latest.every((l) => Number.isFinite(l.paidUsdc)));
});

test("the pool and relay routes are gone", async () => {
  assert.equal((await get("/api/pool")).status, 404);
  assert.equal((await post("/api/send", { signed: "x" })).status, 404);
});

/* ---------- state ---------- */

test("/api/state: sellTaxBps and the pool stage in; the pool-era fields out", async () => {
  await env.DB.prepare("INSERT INTO kv (k, v, at) VALUES ('curve', ?, ?)").bind(JSON.stringify({ stage: "curve", progressBps: 3400, raisedLamports: 29_240_000_000, thresholdLamports: 86_000_000_000, pool: addr(), at: Date.now() }), Date.now()).run();
  const s = await (await get("/api/state")).json();
  assert.equal(s.sellTaxBps, 1000);
  assert.deepEqual([s.pool.stage, s.pool.progressBps, s.pool.raisedSol, s.pool.thresholdSol], ["curve", 3400, 29.24, 86]);
  for (const gone of ["clientRpc", "buyFeeBps", "accounts", "pendingFromJoins"]) assert.equal(gone in s, false, gone + " is gone");
  assert.equal("joinFeesUsd" in s.totals, false);
  assert.equal(s.trade, true);
  const pre = await (await get("/api/state", { ...env, MINT: "" })).json();
  assert.equal(pre.live, false);
  assert.equal(pre.pool, undefined);
});
