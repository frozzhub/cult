# How CULT works

This document explains the mechanism end to end: the token, a buy, a sell, a payout round, graduation, and what happens when something fails. It is written for developers and for holders who want to check the claims. Every statement was checked against the code in `src/`; file names are given so you can read the source. A shorter, reference-style version for agents is in [AGENTS.md](../AGENTS.md).

Site: https://cults.bid. X: @thecultponzi. The mint address is published on cults.bid at launch.

## 1. The idea in one paragraph

CULT has a 10% fee on every transfer, set in the token itself. In practice only sells pay it, because the project returns the fee to anyone who receives tokens in an ordinary wallet. The fee collected from sells is turned into USDC and paid to holders every 10 minutes. The curve is paired with USDC, so its trading fees arrive as USDC and go into the same pot. Holders who have held longer without selling get a bigger share.

## 2. The token

CULT is a Token-2022 mint. It uses the `TransferFee` extension, which is how the 10% is applied:

- On every transfer, the token program takes 10% of the amount (rounded up) and does not deliver it to the recipient. It adds it to a `withheld` counter on the recipient's token account.
- Withheld tokens are not spendable by anyone at that moment. They stay in that account's `withheld` field until the mint's withdraw-withheld authority collects them. Only that one authority can collect them into an account of its choice. (Anyone can instead move them, permissionlessly, from an account into the mint's own withheld pool. The authority can then collect them from there.)
- The mint has no mint authority and no freeze authority. The Worker refuses to run if either exists (`payoutProblem` in `src/indexer.js`).
- The withdraw-withheld authority is the payout wallet. The Worker refuses to run if it is not (`payoutProblem`, and again inside `fees.runFees`).

The fee applies to every transfer, not only to trades. The token program does not know what a "buy" or a "sell" is. It sees a transfer into some account. This is the whole difficulty, and section 3 is the answer.

On the rate: the launch scripts create the mint with a 10% fee and no fee-config authority, and `scripts/verify-launch.mjs` fails if the mint has one. The Worker does not check that field itself. If you want to confirm that the rate cannot change, read the mint with `getAccountInfo` (`jsonParsed`) and look at `transferFeeConfig.transferFeeConfigAuthority`. It should be null. Also look at `olderTransferFee` and `newerTransferFee`: both should say 1000 basis points.

## 3. Why a sell-only tax needs the buy hold

Token-2022 charges the fee on the receiving side of every transfer, whoever the receiver is. Consider the two directions of a trade with a pool:

- Sell: the seller's tokens move into the pool's vault. The vault is the recipient, so the 10% is withheld on the vault's account.
- Buy: the pool's vault sends tokens to the buyer. The buyer is the recipient, so the 10% is withheld on the buyer's account. The buyer would receive 90% of what they paid for.

If nothing were done, buyers would pay 10% as well. The project wants only sellers to pay. So the Worker looks at where each withheld amount sits:

- If the account belongs to a program (a pool vault), the owner address is off the ed25519 curve, so no key exists for it. That is a sell. The withheld tokens are swept to the treasury. This is the tax.
- If the account belongs to a normal wallet (an address on the curve), the Worker gives the withheld amount back to that same account, as a refund. The holder ends up with the full amount.

The refund is a Token-2022 withdraw-withheld instruction whose source and destination are the same account, signed by the payout key (`refundIx` and `buildFeeTx` in `src/token22.js`). The holder signs nothing.

The "brief hold" is the gap between the buy landing and the refund landing. During it the buyer's balance shows 90% and the account carries a withheld balance. The refund is triggered in several ways, fastest first:

1. A Helius webhook calls `POST /api/hook` (`handleWebhook`). The refund runs right after the HTTP response, so it normally lands within seconds.
2. The site calls `POST /api/refund/hint` after a buy confirms (`hintSignature`). The Worker reads the transaction itself, so the browser's word is only a prompt to look.
3. The cron's history poller (`pollMint`) reads the mint's transactions every minute and queues the accounts they touched.
4. Every 30 minutes a full scan (`fees.scanWithheld`) looks for any account holding withheld tokens, however it was missed.

The site can also ask for the refund to be built into the buy transaction itself (`ATOMIC_REFUND`, off in `wrangler.jsonc`, and a per-trade option on `POST /api/trade`). That removes the gap but needs the payout key to co-sign the buyer's transaction, so it is off until a real wallet test shows wallets keep the co-signature.

Wallet-to-wallet sends are refunded in the same way, so they are free too.

### Who is not refunded

`classify` in `src/token22.js` decides, from the account's bytes read fresh from the chain. An account with withheld tokens is swept (the tax) rather than refunded when:

- its owner is on the `REFUND_DENY` list;
- it is frozen;
- its owner is off the curve (a pool vault or any program-owned account);
- it has a delegate, or a close authority (a delegate set after a refund changes nothing already refunded, but the next withheld tokens are swept);
- the withheld amount is under the dust floor (`REFUND_MIN_USD`, 0.01 USD at the cached price; a fixed raw floor is used when there is no price).

An account that is the treasury itself, or owned by the payout wallet, is left alone, so the treasury's own withheld tokens are never released or sold.

### One accepted weakness

Moving withheld tokens from an account into the mint is permissionless. Anyone can do that to a buyer's account before the refund lands. The buyer then gets nothing back for that amount, and the tokens go to the treasury at the next sweep. The code treats this as accepted behaviour (the test is named "someone harvested the buyer's withheld tokens into the mint first"). It costs the person doing it a transaction fee, and it is a way to impose a loss on a particular buyer.

## 4. The lifecycle of a buy

1. The buyer's wallet asks the site for a quote (`GET /api/quote`) and then a transaction (`POST /api/trade`). The buyer pays in SOL and Jupiter routes SOL to USDC to CULT. The site gets swap instructions from Jupiter, checks every one with `jupiter.inspect`, compiles the transaction itself, and returns it unsigned. The buyer signs and sends it from their own wallet. The Worker never holds the buyer's keys.
2. The swap moves CULT from the pool vault to the buyer. 10% is withheld on the buyer's account.
3. A refund is queued (by webhook, hint, poller or scan) and runs: the `fee_accounts` row goes `queued`, `claimed`, `sent`, `done`. The sent transaction's signature is stored in `fee_batches` before it is sent.
4. The refund lands. The buyer holds the whole amount.
5. `recordTrade` stores the buy in `trades` (once, even if the webhook and the poller both see it).

The quote's `outAfterRefund` field says what the buyer will hold after the refund.

## 5. The lifecycle of a sell

1. The seller's wallet signs a swap built the same way. CULT moves from their account into a pool vault.
2. 10% is withheld on the vault's token account. The seller receives SOL for the other 90%: Jupiter routes CULT to USDC to SOL.
3. A sweep is queued for that vault. Vaults are touched by every trade, so the cron sweeps them at most once every 5 minutes each, in batches (`fees.js`). The payout round forces a final sweep before it sells (section 6, step 2).
4. The sweep is a Token-2022 withdraw-withheld instruction listing the vault accounts as sources and the treasury token account as destination. The treasury account is opened first if it does not exist. Withheld tokens sitting in the mint itself are swept by a separate instruction.
5. `recordTrade` stores the sell in `trades` and `sells`, with the tax in tokens and in USD at the price when it was recorded. The wallet appears on the site's Wall and `sellers.last_at` is updated, which resets the wallet's holding streak.

How a sell is recognised (`readTrade` in `src/trades.js`): a wallet loses tokens and a program-owned account gains them. A buy is the reverse. The payout wallet's own sales are never counted as trades, so the treasury does not appear on the Wall.

## 6. The lifecycle of a round

A round happens every 10 minutes (`DROP_MINUTES`). The cron runs every minute and moves the current round forward step by step (`tick` in `src/indexer.js`). A round opens when the clock crosses a 10-minute boundary (`openNext`). Up to six steps run in one tick, and a round commonly spans a few ticks.

**Step 0, before anything.** The tick takes a lock in D1, refuses to run if the start-up checks fail (section 8), refreshes the prices (cached for 60 seconds), polls the mint's history, runs the refund and sweep engine, then does the curve work (section 7).

**Step 1, snapshot.** The Worker reads every holder of the coin. It prefers a live read from the RPC and falls back to its own index built from the mint's transaction history (`token_accounts`), but only if that index has caught up. It then computes a weight for each wallet:

- Skipped: the payout wallet, anything in `EXCLUDE` (empty at present), addresses with no key (pool vaults and other program accounts), and wallets whose holding is under `MIN_HOLD_USD` (50 USD at the current price).
- Weight is the token balance multiplied by a devotion multiplier. The multiplier depends on days since the later of the wallet's first appearance in a snapshot and its last sell. 7 days or more gives 1.25x. 30 days or more gives 1.5x. Otherwise 1x.

A snapshot that is empty, or that shows less than half the previous holder count, stops the round (`STEPS.snapshot`). One bad read would otherwise erase every holder's streak. The operator can override this with `ALLOW_HOLDER_DROP`.

**Step 2, sweep.** The mint is queued and the engine runs with the sweep cooldown ignored, so tax that arrived since the last cron sweep is in this round. The round waits while any sweep transaction is still in flight.

**Step 3, swap.** One leg, or two with a SOL-quoted curve, each its own transaction:

- The CULT leg sells the treasury's CULT for USDC on Jupiter. It asks for a quote, measures price impact without the coin's own 10% (Jupiter counts the tax as impact), and if the impact exceeds `MAX_SWAP_IMPACT_BPS` (3%) it re-quotes a smaller amount. The rest stays in the treasury for a later round. Amounts below 1 USD (`MIN_SWAP_USD`) are left.
- The SOL leg exists only when the curve is quoted in SOL (`QUOTE_MINT` empty). It sells any SOL above `SOL_RESERVE_LAMPORTS` (1 SOL) plus the payout transaction fees. With a USDC curve it is skipped (`STEPS.swap` in `src/indexer.js`): the curve's fees already arrive as USDC, and the wallet's SOL is a float for gas, refunds and new holders' USDC account rent. The round keeps that float topped up itself: when the wallet's SOL is below 0.3 it swaps USDC for SOL back up to 0.6, at most $50 a round and never more than half the wallet's USDC, so holders are still paid. Most of that USDC is the account rent already taken from new holders' first payouts.

Neither swap is signed until it has passed two checks in `src/jupiter.js`. First, `inspect` reads every instruction Jupiter returned: only expected programs, only the payout wallet as signer, wrapping and token-account creation only in the shapes a swap needs, no extra transfers, a priority fee under 3,000,000 lamports. Second, `outcomeProblem` simulates the final transaction and requires the output account to gain at least the quote's minimum, the input account to lose no more than the amount sold, and the wallet's SOL to fall only by fees and rent (plus the amount, when SOL is what is sold). The transaction is compiled by the Worker from the inspected instructions. It never signs a transaction Jupiter built.

**Step 4, allocate.** The pot is the whole USDC balance of the payout wallet, which includes dust that was not paid in earlier rounds. `allocate` splits it in proportion to weight. A holder without a USDC account pays the rent to open one (about 0.002 SOL, converted to USDC at the current SOL price and rounded up) out of their own share, so nobody else's share shrinks. Shares under `MIN_PAYOUT_USDC` (0.01) are dropped and stay in the wallet. Payees are sorted largest first and grouped into batches of 8.

**Step 5, paying.** Each batch becomes one transaction: for each holder, a create-token-account-if-missing instruction and a USDC `transferChecked`. The batch row is claimed (`pending` to `sent`, with its signature) by a conditional update before the send. Later ticks check the signature. Success marks it `confirmed`.

**Step 6, done.** The round's totals are stored. A round with nothing to pay is `done` with zero; one with nobody eligible is `skipped`.

### Where the money goes in numbers

For each 100 CULT a holder sells, 10 CULT are withheld, swept, sold for USDC (less swap slippage and impact) and become part of the next pot. Add the curve's trading fees, which arrive as USDC. The pot is split across all eligible holders by weight. There is no fixed percentage to any holder. A holder's payout depends on the pot, their weight and everyone else's.

## 7. Graduation

CULT launched on a Meteora Dynamic Bonding Curve quoted in USDC (`QUOTE_MINT`). The curve starts at about $1,935 market cap. When about $5,879 USDC has been raised (the config's migration threshold, about $28,400 market cap), the curve is full and the pool must move to a Meteora DAMM v2 CULT/USDC pool. The DBC config address is `<USDC DBC config, published at launch>`.

Each tick, `refreshCurve` in `src/dbc.js` reads the pool and stores its stage: `curve`, `graduating` (full, not yet migrated) or `graduated`. The site shows progress from that stored value without making an RPC call per request.

- Migration. The migration instruction is permissionless. Meteora's own keeper only handles configs on its list, and this config is not, so the Worker sends the migration itself when the stage is `graduating` (`migrate`). It builds the transaction with the SDK, checks it uses only expected programs, simulates it, saves its signature, then sends. It needs at least 0.15 SOL in the payout wallet for the new accounts, which is one reason the operator keeps a SOL float there. If someone else migrates first, the Worker's attempt fails on chain and the next read shows `graduated`. `AUTO_MIGRATE=0` leaves it to an operator.
- Liquidity. The launch configuration locks 100% of the graduated liquidity permanently, owned by the payout wallet's position. The wallet can claim the position's fees. It cannot remove the liquidity.
- Fees. Before graduation, the hourly `claimFees` moves the partner share of the curve's trading fees to the payout wallet. After graduation, `claimDammFees` claims the fees of the locked position. With a USDC curve both arrive as USDC, in the pot's own token. Claims under 0.35 USDC (0.005 SOL for a SOL curve) are skipped. Each claim is simulated and must increase the payout wallet's balance of the quote token before it is sent.
- The fee keeps working. The 10% transfer fee is a property of the token, so it applies on DAMM v2 and on any other pool. The refund and sweep rules also do not depend on which pool it is. Jupiter routes trades to whichever pool holds the coin, so the site's trading code is the same before and after graduation.

## 8. Failure handling and recovery

The design rule is: write down what will be sent before sending it, and decide what happened from the transaction's signature, never from guesswork.

### Start-up refusals

`payoutProblem` runs at the start of every tick. The tick sends nothing and says why if any of these is true:

- the mint cannot be read or is not Token-2022;
- the payout wallet is not the withdraw-withheld authority;
- the mint's fee is not `SELL_TAX_BPS`;
- the mint can still be minted or frozen;
- `CREATOR` or `DBC_CONFIG` is set and the curve pool for this mint was not made by that wallet or on that config. The DBC config is public, so anyone can launch a lookalike coin on it; the creator is what tells the real coin from a copy.

A passing result is remembered for the same settings and checked again when they change. `fees.runFees` also reads the mint on every run and blocks itself if the authority changed.

### Locks and overlapping runs

The tick holds a lock row in D1 for 15 minutes, which is Cloudflare's wall-time limit for a scheduled run. `fence()` extends it before every step and every send. A run that finds the lock taken by another run stops and writes nothing more (`LockLost`). Webhook-driven refunds can overlap with the cron, so refunds do not rely on the lock; they rely on claims.

### Claim before send

- Refund and sweep accounts: each is claimed by a conditional `UPDATE` from `queued` to `claimed`. The engine then reads the account fresh, plans, builds the transaction, and saves the batch row and moves the accounts to `sent` in one D1 transaction. If any claim was lost the batch row is not written and nothing is sent. Claims left by a dead run are released after two minutes.
- Payout batches: `pending` to `sent` with the signature, by a conditional `UPDATE`. Only the run whose update changed a row sends.
- Swaps: the signature is saved on the `drops` row (`cult_sig`, `swap_sig`) by a conditional update before the send. A second run that built its own swap sees it lost the claim and sends nothing.
- Migration and fee claims: saved under their `kv` key with state `sent` before the send. A later run only settles them.

### Deciding what happened (`chain.settleSent`)

For a transaction already sent, a later run asks the chain:

- confirmed or finalised: done;
- landed with an error: failed;
- in a block but not confirmed ("processed"): wait, never re-send;
- not seen: wait until the chain is 150 blocks past the transaction's last valid block height. Then look it up with `getTransaction`. Only if that also finds nothing is it "lost" and safe to send again. If `getTransaction` cannot answer, nothing is sent again;
- a missing last-valid-height means wait. A clock is never used.

`sendTx` sets no retry cap on the node, so the node keeps broadcasting until the blockhash expires, and optionally rebroadcasts the same signed transaction every 2 seconds until it is seen (`REBROADCAST_MS`). A signed transaction can land only once, so rebroadcasting cannot pay twice.

### Retries and give-ups

- A payout batch that fails once goes back to `pending`. After 2 failures a multi-holder batch is split into one transaction per holder, so one closed or frozen USDC account blocks only that holder. After 5 failures a batch is `failed`; its USDC stays in the wallet and is part of the next round's pot.
- A refund batch that fails whole is retried one account per transaction, uncounted. An account that fails alone 5 times is `skip`ped. The next touch an hour after it was given up revives it.
- Sweeps of vaults and of the mint are never given up on; the retry delay doubles to a ceiling of 15 minutes.
- Swap failures clear the saved signature and the leg tries again on the next tick.
- Unknown prices stop the round with a plain message. A price of zero is never stored. If Jupiter has no price for the coin yet, the curve's own price is used while it is less than 10 minutes old.
- The Helius webhook answers 503 when there is no price yet, so Helius redelivers. The refund still goes out first, and the redelivery records the trade once without a second refund.
- RPC calls try the next endpoint on a 429 or 403 and back off once all have been tried. The cron can use its own RPC key (`CRON_RPC_URL`) so site traffic cannot throttle payouts.

### Brakes and switches

- `DRY_RUN` is on unless set to `"0"`. In a practice run every step reads and plans, and nothing is signed or sent. Practice rounds are marked (`swap_sig = 'dry-run'`), kept out of every public paid figure and listed apart. `REFUNDS_DRY_RUN` lets refunds go live while payouts stay off.
- `REFUND_TX_PER_DAY` (50,000) caps refund transactions per UTC day. Sweeps are never capped, because that would stop the sell tax moving.
- Each run takes at most 300 accounts and sends at most 12 fee transactions. The sell tax is sent first so a backlog of refunds cannot hold it back.

### Manual recovery

`scripts/fee-ops.mjs` has `status`, `sweep`, `refund` and `claim` commands for use if the Worker is down. It is a dry run unless given `--go`, and a second run finds nothing left to do. `scripts/watch.mjs` reads the database and `/api/state` and prints a line for each problem.

### What recovery cannot fix

If the payout key is lost, the Worker cannot sign and nothing is refunded, swept or paid. Because the key is also the withdraw-withheld authority, the withheld tokens cannot be collected by anyone else. If the Worker is not deployed, the token's fee still applies on chain, buyers stay at 90% until a refund runs, and no payouts happen.

## 9. Trust, plainly

The code in this repository makes the project's behaviour checkable. It does not make it trustless.

On chain, and not changeable by the project after launch (as far as the launch scripts and on-chain reads show; verify them yourself):

- the 10% fee on every transfer, and (if `transferFeeConfigAuthority` is null) the rate itself;
- no new tokens and no freezing;
- the permanently locked liquidity.

Off chain, in a Worker the operator controls:

- the key. The payout key is a hot key stored as a Worker secret. It signs every refund, sweep, swap and payout. Anyone who can read or replace that secret can move everything the payout wallet holds and can change the withdraw-withheld authority. This is the central trust assumption.
- the code and settings. The operator can deploy different code, or change `EXCLUDE`, `STREAKS`, `MIN_HOLD_USD`, `DRY_RUN` and the rest. Every such change is visible only through its consequences: different payout transactions, or none.
- the weights. They are computed in D1, from snapshots and sell history, not on chain. The amounts and recipients of every payout are public on chain once paid.
- liveness. If the Worker stops, refunds and payouts stop.

No third party has audited this code. The tests in `test/` show the intended behaviour, including crash and race cases, but a passing test is not a guarantee about the deployed Worker. Section 7 of `AGENTS.md` lists the on-chain reads that let you check the live state yourself.

## 10. Other files in `docs/`

`API.md` is the HTTP contract. Where a document and the code disagree, the code is right.
