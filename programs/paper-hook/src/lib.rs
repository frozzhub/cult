//! $PAPER transfer hook: keeps every sell going through the $PAPER pool.
//!
//! Token-2022 calls this on every $PAPER transfer. A transfer is allowed when the receiving token account
//! is owned by:
//!   - the $PAPER pool (PDA ["pool", mint] of the paper-pool program), or
//!   - a normal wallet (an address on the ed25519 curve, which is what every user and CEX wallet is).
//! Anything else (a Raydium, Meteora or Orca vault, all owned by program addresses) is refused, so nobody
//! can open a second pool that skips the 15% sell fee.
//!
//! Side effect: $PAPER can't be sent to program-owned wallets either (for example a Squads multisig).
//!
//! Build: `npm run build:programs`. Tests: programs-tests/ (LiteSVM, `npm run test:programs`).
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::{transfer_hook::TransferHookAccount, BaseStateWithExtensions, StateWithExtensions};
use anchor_spl::token_2022::spl_token_2022::state::Account as SplAccount;
use anchor_spl::token_interface::{Mint, TokenAccount};
use solana_curve25519::edwards::{validate_edwards, PodEdwardsPoint};
use spl_tlv_account_resolution::state::ExtraAccountMetaList;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

declare_id!("794MkqjE5VxXMVX9pJFK9D6YeK9pKp59K5BkBULfnSG2");

/// The paper-pool program (programs/paper-pool). Keep in sync with its declare_id!.
pub const POOL_PROGRAM: Pubkey = pubkey!("J6zYGwRTLX17ms2dDZ6yGXP21xfigBwLKvYXho2Aw9Bu");

#[program]
pub mod paper_hook {
    use super::*;

    /// Creates the (empty) extra-account list Token-2022 reads before calling the hook. Run once at launch.
    pub fn initialize_extra_account_meta_list(ctx: Context<InitializeExtraAccountMetaList>) -> Result<()> {
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?, &[])?;
        Ok(())
    }

    #[interface(spl_transfer_hook_interface::execute)]
    pub fn transfer_hook(ctx: Context<TransferHook>, _amount: u64) -> Result<()> {
        // Only run as part of a real Token-2022 transfer, never called directly.
        let source = ctx.accounts.source_token.to_account_info();
        let data = source.try_borrow_data()?;
        let state = StateWithExtensions::<SplAccount>::unpack(&data)?;
        let ext = state.get_extension::<TransferHookAccount>()?;
        require!(bool::from(ext.transferring), HookError::NotTransferring);

        let to = ctx.accounts.destination_token.owner;
        let (pool, _) = Pubkey::find_program_address(&[b"pool", ctx.accounts.mint.key().as_ref()], &POOL_PROGRAM);
        if to == pool {
            return Ok(());
        }
        require!(validate_edwards(&PodEdwardsPoint(to.to_bytes())), HookError::OtherPool);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: created here with the size of an empty extra-account list.
    #[account(init, payer = payer, space = ExtraAccountMetaList::size_of(0).unwrap(), seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

// Account order is fixed by the transfer-hook interface: source, mint, destination, owner, extra metas.
#[derive(Accounts)]
pub struct TransferHook<'info> {
    #[account(token::mint = mint)]
    pub source_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = mint)]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: the source's owner or delegate; Token-2022 already checked it signed.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: the list created above.
    #[account(seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
}

#[error_code]
pub enum HookError {
    #[msg("Only callable during a $PAPER transfer")]
    NotTransferring,
    #[msg("$PAPER can only be traded through the $PAPER pool")]
    OtherPool,
}
