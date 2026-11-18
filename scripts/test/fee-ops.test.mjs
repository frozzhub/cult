// What a claim put in the wallet is read from the transaction, and the surplus step is the SDK's partner share.
import { test } from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";
import { Keypair } from "@solana/web3.js";
import { grossGain, partnerSurplus } from "../fee-ops.mjs";

const wallet = Keypair.generate().publicKey, other = Keypair.generate().publicKey;
// A transaction as getTransaction returns it: account keys, balances, a fee.
const fakeConn = (keys, pre, post, fee, seen = []) => ({
  getTransaction: async (sig, opts) => {
    seen.push(opts);
    if (sig === "missing") return null;
    return { transaction: { message: { getAccountKeys: () => ({ keySegments: () => [keys] }) } }, meta: { preBalances: pre, postBalances: post, fee, loadedAddresses: undefined } };
  },
});

test("gross gain adds back the fee when the wallet paid it", async () => {
  const seen = [];
  // The wallet paid a 65,300 fee and the claim put 39,535 in: net -25,765.
  assert.equal(await grossGain(fakeConn([wallet, other], [1_000_000, 5], [974_235, 5], 65_300, seen), "s", wallet), 39_535n);
  assert.equal(seen[0].maxSupportedTransactionVersion, 1);
});

test("gross gain is 0 when the transaction paid nothing and the fee is the only change", async () => {
  assert.equal(await grossGain(fakeConn([wallet], [1_000_000], [934_700], 65_300), "s", wallet), 0n);
});

test("gross gain does not add the fee when someone else paid it", async () => {
  assert.equal(await grossGain(fakeConn([other, wallet], [9, 100], [9, 150], 5_000), "s", wallet), 50n);
});

test("gross gain is null when the transaction is not visible or the wallet is not in it", async () => {
  assert.equal(await grossGain(fakeConn([wallet], [1], [1], 0), "missing", wallet), null);
  assert.equal(await grossGain(fakeConn([other], [1], [1], 0), "s", wallet), null);
});

const surplusG = ({ complete = true, partner = "0", withdrawn = false } = {}) => ({
  cs: { complete }, pool: { address: "pool" },
  client: { state: { getPoolSurplus: async () => ({ partner: new BN(partner), partnerWithdrawn: withdrawn }) } },
});

test("the partner surplus is the SDK's partner share, 0 before the curve is complete and once withdrawn", async () => {
  assert.equal(await partnerSurplus(surplusG({ partner: "1234" })), 1234n);
  assert.equal(await partnerSurplus(surplusG({ complete: false, partner: "1234" })), 0n);
  assert.equal(await partnerSurplus(surplusG({ partner: "1234", withdrawn: true })), 0n);
  assert.equal(await partnerSurplus(surplusG({ partner: "0" })), 0n);
});
