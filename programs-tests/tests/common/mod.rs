//! Shared LiteSVM setup for the program tests: the real compiled programs (../target/deploy/*.so) and a
//! `launch()` that does what scripts/launch.mjs does, in the same transaction grouping:
//!   tx 1: create the mint (transfer hook) + the hook's extra-account list
//!   tx 2: creator token account, mint the supply, create the pool, [team buy], revoke the mint authority,
//!         revoke the transfer-hook authority
//! Ported from the copies that used to sit in pool.rs and review_hook.rs.
#![allow(dead_code)] // each test file uses a different part
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_token_2022_interface::{
    extension::{transfer_hook, BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    instruction as tok,
    state::{Account as TokenAccount, Mint},
    ID as TOKEN_2022,
};

pub const POOL: &str = "5xsG4XWGVdazEZSDkjFWu25gCyeCnTuxuPxbmJ1xmA4D";
pub const HOOK: &str = "521AkYhN31VTGPLn75NgeWievYHZoxPwREihCCsppxnF";
pub const ATA_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
pub const SYSTEM: Address = Address::new_from_array([0; 32]);
pub const DECIMALS: u8 = 6;
pub const SUPPLY: u64 = 1_000_000_000 * 1_000_000;
pub const SOL: u64 = 1_000_000_000;
/// launch.mjs refuses to start unless the payout wallet holds this much.
pub const PAYOUT_MIN: u64 = 60_000_000;
// Pool account: 8 disc | mint 32 | vault 32 | payout 32 | fee_bps u16 @104 | sol_reserve u64 @106 | bump u8 @114
//               | virtual_sol u64 @115 | buy_fee_bps u16 @123  (125 bytes)
pub const POOL_LEN: usize = 125;
// Error codes of PoolError (programs/paper-pool).
pub const ERR_FEE_TOO_HIGH: u32 = 6000;
pub const ERR_ZERO: u32 = 6001;
pub const ERR_SLIPPAGE: u32 = 6002;
pub const ERR_BUY_FEE_TOO_HIGH: u32 = 6005;
pub const ERR_POOL_SHORT: u32 = 6006;
pub const ERR_OTHER_POOL: u32 = 6001; // HookError::OtherPool (the hook's own numbering)

pub fn addr(s: &str) -> Address { s.parse().unwrap() }
pub fn disc(name: &str) -> [u8; 8] { Sha256::digest(format!("global:{name}")).as_slice()[..8].try_into().unwrap() }
pub fn ata(owner: &Address, mint: &Address) -> Address {
    Address::find_program_address(&[owner.as_ref(), TOKEN_2022.as_ref(), mint.as_ref()], &addr(ATA_PROGRAM)).0
}
pub fn create_ata(payer: &Address, owner: &Address, mint: &Address) -> Instruction {
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
/// Mirrors the program: how much of the other side `amount_in` buys, rounded down.
pub fn quote(amount_in: u64, reserve_in: u64, reserve_out: u64) -> u64 {
    (amount_in as u128 * reserve_out as u128 / (reserve_in as u128 + amount_in as u128)) as u64
}
pub fn fee_of(amount: u64, bps: u16) -> u64 { (amount as u128 * bps as u128 / 10_000) as u64 }
/// `Custom(n)` out of an error string.
pub fn custom_code(err: &str) -> Option<u32> {
    let i = err.find("Custom(")? + 7;
    err[i..].split(')').next()?.parse().ok()
}

#[derive(Clone)]
pub struct Opts {
    pub fee_bps: u16,
    pub buy_fee_bps: u16,
    pub virtual_sol: u64,
    pub payout_sol: u64,
    /// Lamports the creator buys in the same transaction as the pool (0 = none).
    pub team_buy: u64,
    pub sigverify: bool,
}
impl Default for Opts {
    fn default() -> Self { Opts { fee_bps: 1500, buy_fee_bps: 0, virtual_sol: 30 * SOL, payout_sol: PAYOUT_MIN, team_buy: 0, sigverify: true } }
}

pub struct World {
    pub svm: LiteSVM,
    pub creator: Keypair,
    pub payout: Keypair,
    pub mint: Address,
    pub pool: Address,
    pub vault: Address,
    pub metas: Address,
    pub opts: Opts,
    /// Compute units the last successful transaction used.
    pub last_cu: u64,
}

impl World {
    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        let tx = Transaction::new_signed_with_payer(ixs, Some(&signers[0].pubkey()), signers, self.svm.latest_blockhash());
        let r = match self.svm.send_transaction(tx) {
            Ok(meta) => { self.last_cu = meta.compute_units_consumed; Ok(()) }
            Err(e) => Err(format!("{:?} {:?}", e.err, e.meta.logs)),
        };
        self.svm.expire_blockhash();
        r
    }
    pub fn lamports(&self, a: &Address) -> u64 { self.svm.get_account(a).map(|x| x.lamports).unwrap_or(0) }
    /// Token balance of `owner`'s associated account (0 if it doesn't exist).
    pub fn tokens(&self, owner: &Address) -> u64 {
        self.svm.get_account(&ata(owner, &self.mint)).map(|a| StateWithExtensions::<TokenAccount>::unpack(&a.data).unwrap().base.amount).unwrap_or(0)
    }
    pub fn pool_data(&self) -> Vec<u8> { self.svm.get_account(&self.pool).unwrap().data }
    pub fn sol_reserve(&self) -> u64 { u64::from_le_bytes(self.pool_data()[106..114].try_into().unwrap()) }
    pub fn virtual_sol(&self) -> u64 { u64::from_le_bytes(self.pool_data()[115..123].try_into().unwrap()) }
    pub fn buy_fee_bps(&self) -> u16 { u16::from_le_bytes(self.pool_data()[123..125].try_into().unwrap()) }
    pub fn fee_bps(&self) -> u16 { u16::from_le_bytes(self.pool_data()[104..106].try_into().unwrap()) }
    pub fn pool_rent(&self) -> u64 { self.svm.minimum_balance_for_rent_exemption(self.pool_data().len()) }
    /// SOL in the pool beyond the account's rent. Must always equal `sol_reserve - virtual_sol`.
    pub fn real_sol(&self) -> u64 { self.lamports(&self.pool) - self.pool_rent() }
    pub fn hook_accounts(&self) -> [AccountMeta; 2] { [AccountMeta::new_readonly(addr(HOOK), false), AccountMeta::new_readonly(self.metas, false)] }

    pub fn trade_ix(&self, user: &Address, buy: bool, amount: u64, min_out: u64) -> Instruction {
        let mut data = disc(if buy { "buy" } else { "sell" }).to_vec();
        data.extend_from_slice(&amount.to_le_bytes());
        data.extend_from_slice(&min_out.to_le_bytes());
        let mut accounts = vec![
            AccountMeta::new(*user, true),
            AccountMeta::new_readonly(self.mint, false),
            AccountMeta::new(self.pool, false),
            AccountMeta::new(self.vault, false),
            AccountMeta::new(ata(user, &self.mint), false),
            AccountMeta::new(self.payout.pubkey(), false),
            AccountMeta::new_readonly(TOKEN_2022, false),
            AccountMeta::new_readonly(addr(ATA_PROGRAM), false),
            AccountMeta::new_readonly(SYSTEM, false),
        ];
        accounts.extend(self.hook_accounts());
        Instruction { program_id: addr(POOL), accounts, data }
    }
    pub fn trade(&mut self, user: &Keypair, buy: bool, amount: u64, min_out: u64) -> Result<(), String> {
        let ix = self.trade_ix(&user.pubkey(), buy, amount, min_out);
        self.send(&[ix], &[user])
    }
    /// Token-2022 transfer to a token account, with the hook's extra accounts.
    pub fn transfer_ix(&self, from: &Address, to_account: &Address, amount: u64) -> Instruction {
        let mut ix = tok::transfer_checked(&TOKEN_2022, &ata(from, &self.mint), &self.mint, to_account, from, &[], amount, DECIMALS).unwrap();
        ix.accounts.extend([AccountMeta::new_readonly(self.metas, false), AccountMeta::new_readonly(addr(HOOK), false)]);
        ix
    }
    /// Wallet-to-wallet transfer that opens the receiver's associated account first.
    pub fn transfer(&mut self, from: &Keypair, to_owner: &Address, amount: u64) -> Result<(), String> {
        let ix = self.transfer_ix(&from.pubkey(), &ata(to_owner, &self.mint), amount);
        let create = create_ata(&from.pubkey(), to_owner, &self.mint);
        self.send(&[create, ix], &[from])
    }
    pub fn mint_state(&self) -> (Option<Address>, Option<Address>) {
        let m = self.svm.get_account(&self.mint).unwrap();
        let st = StateWithExtensions::<Mint>::unpack(&m.data).unwrap();
        let hook_auth = st.get_extension::<transfer_hook::TransferHook>().unwrap().authority;
        (Option::<Address>::from(st.base.mint_authority), Option::<Address>::from(hook_auth))
    }
}

/// scripts/launch.mjs, minus the token metadata (not needed here).
pub fn launch(o: Opts) -> World { try_launch(o).expect("launch") }

/// Same, but hands back the error of the pool-creating transaction (for the refusal tests).
pub fn try_launch(o: Opts) -> Result<World, String> {
    let mut svm = LiteSVM::new().with_sigverify(o.sigverify);
    svm.add_program_from_file(addr(HOOK), "../target/deploy/paper_hook.so").unwrap();
    svm.add_program_from_file(addr(POOL), "../target/deploy/paper_pool.so").unwrap();
    let creator = Keypair::new();
    let payout = Keypair::new();
    svm.airdrop(&creator.pubkey(), 1_000 * SOL).unwrap();
    if o.payout_sol > 0 { svm.airdrop(&payout.pubkey(), o.payout_sol).unwrap(); }
    let mint_kp = Keypair::new();
    let mint = mint_kp.pubkey();
    let pool = Address::find_program_address(&[b"pool", mint.as_ref()], &addr(POOL)).0;
    let metas = Address::find_program_address(&[b"extra-account-metas", mint.as_ref()], &addr(HOOK)).0;
    let vault = ata(&pool, &mint);
    let mut w = World { svm, creator, payout, mint, pool, vault, metas, opts: o.clone(), last_cu: 0 };
    let c = w.creator.pubkey();
    let creator = w.creator.insecure_clone();

    // tx 1
    let len = ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::TransferHook]).unwrap();
    let rent = w.svm.minimum_balance_for_rent_exemption(len);
    w.send(&[
        solana_system_interface::instruction::create_account(&c, &mint, rent, len as u64, &TOKEN_2022),
        transfer_hook::instruction::initialize(&TOKEN_2022, &mint, Some(c), Some(addr(HOOK))).unwrap(),
        tok::initialize_mint2(&TOKEN_2022, &mint, &c, None, DECIMALS).unwrap(),
        Instruction {
            program_id: addr(HOOK),
            accounts: vec![AccountMeta::new(c, true), AccountMeta::new(metas, false), AccountMeta::new_readonly(mint, false), AccountMeta::new_readonly(SYSTEM, false)],
            data: disc("initialize_extra_account_meta_list").to_vec(),
        },
    ], &[&creator, &mint_kp]).expect("mint + hook list");

    // tx 2
    let mut data = disc("initialize").to_vec();
    data.extend_from_slice(&o.fee_bps.to_le_bytes());
    data.extend_from_slice(&o.buy_fee_bps.to_le_bytes());
    data.extend_from_slice(&SUPPLY.to_le_bytes());
    data.extend_from_slice(&o.virtual_sol.to_le_bytes());
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
    let mut ixs = vec![
        create_ata(&c, &c, &mint),
        tok::mint_to(&TOKEN_2022, &mint, &ata(&c, &mint), &c, &[], SUPPLY).unwrap(),
        Instruction { program_id: addr(POOL), accounts, data },
    ];
    if o.team_buy > 0 {
        let net = o.team_buy - fee_of(o.team_buy, o.buy_fee_bps);
        ixs.push(w.trade_ix(&c, true, o.team_buy, quote(net, o.virtual_sol, SUPPLY)));
    }
    ixs.push(tok::set_authority(&TOKEN_2022, &mint, None, tok::AuthorityType::MintTokens, &c, &[]).unwrap());
    ixs.push(tok::set_authority(&TOKEN_2022, &mint, None, tok::AuthorityType::TransferHookProgramId, &c, &[]).unwrap());
    w.send(&ixs, &[&creator])?;
    Ok(w)
}
