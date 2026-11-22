<p align="center"><img src="public/logo.png" width="96" alt="CULT"></p>

<h1 align="center">CULT ($CULT)</h1>

<p align="center"><b>Everyone's panicking. The cult is getting paid.</b><br>
<a href="https://cults.bid">cults.bid</a> · <a href="https://x.com/thecultponzi">@thecultponzi</a></p>

---

**Sellers pay 10%.** Paid to holders in USDC every 10 minutes.
**Buyers pay 0%.** The 10% held on a buy comes straight back, usually in seconds.

$CULT trades on Meteora, so it shows up on Axiom, GMGN, Jupiter and Dexscreener like any other coin. Buy wherever you like; the refund finds you.

## How it works

1. **Join.** Every trade on the pool pays a 10% fee in SOL. When you buy, the cult sends your whole 10% back to the wallet that received the $CULT, usually within seconds, with a note: *"CULT: your 10% buy fee back"*.
2. **Leave.** Selling pays 10% of the sale. That's the exit tithe, and it stays with the cult. It's taken in SOL, so it never sells $CULT into the chart.
3. **Get paid.** Every 10 minutes the tithe is swapped to USDC and split between every wallet holding at least $50 of $CULT, by balance.
4. **Stay.** Hold without selling for 7 days and your share counts 1.25×; after 30 days, 1.5×. Any sell resets it.

## The numbers, honestly

- Meteora keeps a fifth of every fee. So each sell adds about **8%** of the sale to the pot, and refunding each buy's full 10% costs the pot about **2%** of the buy.
- **The pot only comes from people leaving.** If nobody sells, nobody gets paid. Refunds are always paid before airdrops.
- **Graduation:** after about 86 SOL is raised, Meteora moves $CULT to a regular pool with the same 10% SOL fee. All of that liquidity is permanently locked; it can't be pulled.
- The pool, the treasury and team wallets are never paid.

**This is a game, not an investment.** Nothing here promises a return.

## Check it yourself

Every refund and every airdrop is a normal Solana transaction from the treasury wallet, so anyone can audit them on Solscan.

| | |
|---|---|
| Contract (mint) | *posted at launch* |
| Treasury | `CkyNmmRxRtdn4rM8NDxaEskNz6bRGd7AnzsiuKu2uHYp` |
| Pool | Meteora Dynamic Bonding Curve, then DAMM v2 after graduation |

## What's in this repo

The whole thing runs as one Cloudflare Worker with a D1 database.

| | |
|---|---|
| `public/` | The site: countdown, pot, price chart, Members, Left the cult, Payouts, profiles |
| `src/meteora.js` | Watches the pool every few seconds and refunds every buy (each refund is saved before it's sent, so no one is paid twice); claims fees; follows the coin to its new pool after graduation |
| `src/indexer.js` | The 10-minute rounds: snapshot holders, swap to USDC on Jupiter, split, pay in batches |
| `src/meteora-trade.js` | The site's own Buy/Sell (via Jupiter, or the pool directly) |
| `src/profiles.js` | Sign in with your wallet and link your X |
| `scripts/launch-meteora.mjs` | Creates the coin on Meteora with the 10% fee |
| `test/` | 48 tests, including real devnet transactions |

```
npm install
npm test        # 48 tests
npm run dev     # the site locally
```

The full build history (including the original custom-pool version) is in [docs/BUILD-LOG.md](docs/BUILD-LOG.md).
