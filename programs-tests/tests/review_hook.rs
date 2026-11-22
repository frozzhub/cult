//! Money review 2026-11-16. `review_*` tests reproduce findings; they failed
//! on the programs and launch steps as reviewed and pass on the fixed ones. The shared launch is in
//! common/mod.rs (it now ends the way scripts/launch.mjs does: both authorities revoked, payout funded).
mod common;
use common::*;
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;
use spl_token_2022_interface::{
    extension::{transfer_hook, ExtensionType},
    instruction as tok,
    state::Account as TokenAccount,
    ID as TOKEN_2022,
};

fn other_pool() -> Address { Address::find_program_address(&[b"pool"], &addr("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8")).0 }

// B1 (lead 2). The creator used to keep the transfer-hook authority: it could remove the hook (any DEX pool
// then works, no 15%) or point it at a program that refuses sells (honeypot). launch.mjs now revokes it in the
// launch transaction, so the creator's UpdateTransferHook is refused.
#[test]
fn review_creator_cannot_switch_off_the_hook_after_launch() {
    let mut w = launch(Opts::default());
    let buyer = Keypair::new();
    w.svm.airdrop(&buyer.pubkey(), 10 * SOL).unwrap();
    w.trade(&buyer, true, SOL, 1).expect("buy");
    let creator = w.creator.insecure_clone();
    let off = transfer_hook::instruction::update(&TOKEN_2022, &w.mint, &creator.pubkey(), &[], None).unwrap();
    let switched_off = w.send(&[off], &[&creator]).is_ok();
    let to = other_pool();
    let b = buyer.pubkey();
    let into_other_pool = switched_off && {
        let ix = w.transfer_ix(&b, &ata(&to, &w.mint), 1_000_000);
        let create = create_ata(&b, &to, &w.mint);
        w.send(&[create, ix], &[&buyer]).is_ok()
    };
    assert!(!switched_off, "the creator removed the transfer hook after launch; another pool's vault then took $CULT: {into_other_pool}");
    // And pointing the hook at some other program is refused too.
    let repoint = transfer_hook::instruction::update(&TOKEN_2022, &w.mint, &creator.pubkey(), &[], Some(other_pool())).unwrap();
    assert!(w.send(&[repoint], &[&creator]).is_err(), "the creator repointed the hook after launch");
}

// A1 (lead 3). The hook only checked the destination's owner at transfer time. A plain (non-ATA) Token-2022
// account has no ImmutableOwner, so after $CULT landed in it its owner could be handed to anyone, an escrow
// program included, with no transfer and no hook call. The hook now refuses such destinations.
#[test]
fn review_cult_refused_into_accounts_whose_owner_can_change() {
    let mut w = launch(Opts::default());
    let holder = Keypair::new();
    let h = holder.pubkey();
    w.svm.airdrop(&h, 10 * SOL).unwrap();
    w.trade(&holder, true, SOL, 1).expect("buy");
    let acct = Keypair::new();
    let len = ExtensionType::try_calculate_account_len::<TokenAccount>(&[ExtensionType::TransferHookAccount]).unwrap();
    let rent = w.svm.minimum_balance_for_rent_exemption(len);
    w.send(&[
        solana_system_interface::instruction::create_account(&h, &acct.pubkey(), rent, len as u64, &TOKEN_2022),
        tok::initialize_account3(&TOKEN_2022, &acct.pubkey(), &w.mint, &h).unwrap(),
    ], &[&holder, &acct]).expect("open a plain token account");
    let r = w.send(&[w.transfer_ix(&h, &acct.pubkey(), 1_000_000)], &[&holder]);
    let moved_in = r.is_ok();
    let escrow = Address::find_program_address(&[b"escrow"], &addr(ATA_PROGRAM)).0; // any off-curve program address
    let handed_over = moved_in
        && w.send(&[tok::set_authority(&TOKEN_2022, &acct.pubkey(), Some(&escrow), tok::AuthorityType::AccountOwner, &h, &[]).unwrap()], &[&holder]).is_ok();
    assert!(!moved_in, "the hook let $CULT into an account without ImmutableOwner; its owner then moved to an off-curve escrow with no transfer: {handed_over}");
    assert_eq!(custom_code(&r.unwrap_err()), Some(ERR_OTHER_POOL), "refused by the hook, not by something else");
    // The same holder's own associated account (ImmutableOwner) still works.
    let friend = Keypair::new();
    w.transfer(&holder, &friend.pubkey(), 1_000_000).expect("to an associated account");
}

