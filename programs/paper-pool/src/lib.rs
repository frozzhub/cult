//! $PAPER pool: a SOL / $PAPER constant-product pool with no fee on buys and a fee on sells.
//!
//! - buy:  SOL in, $PAPER out. No fee.
//! - sell: $PAPER in, SOL out. `fee_bps` (15%) of the SOL goes straight to the payout wallet, which the
//!         Worker swaps to USDC and airdrops to holders every hour.
//!
//! Liquidity is added once at `initialize` and locked forever (no LP tokens, no withdraw, no admin).
//! The fee and payout wallet are fixed at creation and can't be changed later.
//!
//! The coin is a Token-2022 mint with a transfer hook (programs/paper-hook) that blocks transfers into
//! any other pool, so every sell has to come through here and pay the fee.
//!
//! Build: `npm run build:programs`. Tests: programs-tests/ (LiteSVM, `npm run test:programs`).
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

declare_id!("J6zYGwRTLX17ms2dDZ6yGXP21xfigBwLKvYXho2Aw9Bu");

pub const MAX_FEE_BPS: u16 = 2_000;

#[program]
pub mod paper_pool {
    use super::*;

    /// Create the pool and seed it with `token_amount` $PAPER and `sol_amount` lamports from the creator.
    pub fn initialize<'info>(
        ctx: Context<'_, '_, 'info, 'info, Initialize<'info>>,
        fee_bps: u16,
        token_amount: u64,
        sol_amount: u64,
    ) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, PoolError::FeeTooHigh);
        require!(token_amount > 0 && sol_amount > 0, PoolError::ZeroAmount);

        {
            let pool = &mut ctx.accounts.pool;
            pool.mint = ctx.accounts.mint.key();
            pool.vault = ctx.accounts.vault.key();
            pool.payout = ctx.accounts.payout.key();
            pool.fee_bps = fee_bps;
            pool.sol_reserve = sol_amount;
            pool.bump = ctx.bumps.pool;
        }

        move_tokens(
            &ctx.accounts.token_program,
            ctx.accounts.creator_tokens.to_account_info(),
            &ctx.accounts.mint,
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.creator.to_account_info(),
            ctx.remaining_accounts,
            token_amount,
            &[],
        )?;
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer { from: ctx.accounts.creator.to_account_info(), to: ctx.accounts.pool.to_account_info() },
            ),
            sol_amount,
        )?;
        emit!(PoolCreated { mint: ctx.accounts.mint.key(), fee_bps, token_amount, sol_amount });
        Ok(())
    }

    /// Spend `sol_in` lamports on $PAPER. Fails if fewer than `min_out` tokens would come back.
    pub fn buy<'info>(ctx: Context<'_, '_, 'info, 'info, Trade<'info>>, sol_in: u64, min_out: u64) -> Result<()> {
        require!(sol_in > 0, PoolError::ZeroAmount);
        let token_reserve = ctx.accounts.vault.amount;
        let sol_reserve = ctx.accounts.pool.sol_reserve;
        let out = quote(sol_in, sol_reserve, token_reserve)?;
        require!(out > 0 && out >= min_out, PoolError::Slippage);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer { from: ctx.accounts.user.to_account_info(), to: ctx.accounts.pool.to_account_info() },
            ),
            sol_in,
        )?;
        ctx.accounts.pool.sol_reserve = sol_reserve.checked_add(sol_in).ok_or(PoolError::Overflow)?;

        let mint_key = ctx.accounts.mint.key();
        let seeds: &[&[u8]] = &[b"pool", mint_key.as_ref(), &[ctx.accounts.pool.bump]];
        move_tokens(
            &ctx.accounts.token_program,
            ctx.accounts.vault.to_account_info(),
            &ctx.accounts.mint,
            ctx.accounts.user_tokens.to_account_info(),
            ctx.accounts.pool.to_account_info(),
            ctx.remaining_accounts,
            out,
            &[seeds],
        )?;
        emit!(Traded { user: ctx.accounts.user.key(), buy: true, tokens: out, sol: sol_in, fee: 0 });
        Ok(())
    }

    /// Sell `tokens_in` $PAPER. The fee is taken from the SOL out and sent to the payout wallet.
    /// Fails if the seller would get less than `min_out` lamports after the fee.
    pub fn sell<'info>(ctx: Context<'_, '_, 'info, 'info, Trade<'info>>, tokens_in: u64, min_out: u64) -> Result<()> {
        require!(tokens_in > 0, PoolError::ZeroAmount);
        let token_reserve = ctx.accounts.vault.amount;
        let sol_reserve = ctx.accounts.pool.sol_reserve;

        move_tokens(
            &ctx.accounts.token_program,
            ctx.accounts.user_tokens.to_account_info(),
            &ctx.accounts.mint,
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.user.to_account_info(),
            ctx.remaining_accounts,
            tokens_in,
            &[],
        )?;
        // Price what actually arrived (in case the mint ever has a transfer fee).
        ctx.accounts.vault.reload()?;
        let received = ctx.accounts.vault.amount.checked_sub(token_reserve).ok_or(PoolError::Overflow)?;

        let gross = quote(received, token_reserve, sol_reserve)?;
        let fee = (gross as u128 * ctx.accounts.pool.fee_bps as u128 / 10_000) as u64;
        let net = gross - fee;
        require!(net > 0 && net >= min_out, PoolError::Slippage);

        ctx.accounts.pool.sol_reserve = sol_reserve.checked_sub(gross).ok_or(PoolError::Overflow)?;
        // The pool account is owned by this program, so it can pay out lamports directly.
        let pool_info = ctx.accounts.pool.to_account_info();
        **pool_info.try_borrow_mut_lamports()? -= gross;
        **ctx.accounts.payout.to_account_info().try_borrow_mut_lamports()? += fee;
        **ctx.accounts.user.to_account_info().try_borrow_mut_lamports()? += net;

        emit!(Traded { user: ctx.accounts.user.key(), buy: false, tokens: received, sol: net, fee });
        Ok(())
    }
}

