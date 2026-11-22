//! paper-pool + paper-hook against the real compiled programs (../target/deploy/*.so) in LiteSVM.
//! Launch (virtual seed, authorities revoked), buy (fee 0 and 100 bps), sell (15% to payout), the sell guard,
//! refusals at initialize, slippage, wallet-to-wallet transfers allowed, transfers into another program's
//! account refused. The shared launch lives in common/mod.rs.
mod common;
use common::*;
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn launch_puts_every_token_in_the_pool_with_zero_real_sol_and_revokes_both_authorities() {
    let w = launch(Opts::default());
    assert_eq!(w.tokens(&w.pool), SUPPLY);
    assert_eq!(w.sol_reserve(), 30 * SOL, "curve starts at the virtual seed");
    assert_eq!(w.virtual_sol(), 30 * SOL);
    assert_eq!(w.fee_bps(), 1500);
    assert_eq!(w.buy_fee_bps(), 0);
    assert_eq!(w.real_sol(), 0, "no SOL goes in at launch");
    assert_eq!(w.lamports(&w.pool), w.pool_rent(), "the pool holds only its rent");
    assert_eq!(w.mint_state(), (None, None), "mint authority and transfer-hook authority are both gone");
    assert_eq!(w.tokens(&w.creator.pubkey()), 0, "the creator keeps nothing");
}

#[test]
fn pool_layout_keeps_the_first_offsets_and_appends_the_new_fields() {
    let w = launch(Opts { buy_fee_bps: 250, virtual_sol: 12_345_678_901, fee_bps: 1234, ..Opts::default() });
    let d = w.pool_data();
    assert_eq!(d.len(), POOL_LEN);
    assert_eq!(&d[8..40], w.mint.as_ref());
    assert_eq!(&d[40..72], w.vault.as_ref());
    assert_eq!(&d[72..104], w.payout.pubkey().as_ref());
    assert_eq!(u16::from_le_bytes(d[104..106].try_into().unwrap()), 1234);
    assert_eq!(u64::from_le_bytes(d[106..114].try_into().unwrap()), 12_345_678_901);
    assert_eq!(d[114], Address::find_program_address(&[b"pool", w.mint.as_ref()], &addr(POOL)).1);
    assert_eq!(u64::from_le_bytes(d[115..123].try_into().unwrap()), 12_345_678_901);
    assert_eq!(u16::from_le_bytes(d[123..125].try_into().unwrap()), 250);
}

#[test]
fn initialize_refuses_bad_settings() {
    let e = try_launch(Opts { fee_bps: 2001, ..Opts::default() }).err().expect("sell fee over 20%");
    assert_eq!(custom_code(&e), Some(ERR_FEE_TOO_HIGH), "{e}");
    let e = try_launch(Opts { buy_fee_bps: 501, ..Opts::default() }).err().expect("buy fee over 5%");
    assert_eq!(custom_code(&e), Some(ERR_BUY_FEE_TOO_HIGH), "{e}");
    let e = try_launch(Opts { virtual_sol: 0, ..Opts::default() }).err().expect("no virtual SOL");
    assert_eq!(custom_code(&e), Some(ERR_ZERO), "{e}");
    // The limits themselves are allowed.
    assert!(try_launch(Opts { fee_bps: 2000, buy_fee_bps: 500, ..Opts::default() }).is_ok());
}

