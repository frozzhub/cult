# Custom pool indexing: how fast do big platforms pick up a new venue?

Date: 2026-11-16. Status: PARTIAL. Search tooling returned mostly secondary sources; most first-visibility dates are NOT confirmed. Nothing below is guessed; gaps are marked UNVERIFIED.

## Question
CULT trades only on our own constant-product pool program (15% sell fee, 0% buy). How and how fast did custom-venue coins/launchpads become visible and tradable on DexScreener, GMGN, Axiom, Photon, BullX, Padre, Birdeye and Jupiter (Phantom swap)?

## Method
Web search (standard + extended) and fetches of official docs. CONFIRMED = official or reputable source cited. UNVERIFIED = no primary source found.

## Cases
| Venue | Program launch | Platform visibility | Traction | How | Status |
|---|---|---|---|---|---|
| pump.fun curve | Jan 2024 (secondary sources only) | Birdeye lists "Pump.fun" as covered. One 2026 blog says DexScreener does not show pre-graduation coins (post-graduation pairs only). First-chart dates on any platform: not found | n/a | Platform-side indexing; no application process found | UNVERIFIED dates |
| PumpSwap (pump AMM) | 20 Mar 2025 (The Block, 2025-03-20; others say 21 Mar) | Birdeye lists "Pump AMM". Jupiter routing "as of mid-2025" (blog). Blog anecdote: a graduated token shows on Birdeye/DexScreener 5 min to 2 h after pool creation | n/a | Not documented | Launch CONFIRMED; rest UNVERIFIED |
| Moonshot (DexScreener's own) | 24 Jun 2024 (DexScreener post; The Block 25 Jun) | DexScreener: native, day one (their own product). Birdeye lists "Moonshot" | 7,000 coins in about a week (Decrypt) | Built by the platform | CONFIRMED launch; contrast case |
| Boop.fun | 2025 (Jupiter-backed) | One dated article: "instantly tradable on Jupiter" at launch | n/a | Jupiter-affiliated | Weak source |
| Heaven (own AMM + launchpad) | AMM audited by Certora Jun 2025; large by Aug 2025 | Birdeye lists "Heaven". DexScreener tracked Heaven tokens (founder anecdote of indexing glitches). Jupiter: CoinRank flagged "liquidity island" risk; no confirmation found | $308M volume, 35K tokens, 108K wallets by Aug 2025 (Dune) | Closest analogue to CULT: custom AMM. Indexed once volume was large | Jupiter/Axiom/Photon UNVERIFIED |
| daos.fun | 2024-25 | Birdeye lists "Daosfun" | n/a | Platform-side | Dates UNVERIFIED |
| Dexlab (custom AMM) | n/a | Jupiter integrated it into routing, reported 1 Apr 2024 (FXStreet) | n/a | Jupiter AMM integration | Secondary source |
| LetsBonk (Raydium LaunchLab), Bags/Believe (Meteora DBC) | Apr 2025 / May 2025 | GMGN `--dex` list includes bonk, bags, letsbonk. Birdeye lists LaunchLab and Meteora DBC | n/a | Built on venues already indexed; contrast | Day-one claim UNVERIFIED |
| Time.fun, Jupiter Studio, single tax tokens on their own pool | not found | Searched; no case of a lone token on a bespoke pool being indexed | | | NO DATA |

Birdeye's Solana coverage list also includes Fluxbeam, Bonkswap, Vertigo, Wavebreak and about 100 others, so it adds small custom venues over time.

## Findings
1. No platform has a self-serve "add my pool program" button. Aggregators index by program ID, so a new program is invisible until someone adds a decoder.
2. DexScreener says it "automatically tracks all DEXes on supported chains and protocols, whether or not they're listed", but a new DEX needs a Discord request, judged on liquidity and volume, open-source and audited contracts, and community. Low-volume DEXes "may not be listed at all".
3. Jupiter has the only documented, formal path: Amm trait SDK, parity tests, audit, traction and team info. No published review time. Routes then need liquidity (a $500 round trip must lose under 30%, or the price-impact test passes). A 15% sell tax eats half that budget, and the quote must match on-chain output exactly in the parity kit, so the tax must be modelled in `quote`. Instant routing has a grace period based on token age.
4. Birdeye: no public request process; docs say only "constantly adding" protocols. Contact via enterprise page.
5. GMGN, Axiom, Photon, BullX, Padre: no public process found. Terminals that swap via Jupiter inherit its coverage.
6. Visibility followed first-party ownership (Moonshot), an already-supported venue (LaunchLab, DBC), or large volume (Heaven).
7. DexScreener Enhanced Token Info and boosts apply to tokens on supported DEXes only; they do not add a new DEX.

## Platform processes
- DexScreener: https://docs.dexscreener.com/dex-listing (Discord request); https://help.dexscreener.com/en/articles/1147265
- Jupiter AMM integration: https://developers.jup.ag/docs/swap/routing/dex-integration ; form https://support.jup.ag/requests/new/amm-integrators ; repo jup-ag/jupiter-amm-interface
- Jupiter market listing: https://developers.jup.ag/docs/swap/routing/market-listing
- Birdeye: https://data.birdeye.so/docs/resources/data-coverage/dex-coverage.md ; contact https://docs.birdeye.so/docs/enterprise-contact
- GMGN, Axiom, Photon, BullX, Padre: none found.

## What this means for CULT
- Jupiter first; it also feeds Phantom and the terminals that route through it. Build the Amm SDK with the 15% sell fee in `quote`, pass the test kit, submit the integrators form. Expect them to ask for an audit and traction; ask what is acceptable.
- DexScreener: Discord request with program ID, source, audit if any, a sample pool, launch-day volume.
- Birdeye: email via enterprise contact with program ID and IDL.
- GMGN, Axiom, Photon, BullX, Padre: contact via X DMs or business contacts with program ID, IDL, a pool, a sample swap tx; offer to help write the decoder.
- Always-works fallback: our own site with chart and swap.

Answer: A custom-pool coin should not expect the big players to see it on launch day. In the cases we could verify, a new venue got indexed because the platform owned it (Moonshot), because it sat on an already-supported program (LaunchLab, Meteora DBC), or because volume was large (Heaven, about $300M by Aug 2025). The only published route, Jupiter's AMM integration, needs an SDK, parity tests, an audit and traction, with no stated timeline. Realistically, plan to be invisible on terminals at launch, with DexScreener, Birdeye and Jupiter possible within days to weeks only if we approach them directly with real volume as proof. We found no dated case of a lone token on a custom pool doing faster.

## Sources
- https://docs.dexscreener.com/dex-listing
- https://developers.jup.ag/docs/swap/routing/dex-integration
- https://developers.jup.ag/docs/swap/routing/market-listing
- https://data.birdeye.so/docs/resources/data-coverage/dex-coverage.md
- https://www.theblock.co/news/business/2025-03-20-pump-fun-launches-dex-called-pumpswap-to-instantly-migrate-graduated-tokens-347360
- https://decrypt.co/236904/dexscreeners-pump-fun-competitor-moonshot-solana-meme-coins
- https://x.com/Dune/status/1959299631105634720
- https://www.coinrank.io/crypto/heaven-an-innovative-launchpad-platform-in-the-solana-ecosystem/
- https://fxstreet.com/cryptocurrencies/news/jup-up-21-in-24-hours-as-dexlab-integration-may-fuel-more-meme-coin-frenzy-202404011427
- https://www.altcoinbuzz.io/cryptocurrency-news/jupiter-launches-boop-fun-for-solana-memecoins/
