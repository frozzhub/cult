//! paper-pool + paper-hook against the real compiled programs (../target/deploy/*.so) in LiteSVM.
//! Same checks as test/programs.e2e.mjs: launch, buy (no fee), sell (15% to payout), slippage guard,
//! wallet-to-wallet transfers allowed, transfers into another program's account refused.
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_token_2022_interface::{
    extension::{transfer_hook, ExtensionType, StateWithExtensions},
    instruction as tok,
    state::{Account as TokenAccount, Mint},
    ID as TOKEN_2022,
};

const POOL: &str = "J6zYGwRTLX17ms2dDZ6yGXP21xfigBwLKvYXho2Aw9Bu";
const HOOK: &str = "794MkqjE5VxXMVX9pJFK9D6YeK9pKp59K5BkBULfnSG2";
const ATA_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM: Address = Address::new_from_array([0; 32]);
const DECIMALS: u8 = 6;
const SUPPLY: u64 = 1_000_000_000 * 1_000_000;
const SOL: u64 = 1_000_000_000;
const POOL_SOL: u64 = 20 * SOL;

fn addr(s: &str) -> Address { s.parse().unwrap() }
fn disc(name: &str) -> [u8; 8] { Sha256::digest(format!("global:{name}")).as_slice()[..8].try_into().unwrap() }
fn ata(owner: &Address, mint: &Address) -> Address {
    Address::find_program_address(&[owner.as_ref(), TOKEN_2022.as_ref(), mint.as_ref()], &addr(ATA_PROGRAM)).0
}
fn create_ata(payer: &Address, owner: &Address, mint: &Address) -> Instruction {
    Instruction {
        program_id: addr(ATA_PROGRAM),
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata(owner, mint), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
        ],
        data: vec![1], // CreateIdempotent
    }
}

struct World {
    svm: LiteSVM,
    creator: Keypair,
    payout: Keypair,
    mint: Address,
    pool: Address,
    vault: Address,
    metas: Address,
}

impl World {
    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        let tx = Transaction::new_signed_with_payer(ixs, Some(&signers[0].pubkey()), signers, self.svm.latest_blockhash());
        let r = self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?} {:?}", e.err, e.meta.logs));
        self.svm.expire_blockhash();
        r
    }
    fn lamports(&self, a: &Address) -> u64 { self.svm.get_account(a).map(|x| x.lamports).unwrap_or(0) }
    fn tokens(&self, owner: &Address) -> u64 {
        let acc = self.svm.get_account(&ata(owner, &self.mint)).expect("token account");
        StateWithExtensions::<TokenAccount>::unpack(&acc.data).unwrap().base.amount
    }
    // Pool account: 8 disc | mint | vault | payout | fee_bps u16 | sol_reserve u64 | bump
    fn sol_reserve(&self) -> u64 {
        let d = self.svm.get_account(&self.pool).unwrap().data;
        u64::from_le_bytes(d[106..114].try_into().unwrap())
    }
    fn hook_accounts(&self) -> [AccountMeta; 2] { [AccountMeta::new_readonly(addr(HOOK), false), AccountMeta::new_readonly(self.metas, false)] }

    fn trade(&mut self, user: &Keypair, buy: bool, amount: u64, min_out: u64) -> Result<(), String> {
        let mut data = disc(if buy { "buy" } else { "sell" }).to_vec();
        data.extend_from_slice(&amount.to_le_bytes());
        data.extend_from_slice(&min_out.to_le_bytes());
        let mut accounts = vec![
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new_readonly(self.mint, false),
            AccountMeta::new(self.pool, false),
            AccountMeta::new(self.vault, false),
            AccountMeta::new(ata(&user.pubkey(), &self.mint), false),
            AccountMeta::new(self.payout.pubkey(), false),
            AccountMeta::new_readonly(TOKEN_2022, false),
            AccountMeta::new_readonly(addr(ATA_PROGRAM), false),
            AccountMeta::new_readonly(SYSTEM, false),
        ];
        accounts.extend(self.hook_accounts());
        self.send(&[Instruction { program_id: addr(POOL), accounts, data }], &[user])
    }

    fn transfer(&mut self, from: &Keypair, to_owner: &Address, amount: u64) -> Result<(), String> {
        let mut ix = tok::transfer_checked(&TOKEN_2022, &ata(&from.pubkey(), &self.mint), &self.mint, &ata(to_owner, &self.mint), &from.pubkey(), &[], amount, DECIMALS).unwrap();
        ix.accounts.extend([AccountMeta::new_readonly(self.metas, false), AccountMeta::new_readonly(addr(HOOK), false)]);
        let create = create_ata(&from.pubkey(), to_owner, &self.mint);
        self.send(&[create, ix], &[from])
    }
}