#[test]
fn buy_has_no_fee_by_default_and_sell_pays_15_percent_to_payout() {
    let mut w = launch(Opts::default());
    let v = 30 * SOL;
    let buyer = Keypair::new();
    w.svm.airdrop(&buyer.pubkey(), 50 * SOL).unwrap();

    let payout0 = w.lamports(&w.payout.pubkey());
    let expect = quote(2 * SOL, v, SUPPLY);
    w.trade(&buyer, true, 2 * SOL, expect).expect("buy");
    assert_eq!(w.tokens(&buyer.pubkey()), expect);
    assert_eq!(w.lamports(&w.payout.pubkey()), payout0, "buys pay no fee");
    assert_eq!(w.sol_reserve(), v + 2 * SOL);
    assert_eq!(w.real_sol(), 2 * SOL);

    let half = expect / 2;
    let (tok_res, sol_res) = (w.tokens(&w.pool), w.sol_reserve());
    let gross = quote(half, tok_res, sol_res);
    let fee = fee_of(gross, 1500);
    let user0 = w.lamports(&buyer.pubkey());
    w.trade(&buyer, false, half, gross - fee).expect("sell");
    assert_eq!(w.lamports(&w.payout.pubkey()) - payout0, fee, "15% of the SOL goes to the payout wallet");
    assert_eq!(w.lamports(&buyer.pubkey()) - user0 + 5_000, gross - fee, "seller gets the rest (minus the 5000 lamport tx fee)");
    assert_eq!(w.sol_reserve(), sol_res - gross);
    assert_eq!(w.real_sol(), w.sol_reserve() - v);
    assert_eq!(w.tokens(&buyer.pubkey()), expect - half);
}

#[test]
fn buy_fee_goes_to_payout_and_only_the_rest_is_priced() {
    let mut w = launch(Opts { buy_fee_bps: 100, ..Opts::default() });
    let v = 30 * SOL;
    let buyer = Keypair::new();
    w.svm.airdrop(&buyer.pubkey(), 50 * SOL).unwrap();
    let payout0 = w.lamports(&w.payout.pubkey());
    let sol_in = 2 * SOL + 7; // not a round number, so the floor matters
    let fee = fee_of(sol_in, 100);
    let net = sol_in - fee;
    let expect = quote(net, v, SUPPLY);

    // The quote is on the net amount: asking for what a fee-free buy would give is refused.
    let e = w.trade(&buyer, true, sol_in, quote(sol_in, v, SUPPLY)).unwrap_err();
    assert_eq!(custom_code(&e), Some(ERR_SLIPPAGE), "{e}");
    let user0 = w.lamports(&buyer.pubkey());
    w.trade(&buyer, true, sol_in, expect).expect("buy");

    assert_eq!(w.tokens(&buyer.pubkey()), expect);
    assert_eq!(w.lamports(&w.payout.pubkey()) - payout0, fee, "the payout wallet gets exactly the fee");
    assert_eq!(w.sol_reserve(), v + net, "the pool books only the net amount");
    assert_eq!(w.real_sol(), net);
    let ata_rent = w.svm.minimum_balance_for_rent_exemption(w.svm.get_account(&ata(&buyer.pubkey(), &w.mint)).unwrap().data.len());
    assert_eq!(user0 - w.lamports(&buyer.pubkey()), sol_in + ata_rent + 5_000, "buyer paid the buy, the new token account's rent and the tx fee");
}

#[test]
fn slippage_guard_refuses_a_bad_price() {
    let mut w = launch(Opts::default());
    let buyer = Keypair::new();
    w.svm.airdrop(&buyer.pubkey(), 10 * SOL).unwrap();
    let expect = quote(SOL, 30 * SOL, SUPPLY);
    let err = w.trade(&buyer, true, SOL, expect + 1).unwrap_err();
    assert_eq!(custom_code(&err), Some(ERR_SLIPPAGE), "{err}");
    assert_eq!(w.tokens(&buyer.pubkey()), 0);
    assert_eq!(w.real_sol(), 0, "a refused buy moves nothing");
}

