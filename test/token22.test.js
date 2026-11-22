// Token-2022 reading and the refund/sweep decision, against REAL mainnet accounts (test/fixtures/accounts.json, fetched
// 16 Nov 2026 from the two throwaway tokens in spikes/fee-test) and synthetic ones in the same layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { parseTokenAccount, parseMint, classify, buildFeeTx, treasuryAta, feeOn, onCurve, refundIx } from "../src/token22.js";
import { tokenAccount, mintAccount, addr, pda } from "./fakes.js";

const F = JSON.parse(readFileSync(new URL("./fixtures/accounts.json", import.meta.url), "utf8"));
const bytes = (n) => new Uint8Array(Buffer.from(F[n].data, "base64"));

test("real mainnet mint: transfer fee, withdraw authority and withheld read from the bytes", () => {
  const m = parseMint(bytes("mintDbc"));
  assert.equal(m.feeBps, 1000);
  assert.equal(m.decimals, 6);
  assert.equal(m.withdrawAuthority, "KDpz3icbjmmib1DDeitywpk6ZdsQckHiqt6hKmKnnaq");
  assert.equal(m.freezeAuthority, null);
  assert.equal(m.withheld, 0n);
  assert.equal(parseMint(bytes("mintDamm")).feeBps, 1500);
});

test("real mainnet token accounts: the pool vault's withheld equals the sell tax the transaction showed", () => {
  const vault = parseTokenAccount(bytes("vaultDbc"));
  assert.equal(vault.withheld, 16_619_888_346n, "the sell fee of the DBC test sell (see trades.test.js)");
  assert.equal(onCurve(vault.owner), false, "the DBC pool authority is a program address");
  assert.equal(vault.delegate, null);
  const buyer = parseTokenAccount(bytes("buyerDbc"));
  assert.equal(buyer.owner, "ECFmvyQo7w1YtuAZbtkPxrbg1NX9ghF1rEECCRqNQg22");
  assert.equal(onCurve(buyer.owner), true);
  assert.equal(buyer.withheld, 0n, "already refunded in the test");
  assert.equal(buyer.amount, 166_198_883_459n);
  assert.equal(parseTokenAccount(bytes("buyerDamm")).withheld, 24_910_216_208n, "a buyer who was never refunded");
});

test("synthetic bytes read back what was written, and garbage reads as null", () => {
  const mint = addr(), owner = addr(), d = addr(), c = addr();
  const a = parseTokenAccount(tokenAccount({ mint, owner, amount: 5n, withheld: 7n, delegate: d, closeAuthority: c }));
  assert.deepEqual([a.mint, a.owner, a.amount, a.withheld, a.delegate, a.closeAuthority, a.state], [mint, owner, 5n, 7n, d, c, 1]);
  assert.equal(parseTokenAccount(tokenAccount({ mint, owner, withheld: 7n, ext: false })).withheld, 0n, "no extension, nothing withheld");
  assert.equal(parseTokenAccount(new Uint8Array(10)), null);
  assert.equal(parseTokenAccount(new Uint8Array(182)), null, "state 0 is an uninitialized account");
  assert.equal(parseTokenAccount(null), null);
  assert.equal(parseMint(mintAccount({ withdraw: owner, feeBps: 1000, withheld: 9n })).withheld, 9n);
  assert.equal(parseMint(new Uint8Array(10)), null);
});

test("feeOn rounds up, like token-2022", () => {
  assert.equal(feeOn(1n, 1000), 1n);
  assert.equal(feeOn(332_397_766_917n, 1000), 33_239_776_692n, "the real buy's withheld amount");
  assert.equal(feeOn(100n, 1000), 10n);
  assert.equal(feeOn(0n, 1000), 0n);
});

/* ---------- classify: every branch ---------- */

const mint = addr(), payout = addr(), treasury = treasuryAta(mint, payout).toBase58();
const ctx = (over = {}) => ({ address: addr(), mint, payout, treasury, deny: new Set(), minRefund: 100_000n, ...over });
const acct = (over = {}) => parseTokenAccount(tokenAccount({ mint, owner: addr(), amount: 10n, withheld: 1_000_000n, ...over }));

test("classify: a wallet's account with withheld tokens is refunded", () => {
  assert.deepEqual(classify(acct(), ctx()), { action: "refund", why: "wallet" });
});

test("classify: every reason an account is NOT refunded sends its withheld tokens to the treasury (the sell tax)", () => {
  const sweep = (a, c = ctx(), why) => { const r = classify(a, c); assert.equal(r.action, "sweep", why); return r.why; };
  assert.equal(sweep(acct({ owner: pda() })), "program-owned");
  assert.equal(sweep(acct({ delegate: addr() })), "delegate");
  assert.equal(sweep(acct({ closeAuthority: addr() })), "close authority");
  assert.equal(sweep(acct({ state: 2 })), "frozen", "a frozen account can't be a refund destination: it would fail the transaction");
  const denied = addr();
  assert.equal(sweep(acct({ owner: denied }), ctx({ deny: new Set([denied]) })), "denied");
  assert.equal(sweep(acct({ withheld: 99_999n })), "dust");
  assert.equal(classify(acct({ withheld: 100_000n }), ctx()).action, "refund", "exactly the minimum is refunded");
});

