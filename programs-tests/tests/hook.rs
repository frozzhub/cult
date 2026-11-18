//! paper-hook: who may move $CULT. A program address (off the ed25519 curve) may not be the authority of a
//! transfer, except the pool PDA, which signs every buy. Off-curve addresses can't sign a transaction without
//! a program, so this test turns signature checking off in LiteSVM and puts an unsigned off-curve authority in
//! the transaction: Token-2022 then runs the transfer and calls the hook just as it would for a program's CPI.
mod common;
use common::*;
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;

/// A copy of `holder`'s associated account, owned by `owner`, at `owner`'s associated address.
fn plant_account_owned_by(w: &mut World, holder: &Address, owner: &Address) {
    let mut acct = w.svm.get_account(&ata(holder, &w.mint)).unwrap();
    acct.data[32..64].copy_from_slice(owner.as_ref()); // token account: mint 0..32, owner 32..64
    w.svm.set_account(ata(owner, &w.mint), acct).unwrap();
}

fn unsigned_transfer(w: &mut World, authority: &Address, to_owner: &Address) -> Result<(), String> {
    let payer = w.creator.pubkey();
    let ixs = [create_ata(&payer, to_owner, &w.mint), w.transfer_ix(authority, &ata(to_owner, &w.mint), 1_000_000)];
    let mut tx = Transaction::new_with_payer(&ixs, Some(&payer));
    tx.message.recent_blockhash = w.svm.latest_blockhash();
    let r = w.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?} {:?}", e.err, e.meta.logs));
    w.svm.expire_blockhash();
    r
}

#[test]
fn a_program_address_cannot_move_cult_but_an_ordinary_wallet_can() {
    let mut w = launch(Opts { sigverify: false, ..Opts::default() });
    let buyer = Keypair::new();
    w.svm.airdrop(&buyer.pubkey(), 10 * SOL).unwrap();
    w.trade(&buyer, true, SOL, 1).expect("buy");
    let friend = Keypair::new().pubkey();

    // Control: the account is owned by an ordinary wallet whose signature the test skips. The transfer goes through,
    // so the refusal below is the hook's, not a flaw in how the account was planted.
    let wallet = Keypair::new().pubkey();
    plant_account_owned_by(&mut w, &buyer.pubkey(), &wallet);
    unsigned_transfer(&mut w, &wallet, &friend).expect("an on-curve authority moves tokens");
    assert_eq!(w.tokens(&friend), 1_000_000);

    // The same account, owned by a program address (an escrow, a Squads vault, someone else's pool).
    let program_address = Address::find_program_address(&[b"escrow"], &addr(ATA_PROGRAM)).0;
    plant_account_owned_by(&mut w, &buyer.pubkey(), &program_address);
    let e = unsigned_transfer(&mut w, &program_address, &friend).unwrap_err();
    assert_eq!(custom_code(&e), Some(ERR_OTHER_POOL), "refused by the hook: {e}");
    assert_eq!(w.tokens(&friend), 1_000_000, "nothing moved");
}