#[test]
fn sell_refuses_when_the_pool_is_short_of_real_sol() {
    // Honest use never gets here (property.rs); this breaks the invariant by hand to prove the guard works.
    let mut w = launch(Opts::default());
    let buyer = Keypair::new();
    w.svm.airdrop(&buyer.pubkey(), 50 * SOL).unwrap();
    w.trade(&buyer, true, 2 * SOL, 1).expect("buy");
    let held = w.tokens(&buyer.pubkey());
    let gross = quote(held, w.tokens(&w.pool), w.sol_reserve());
    assert!(gross > 0 && gross <= w.real_sol());

    // Take 1 lamport more than the pool can spare below `gross`.
    let mut acct = w.svm.get_account(&w.pool).unwrap();
    acct.lamports = w.pool_rent() + gross - 1;
    w.svm.set_account(w.pool, acct).unwrap();
    let e = w.trade(&buyer, false, held, 1).unwrap_err();
    assert_eq!(custom_code(&e), Some(ERR_POOL_SHORT), "{e}");
    assert_eq!(w.tokens(&buyer.pubkey()), held, "nothing moved");

    // One lamport back and the same sell goes through, down to exactly the rent.
    let mut acct = w.svm.get_account(&w.pool).unwrap();
    acct.lamports = w.pool_rent() + gross;
    w.svm.set_account(w.pool, acct).unwrap();
    w.trade(&buyer, false, held, 1).expect("sell at the limit");
    assert_eq!(w.lamports(&w.pool), w.pool_rent(), "the pool keeps its rent");
}

#[test]
fn team_buy_in_the_launch_transaction_pays_the_price_of_the_virtual_seed() {
    let w = launch(Opts { team_buy: 2 * SOL, ..Opts::default() });
    let c = w.creator.pubkey();
    let expect = quote(2 * SOL, 30 * SOL, SUPPLY);
    assert_eq!(w.tokens(&c), expect, "no one could buy before the team did");
    assert_eq!(w.tokens(&w.pool), SUPPLY - expect);
    assert_eq!(w.real_sol(), 2 * SOL);
    assert_eq!(w.mint_state(), (None, None));
}

#[test]
fn hook_allows_wallets_and_refuses_other_pools() {
    let mut w = launch(Opts::default());
    let buyer = Keypair::new();
    let friend = Keypair::new();
    w.svm.airdrop(&buyer.pubkey(), 10 * SOL).unwrap();
    w.trade(&buyer, true, SOL, 1).expect("buy");

    w.transfer(&buyer, &friend.pubkey(), 1_000_000).expect("wallet to wallet");
    assert_eq!(w.tokens(&friend.pubkey()), 1_000_000);

    // A vault owned by some other program's address (e.g. a Raydium pool authority) is off-curve.
    let other_pool = Address::find_program_address(&[b"pool"], &addr("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8")).0;
    let err = w.transfer(&buyer, &other_pool, 1_000_000).unwrap_err();
    assert_eq!(custom_code(&err), Some(ERR_OTHER_POOL), "{err}");
}

#[test]
fn trades_and_the_launch_fit_their_compute_limits() {
    // The Worker asks for 200,000 units on a buy or sell (src/trade.js); a launch transaction may ask for 1,400,000.
    let mut w = launch(Opts { buy_fee_bps: 100, team_buy: SOL, ..Opts::default() });
    let launch_cu = w.last_cu;
    let buyer = Keypair::new();
    w.svm.airdrop(&buyer.pubkey(), 50 * SOL).unwrap();
    w.trade(&buyer, true, SOL, 1).expect("buy into a new token account");
    let first_buy = w.last_cu;
    w.trade(&buyer, true, SOL, 1).expect("buy again");
    let second_buy = w.last_cu;
    let half = w.tokens(&buyer.pubkey()) / 2;
    w.trade(&buyer, false, half, 1).expect("sell");
    let sell = w.last_cu;
    eprintln!("compute units: launch tx {launch_cu}, first buy {first_buy}, later buy {second_buy}, sell {sell}");
    assert!(launch_cu < 400_000, "launch tx used {launch_cu}");
    for (name, cu) in [("first buy", first_buy), ("later buy", second_buy), ("sell", sell)] {
        assert!(cu < 150_000, "{name} used {cu} units; the Worker's limit is 200,000");
    }
}
