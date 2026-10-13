use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::errors::MeridianError;
use crate::events::{PairMerged, PairMinted};
use crate::state::*;

/// Shared by `mint_pair` and `merge_pair`. The user's Yes, No and USDC accounts must already
/// exist (clients create the associated token accounts idempotently in the same transaction).
#[derive(Accounts)]
pub struct Collateral<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, address = market.yes_mint)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.no_mint)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.usdc_mint)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.yes_mint)]
    pub user_yes: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.no_mint)]
    pub user_no: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Takes `n × UNIT` USDC from the user into the vault and mints `n` Yes and `n` No to them.
pub fn handle_mint_pair(ctx: Context<Collateral>, n: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let market = &ctx.accounts.market;
    require!(!ctx.accounts.config.paused, MeridianError::Paused);
    require!(
        market.status == MarketStatus::Open,
        MeridianError::MarketSettled
    );
    require!(n > 0, MeridianError::ZeroAmount);
    require!(now >= market.mint_open_ts, MeridianError::MintNotOpen);
    require!(now < market.close_ts, MeridianError::MarketClosed);
    let amount = n.checked_mul(UNIT).ok_or(MeridianError::MathOverflow)?;

    let accounts = &ctx.accounts;
    let token_program = accounts.token_program.key();
    token::transfer(
        CpiContext::new(
            token_program,
            Transfer {
                from: accounts.user_usdc.to_account_info(),
                to: accounts.vault.to_account_info(),
                authority: accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;
    let seeds = market_seeds(market);
    let seeds = seeds.as_slices();
    let signer: &[&[&[u8]]] = &[&seeds];
    for (mint, to) in [
        (&accounts.yes_mint, &accounts.user_yes),
        (&accounts.no_mint, &accounts.user_no),
    ] {
        token::mint_to(
            CpiContext::new_with_signer(
                token_program,
                MintTo {
                    mint: mint.to_account_info(),
                    to: to.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;
    }

    let market = &mut ctx.accounts.market;
    market.collateral = market
        .collateral
        .checked_add(amount)
        .ok_or(MeridianError::MathOverflow)?;
    market.pairs_outstanding = market
        .pairs_outstanding
        .checked_add(n)
        .ok_or(MeridianError::MathOverflow)?;
    check_collateral(market)?;
    emit!(PairMinted {
        market: market.key(),
        user: ctx.accounts.user.key(),
        n,
    });
    Ok(())
}

/// Burns `n` Yes and `n` No from the user and pays `n × UNIT` USDC from the vault. Allowed while
/// paused and after close, so hedged positions can always exit before settlement.
pub fn handle_merge_pair(ctx: Context<Collateral>, n: u64) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(
        market.status == MarketStatus::Open,
        MeridianError::MarketSettled
    );
    require!(n > 0, MeridianError::ZeroAmount);
    let amount = n.checked_mul(UNIT).ok_or(MeridianError::MathOverflow)?;

    let accounts = &ctx.accounts;
    let token_program = accounts.token_program.key();
    for (mint, from) in [
        (&accounts.yes_mint, &accounts.user_yes),
        (&accounts.no_mint, &accounts.user_no),
    ] {
        token::burn(
            CpiContext::new(
                token_program,
                Burn {
                    mint: mint.to_account_info(),
                    from: from.to_account_info(),
                    authority: accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;
    }
    let seeds = market_seeds(market);
    token::transfer(
        CpiContext::new_with_signer(
            token_program,
            Transfer {
                from: accounts.vault.to_account_info(),
                to: accounts.user_usdc.to_account_info(),
                authority: market.to_account_info(),
            },
            &[&seeds.as_slices()],
        ),
        amount,
    )?;

    let market = &mut ctx.accounts.market;
    // Burning n of each succeeded, so at least n pairs are outstanding; underflow here would
    // mean the counters drifted from the mints.
    market.collateral = market
        .collateral
        .checked_sub(amount)
        .ok_or(MeridianError::CollateralInvariant)?;
    market.pairs_outstanding = market
        .pairs_outstanding
        .checked_sub(n)
        .ok_or(MeridianError::CollateralInvariant)?;
    check_collateral(market)?;
    emit!(PairMerged {
        market: market.key(),
        user: ctx.accounts.user.key(),
        n,
    });
    Ok(())
}

/// R6: the collateral counter is exactly `pairs_outstanding × UNIT`, never the vault balance.
fn check_collateral(market: &Market) -> Result<()> {
    let expected = market
        .pairs_outstanding
        .checked_mul(UNIT)
        .ok_or(MeridianError::MathOverflow)?;
    require!(
        market.collateral == expected,
        MeridianError::CollateralInvariant
    );
    Ok(())
}