/// x * y = k: how much of the other side `amount_in` buys.
fn quote(amount_in: u64, reserve_in: u64, reserve_out: u64) -> Result<u64> {
    require!(reserve_in > 0 && reserve_out > 0, PoolError::EmptyPool);
    let out = (amount_in as u128)
        .checked_mul(reserve_out as u128)
        .and_then(|n| n.checked_div(reserve_in as u128 + amount_in as u128))
        .ok_or(PoolError::Overflow)?;
    Ok(out as u64)
}

/// Token-2022 transfer that also passes the transfer hook's extra accounts (from remaining_accounts).
#[allow(clippy::too_many_arguments)]
fn move_tokens<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: AccountInfo<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    extra: &[AccountInfo<'info>],
    amount: u64,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    spl_token_2022::onchain::invoke_transfer_checked(
        token_program.key,
        from,
        mint.to_account_info(),
        to,
        authority,
        extra,
        amount,
        mint.decimals,
        seeds,
    )?;
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub payout: Pubkey,
    pub fee_bps: u16,
    /// Lamports in the pool that belong to the curve (the account's rent is kept separately).
    pub sol_reserve: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = creator, space = 8 + Pool::INIT_SPACE, seeds = [b"pool", mint.key().as_ref()], bump)]
    pub pool: Account<'info, Pool>,
    #[account(init, payer = creator, associated_token::mint = mint, associated_token::authority = pool, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = creator, token::token_program = token_program)]
    pub creator_tokens: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: any system wallet; it only ever receives SOL.
    pub payout: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [b"pool", mint.key().as_ref()], bump = pool.bump, has_one = mint, has_one = vault, has_one = payout)]
    pub pool: Account<'info, Pool>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(init_if_needed, payer = user, associated_token::mint = mint, associated_token::authority = user, associated_token::token_program = token_program)]
    pub user_tokens: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: must match pool.payout (has_one above).
    #[account(mut)]
    pub payout: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct PoolCreated {
    pub mint: Pubkey,
    pub fee_bps: u16,
    pub token_amount: u64,
    pub sol_amount: u64,
}

#[event]
pub struct Traded {
    pub user: Pubkey,
    pub buy: bool,
    pub tokens: u64,
    pub sol: u64,
    pub fee: u64,
}

#[error_code]
pub enum PoolError {
    #[msg("Fee can't be more than 20%")]
    FeeTooHigh,
    #[msg("Amount must be more than zero")]
    ZeroAmount,
    #[msg("Price moved more than your slippage")]
    Slippage,
    #[msg("Pool is empty")]
    EmptyPool,
    #[msg("Math overflow")]
    Overflow,
}
