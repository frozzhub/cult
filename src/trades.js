// Reading buys and sells (and which token accounts a transaction touched) out of real transaction shapes:
//   - a standard getTransaction (encoding jsonParsed): pre/postTokenBalances
//   - a Helius "enhanced" transaction from the webhook: accountData[].tokenBalanceChanges (raw amounts)
// Both are reduced to the same list of per-account balance changes of OUR mint, then one pure rule reads the trade.
//
// The rule is the coin's own: tokens that arrive in a normal wallet are free, tokens that arrive in a program-owned
// account (any pool's vault) pay the tax. So a sell is any successful transaction where a token account owned by an
// off-curve address gains CULT while a wallet loses it; a buy is the reverse. Pool vaults are program-owned: the DBC
// pool authority, the DAMM v2 pool authority, or any other program's.
import { onCurve, feeOn } from "./token22.js";

const keyOf = (k) => (typeof k === "string" ? k : k.pubkey);

// [{ address, owner, delta: bigint }] for the mint, plus every touched account of it (even with no change).
export function rpcChanges(tx, mint) {
  if (!tx || tx.meta?.err) return null;
  const keys = (tx.transaction?.message?.accountKeys || []).map(keyOf);
  const acc = new Map(); // accountIndex -> { owner, pre, post }
  for (const [list, field] of [[tx.meta.preTokenBalances, "pre"], [tx.meta.postTokenBalances, "post"]]) {
    for (const b of list || []) {
      if (b.mint !== mint) continue;
      const e = acc.get(b.accountIndex) || { owner: b.owner, pre: 0n, post: 0n };
      e[field] = BigInt(b.uiTokenAmount?.amount || 0);
      e.owner = e.owner || b.owner;
      acc.set(b.accountIndex, e);
    }
  }
  const changes = [];
  for (const [i, e] of acc) if (keys[i] && e.owner) changes.push({ address: keys[i], owner: e.owner, delta: e.post - e.pre });
  const decimals = (tx.meta.postTokenBalances || []).concat(tx.meta.preTokenBalances || []).find((b) => b.mint === mint)?.uiTokenAmount?.decimals;
  return { sig: tx.transaction?.signatures?.[0], at: Number(tx.blockTime || 0) * 1000, slot: Number(tx.slot || 0), changes, decimals, signer: keys[0] };
}

export function enhancedChanges(tx, mint) {
  if (!tx || tx.transactionError) return null;
  const changes = [], seen = new Set(), touched = [];
  for (const a of tx.accountData || []) {
    for (const b of a.tokenBalanceChanges || []) {
      if (b.mint !== mint || !b.tokenAccount || !b.userAccount) continue;
      changes.push({ address: b.tokenAccount, owner: b.userAccount, delta: BigInt(b.rawTokenAmount?.tokenAmount || 0) });
      seen.add(b.tokenAccount);
    }
  }
  // Accounts a transfer touched without moving a balance we can see: still worth a look for withheld tokens.
  for (const t of tx.tokenTransfers || []) {
    if (t.mint !== mint) continue;
    for (const k of [t.fromTokenAccount, t.toTokenAccount]) if (k && !seen.has(k)) { seen.add(k); touched.push(k); }
  }
  return { sig: tx.signature, at: Number(tx.timestamp || 0) * 1000, slot: Number(tx.slot || 0), changes, touched, signer: tx.feePayer, decimals: undefined };
}

// Every token account of the mint this transaction touched (what the refund engine should look at).
export const touchedAccounts = (c) => (c ? [...new Set([...c.changes.map((x) => x.address), ...(c.touched || [])])] : []);

// -> { side, wallet, tokens (gross, raw), withheld (raw), net } or null. `payout`: the treasury never counts as a trader
// (its own swap would otherwise land on the Wall); `taxBps` is only used when the withheld part can't be read.
export function readTrade(c, { payout, taxBps = 1000 } = {}) {
  if (!c) return null;
  const owners = new Map();
  for (const x of c.changes) owners.set(x.owner, (owners.get(x.owner) || 0n) + x.delta);
  let program = 0n; const wallets = [];
  for (const [o, d] of owners) { if (onCurve(o)) wallets.push([o, d]); else program += d; }
  const pick = (cmp) => wallets.filter(cmp).sort((a, b) => (a[1] === b[1] ? 0 : a[1] < b[1] ? -1 : 1));
  const losers = pick(([, d]) => d < 0n), gainers = pick(([, d]) => d > 0n).reverse();
  if (program > 0n && losers.length) { // a wallet put tokens into a program-owned account
    const gross = -losers.reduce((a, [, d]) => a + d, 0n), wallet = losers[0][0];
    if (wallet === payout) return null;
    const withheld = gross > program ? gross - program : feeOn(gross, taxBps);
    return { side: "sell", wallet, tokens: gross, withheld, net: gross - withheld };
  }
  if (program < 0n && gainers.length) {
    const gross = -program, got = gainers.reduce((a, [, d]) => a + d, 0n), wallet = gainers[0][0];
    if (wallet === payout) return null;
    const withheld = gross > got ? gross - got : 0n; // 0 when the same transaction already refunded it
    return { side: "buy", wallet, tokens: gross, withheld, net: got };
  }
  return null;
}
