use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::MeridianError;
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

pub fn handle_mint_pair(_ctx: Context<Collateral>, _n: u64) -> Result<()> {
    err!(MeridianError::NotImplemented)
}

pub fn handle_merge_pair(_ctx: Context<Collateral>, _n: u64) -> Result<()> {
    err!(MeridianError::NotImplemented)
}