// L2 (lead 4). The pool credits the fee straight to the payout wallet. While that wallet holds 0 SOL, any sell whose
// fee is under the rent-exempt minimum (~0.00089 SOL, so sells under ~0.006 SOL) fails with InsufficientFundsForRent.
// This is not fixable in the pool (a fee has to land somewhere); it is fixed by funding the payout wallet before the
// pool exists, which launch.mjs now enforces (it refuses to start under 0.06 SOL). The original test launched with an
// unfunded payout wallet, which launch.mjs can no longer do, so it now launches the way the script does and a second
// test records why the gate exists.
fn tiny_sell(w: &mut World) -> Result<(), String> {
    let buyer = Keypair::new();
    w.svm.airdrop(&buyer.pubkey(), 10 * SOL).unwrap();
    w.trade(&buyer, true, SOL, 1).expect("buy");
    let (tok_res, sol_res) = (w.tokens(&w.pool), w.sol_reserve());
    let tokens_in = (2_000_000u128 * tok_res as u128 / sol_res as u128) as u64; // about 0.002 SOL gross
    w.trade(&buyer, false, tokens_in, 1)
}

#[test]
fn review_small_sell_works_once_the_payout_wallet_is_funded_as_the_script_requires() {
    let mut w = launch(Opts { payout_sol: PAYOUT_MIN, ..Opts::default() });
    let r = tiny_sell(&mut w);
    assert!(r.is_ok(), "a ~0.002 SOL sell fails although the payout wallet holds 0.06 SOL: {r:?}");
}

#[test]
fn review_small_sell_fails_while_the_payout_wallet_holds_nothing() {
    let mut w = launch(Opts { payout_sol: 0, ..Opts::default() });
    assert!(tiny_sell(&mut w).is_err(), "expected the rent check to refuse a fee under the rent-exempt minimum");
}

// Pool soundness over a few random trades (property.rs does thousands): lamports are always rent plus the real SOL,
// x*y never shrinks, and the payout wallet gets exactly the sum of 15% fees.
#[test]
fn review_pool_books_balance_over_many_trades() {
    let mut w = launch(Opts::default());
    let rent = w.pool_rent();
    let v = w.virtual_sol();
    let traders: Vec<Keypair> = (0..4).map(|_| Keypair::new()).collect();
    for t in &traders { w.svm.airdrop(&t.pubkey(), 200 * SOL).unwrap(); }
    let payout0 = w.lamports(&w.payout.pubkey());
    let (mut seed, mut fees, mut trades) = (42u64, 0u64, 0);
    let mut k = w.sol_reserve() as u128 * w.tokens(&w.pool) as u128;
    for _ in 0..80 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let t = traders[(seed >> 33) as usize % 4].insecure_clone();
        let have = w.tokens(&t.pubkey());
        let (tok_res, sol_res) = (w.tokens(&w.pool), w.sol_reserve());
        if (seed >> 20) & 1 == 0 || have == 0 {
            let sol_in = 1 + (seed >> 40) % (8 * SOL);
            w.trade(&t, true, sol_in, 1).expect("buy");
        } else {
            let tokens_in = have / 2 + 1;
            let gross = quote(tokens_in, tok_res, sol_res);
            w.trade(&t, false, tokens_in, 1).expect("sell");
            fees += fee_of(gross, 1500);
        }
        trades += 1;
        assert_eq!(w.lamports(&w.pool), rent + w.sol_reserve() - v, "pool lamports = rent + real SOL");
        let k2 = w.sol_reserve() as u128 * w.tokens(&w.pool) as u128;
        assert!(k2 >= k, "x*y shrank");
        k = k2;
    }
    assert_eq!(trades, 80);
    assert_eq!(w.lamports(&w.payout.pubkey()) - payout0, fees, "payout got exactly the fees");
}