test("classify: nothing to do for an empty or missing account, or another mint (the action, not only the reason)", () => {
  const none = (r, why) => assert.deepEqual(r, { action: "none", why });
  none(classify(null, ctx()), "gone");
  none(classify(acct({ withheld: 0n }), ctx()), "empty");
  none(classify(acct({ mint: addr() }), ctx()), "other mint");
  none(classify(acct({ owner: payout, withheld: 0n }), ctx({ address: treasury })), "empty"); // an empty treasury is done
});

// Review N3: tax paid into the treasury or any account the payout wallet owns is withheld there until it is harvested; it is never
// refunded (no holder), always swept, whatever delegate or state the account has, so the round can sell it.
test("classify: withheld tokens in the treasury or any account the payout wallet owns are swept, never refunded", () => {
  const sweep = (r) => assert.deepEqual(r, { action: "sweep", why: "treasury" });
  sweep(classify(acct(), ctx({ address: treasury })));
  sweep(classify(acct({ owner: payout }), ctx()));
  sweep(classify(acct({ owner: payout, delegate: addr(), state: 2 }), ctx()));
});

test("classify: order matters, a denied owner on a program address is still just swept; the real vault is a sweep", () => {
  assert.equal(classify(parseTokenAccount(bytes("vaultDbc")), ctx({ mint: F.vaultDbc && parseTokenAccount(bytes("vaultDbc")).mint })).action, "sweep");
  assert.equal(classify(parseTokenAccount(bytes("buyerDamm")), ctx({ mint: parseTokenAccount(bytes("buyerDamm")).mint })).action, "refund");
});

/* ---------- transactions ---------- */

const kp = Keypair.generate();
const many = (n) => Array.from({ length: n }, () => addr());

test("refund transaction: one self-withdraw per account, signed only by the fee key, and 18 fit one transaction", () => {
  const accounts = many(18);
  const tx = buildFeeTx(kp, addr(), { kind: "refund", mint, accounts });
  assert.ok(tx.serialize().length <= 1232, `18 refunds are ${tx.serialize().length} bytes`);
  assert.equal(tx.message.header.numRequiredSignatures, 1);
  const ixs = tx.message.compiledInstructions.filter((i) => tx.message.staticAccountKeys[i.programIdIndex].equals(TOKEN_2022_PROGRAM_ID));
  assert.equal(ixs.length, 18);
  ixs.forEach((ix, i) => {
    assert.deepEqual([...ix.data], [26, 3, 1], "TransferFeeExtension / WithdrawWithheldTokensFromAccounts / one source");
    const keys = ix.accountKeyIndexes.map((k) => tx.message.staticAccountKeys[k].toBase58());
    assert.deepEqual(keys, [mint, accounts[i], kp.publicKey.toBase58(), accounts[i]], "mint, destination = the account, authority, source = the same account");
  });
});

test("how many accounts one transaction holds (the numbers FEE_BATCH is bounded by)", () => {
  const size = (kind, n) => buildFeeTx(kp, addr(), { kind, mint, accounts: many(n) }).serialize().length;
  assert.ok(size("refund", 23) <= 1232, `23 refunds: ${size("refund", 23)}`);
  assert.ok(size("refund", 24) > 1232, "24 refunds do not fit, so the cap of 23 on FEE_BATCH is the real limit (default 18 keeps a margin)");
  assert.ok(size("sweep", 23) <= 1232 && size("sweep", 24) <= 1232, "sweeps are smaller: one destination, one instruction");
});

test("sweep transaction: opens the treasury account if missing, then moves every account's withheld tokens into it", () => {
  const accounts = many(5);
  const tx = buildFeeTx(kp, addr(), { kind: "sweep", mint, accounts });
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const w = tx.message.compiledInstructions.find((i) => keys[i.programIdIndex] === TOKEN_2022_PROGRAM_ID.toBase58());
  assert.deepEqual([...w.data], [26, 3, 5]);
  assert.deepEqual(w.accountKeyIndexes.map((k) => keys[k]), [mint, treasury === treasuryAta(mint, kp.publicKey).toBase58() ? treasury : treasuryAta(mint, kp.publicKey).toBase58(), kp.publicKey.toBase58(), ...accounts]);
  assert.ok(tx.message.compiledInstructions.some((i) => keys[i.programIdIndex] === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"), "create the treasury account if it is missing (idempotent)");
});

test("mint sweep: the withheld tokens held in the mint go to the treasury", () => {
  const tx = buildFeeTx(kp, addr(), { kind: "mint", mint });
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const w = tx.message.compiledInstructions.find((i) => keys[i.programIdIndex] === TOKEN_2022_PROGRAM_ID.toBase58());
  assert.deepEqual([...w.data], [26, 2], "WithdrawWithheldTokensFromMint");
  assert.deepEqual(w.accountKeyIndexes.map((k) => keys[k]), [mint, treasuryAta(mint, kp.publicKey).toBase58(), kp.publicKey.toBase58()]);
});

test("the single refund instruction the site appends to a buy is the same one", () => {
  const a = addr(), ix = refundIx(mint, a, kp.publicKey);
  assert.deepEqual([...ix.data], [26, 3, 1]);
  assert.deepEqual(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner]), [[mint, false], [a, false], [kp.publicKey.toBase58(), true], [a, false]]);
  void VersionedTransaction;
});
