use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::errors::MeridianError;
use crate::events::Redeemed;
use crate::state::*;

/// Same accounts as `Collateral`. The user's Yes, No and USDC accounts must already exist.
#[derive(Accounts)]
pub struct Redeem<'info> {
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

/// Burns `yes_amount` Yes and `no_amount` No (base units) and pays `UNIT` per winning token.
///
/// One winning base unit pays one USDC base unit; losing tokens burn for nothing. Pays from the
/// `collateral` counter, never the vault balance, so donations stay in the vault. Allowed while
/// paused and forever after settlement. `pairs_outstanding` keeps its value at settlement.
pub fn handle_redeem(ctx: Context<Redeem>, yes_amount: u64, no_amount: u64) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(
        market.status == MarketStatus::Settled,
        MeridianError::MarketNotSettled
    );
    require!(yes_amount > 0 || no_amount > 0, MeridianError::ZeroAmount);
    let payout = match market.outcome.ok_or(MeridianError::MarketNotSettled)? {
        Outcome::Yes => yes_amount,
        Outcome::No => no_amount,
    };

    let accounts = &ctx.accounts;
    let token_program = accounts.token_program.key();
    for (mint, from, amount) in [
        (&accounts.yes_mint, &accounts.user_yes, yes_amount),
        (&accounts.no_mint, &accounts.user_no, no_amount),
    ] {
        if amount == 0 {
            continue;
        }
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
    if payout > 0 {
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
            payout,
        )?;
    }

    let outcome = market.outcome;
    let market = &mut ctx.accounts.market;
    market.collateral = market
        .collateral
        .checked_sub(payout)
        .ok_or(MeridianError::CollateralInvariant)?;
    // R6 after settlement: the counter still covers every winning token left.
    let winning_mint = match outcome {
        Some(Outcome::Yes) => &mut ctx.accounts.yes_mint,
        _ => &mut ctx.accounts.no_mint,
    };
    winning_mint.reload()?;
    require!(
        market.collateral >= winning_mint.supply,
        MeridianError::CollateralInvariant
    );
    emit!(Redeemed {
        market: market.key(),
        user: ctx.accounts.user.key(),
        yes_amount,
        no_amount,
        payout,
    });
    Ok(())
}