/// What scripts/launch.mjs does: mint with transfer hook, hook setup, mint supply, seed pool, revoke.
fn launch() -> World {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(addr(HOOK), "../target/deploy/paper_hook.so").unwrap();
    svm.add_program_from_file(addr(POOL), "../target/deploy/paper_pool.so").unwrap();
    let creator = Keypair::new();
    let payout = Keypair::new();
    svm.airdrop(&creator.pubkey(), 100 * SOL).unwrap();
    svm.airdrop(&payout.pubkey(), SOL).unwrap();
    let mint_kp = Keypair::new();
    let mint = mint_kp.pubkey();
    let pool = Address::find_program_address(&[b"pool", mint.as_ref()], &addr(POOL)).0;
    let metas = Address::find_program_address(&[b"extra-account-metas", mint.as_ref()], &addr(HOOK)).0;
    let vault = ata(&pool, &mint);
    let mut w = World { svm, creator, payout, mint, pool, vault, metas };
    let c = w.creator.pubkey();

    let len = ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::TransferHook]).unwrap();
    let rent = w.svm.minimum_balance_for_rent_exemption(len);
    let creator = w.creator.insecure_clone();
    w.send(&[
        solana_system_interface::instruction::create_account(&c, &mint, rent, len as u64, &TOKEN_2022),
        transfer_hook::instruction::initialize(&TOKEN_2022, &mint, Some(c), Some(addr(HOOK))).unwrap(),
        tok::initialize_mint2(&TOKEN_2022, &mint, &c, None, DECIMALS).unwrap(),
    ], &[&creator, &mint_kp]).expect("mint");

    w.send(&[Instruction {
        program_id: addr(HOOK),
        accounts: vec![AccountMeta::new(c, true), AccountMeta::new(metas, false), AccountMeta::new_readonly(mint, false), AccountMeta::new_readonly(SYSTEM, false)],
        data: disc("initialize_extra_account_meta_list").to_vec(),
    }], &[&creator]).expect("hook setup");

    w.send(&[create_ata(&c, &c, &mint), tok::mint_to(&TOKEN_2022, &mint, &ata(&c, &mint), &c, &[], SUPPLY).unwrap()], &[&creator]).expect("mint supply");

    let mut data = disc("initialize").to_vec();
    data.extend_from_slice(&1500u16.to_le_bytes());
    data.extend_from_slice(&SUPPLY.to_le_bytes());
    data.extend_from_slice(&POOL_SOL.to_le_bytes());
    let mut accounts = vec![
        AccountMeta::new(c, true),
        AccountMeta::new_readonly(mint, false),
        AccountMeta::new(pool, false),
        AccountMeta::new(vault, false),
        AccountMeta::new(ata(&c, &mint), false),
        AccountMeta::new_readonly(w.payout.pubkey(), false),
        AccountMeta::new_readonly(TOKEN_2022, false),
        AccountMeta::new_readonly(addr(ATA_PROGRAM), false),
        AccountMeta::new_readonly(SYSTEM, false),
    ];
    accounts.extend(w.hook_accounts());
    w.send(&[Instruction { program_id: addr(POOL), accounts, data }], &[&creator]).expect("pool init");

    w.send(&[tok::set_authority(&TOKEN_2022, &mint, None, tok::AuthorityType::MintTokens, &c, &[]).unwrap()], &[&creator]).expect("revoke");
    w
}

