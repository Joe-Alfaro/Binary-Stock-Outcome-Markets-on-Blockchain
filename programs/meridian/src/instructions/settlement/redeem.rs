use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::MeridianError;
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
pub fn handle_redeem(_ctx: Context<Redeem>, _yes_amount: u64, _no_amount: u64) -> Result<()> {
    err!(MeridianError::NotImplemented)
}