fn quote(amount_in: u64, reserve_in: u64, reserve_out: u64) -> u64 {
    (amount_in as u128 * reserve_out as u128 / (reserve_in as u128 + amount_in as u128)) as u64
}

#[test]
fn launch_puts_everything_in_the_pool_and_revokes_minting() {
    let w = launch();
    assert_eq!(w.tokens(&w.pool), SUPPLY);
    assert_eq!(w.sol_reserve(), POOL_SOL);
    let m = w.svm.get_account(&w.mint).unwrap();
    assert!(StateWithExtensions::<Mint>::unpack(&m.data).unwrap().base.mint_authority.is_none());
    assert_eq!(Mint::LEN, 82); // sanity: Pack is the classic layout
}

#[test]
fn buy_has_no_fee_and_sell_pays_15_percent_to_payout() {
    let mut w = launch();
    let buyer = Keypair::new();
    w.svm.airdrop(&buyer.pubkey(), 50 * SOL).unwrap();

    // Buy 2 SOL worth
    let payout0 = w.lamports(&w.payout.pubkey());
    let expect = quote(2 * SOL, POOL_SOL, SUPPLY);
    w.trade(&buyer, true, 2 * SOL, expect).expect("buy");
    assert_eq!(w.tokens(&buyer.pubkey()), expect);
    assert_eq!(w.lamports(&w.payout.pubkey()), payout0, "buys pay no fee");
    assert_eq!(w.sol_reserve(), POOL_SOL + 2 * SOL);

    // Sell half
    let half = expect / 2;
    let (tok_res, sol_res) = (w.tokens(&w.pool), w.sol_reserve());
    let gross = quote(half, tok_res, sol_res);
    let fee = gross * 1500 / 10_000;
    let user0 = w.lamports(&buyer.pubkey());
    w.trade(&buyer, false, half, gross - fee).expect("sell");
    assert_eq!(w.lamports(&w.payout.pubkey()) - payout0, fee, "15% of the SOL goes to the payout wallet");
    assert_eq!(w.lamports(&buyer.pubkey()) - user0 + 5_000, gross - fee, "seller gets the rest (minus the 5000 lamport tx fee)");
    assert_eq!(w.sol_reserve(), sol_res - gross);
    assert_eq!(w.tokens(&buyer.pubkey()), expect - half);
}

#[test]
fn slippage_guard_refuses_a_bad_price() {
    let mut w = launch();
    let buyer = Keypair::new();
    w.svm.airdrop(&buyer.pubkey(), 10 * SOL).unwrap();
    let expect = quote(SOL, POOL_SOL, SUPPLY);
    let err = w.trade(&buyer, true, SOL, expect + 1).unwrap_err();
    assert!(err.contains("Custom(6002)"), "{err}"); // PoolError::Slippage
}

#[test]
fn hook_allows_wallets_and_refuses_other_pools() {
    let mut w = launch();
    let buyer = Keypair::new();
    let friend = Keypair::new();
    w.svm.airdrop(&buyer.pubkey(), 10 * SOL).unwrap();
    w.trade(&buyer, true, SOL, 1).expect("buy");

    w.transfer(&buyer, &friend.pubkey(), 1_000_000).expect("wallet to wallet");
    assert_eq!(w.tokens(&friend.pubkey()), 1_000_000);

    // A vault owned by some other program's address (e.g. a Raydium pool authority) is off-curve.
    let other_pool = Address::find_program_address(&[b"pool"], &addr("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8")).0;
    let err = w.transfer(&buyer, &other_pool, 1_000_000).unwrap_err();
    assert!(err.contains("Custom(6001)"), "{err}"); // HookError::OtherPool
}
