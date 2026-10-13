//! `place_order`, `cancel_order` and `settle_funds` (ARCHITECTURE.md §3.3, §3.7).

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::errors::MeridianError;
use crate::state::*;

/// Escrows `price × qty` USDC (bid) or `qty` Yes (ask) from the owner's wallet into the book's
/// escrow vaults, matches at the maker's price and credits both seats.
#[event_cpi]
#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(has_one = book)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut)]
    pub book: AccountLoader<'info, OrderBook>,
    #[account(mut, seeds = [YES_ESCROW_SEED, market.key().as_ref()], bump)]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [USDC_ESCROW_SEED, market.key().as_ref()], bump)]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = owner)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.yes_mint, token::authority = owner)]
    pub user_yes: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Only the order's owner. Moves escrow to the owner's free balance; no tokens move.
#[derive(Accounts)]
pub struct CancelOrder<'info> {
    pub owner: Signer<'info>,
    #[account(has_one = book)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut)]
    pub book: AccountLoader<'info, OrderBook>,
}

/// Withdraws the owner's free Yes and USDC from the escrow vaults. Allowed at any time.
#[derive(Accounts)]
pub struct SettleFunds<'info> {
    pub owner: Signer<'info>,
    #[account(has_one = book)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut)]
    pub book: AccountLoader<'info, OrderBook>,
    #[account(mut, seeds = [YES_ESCROW_SEED, market.key().as_ref()], bump)]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [USDC_ESCROW_SEED, market.key().as_ref()], bump)]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.yes_mint, token::authority = owner)]
    pub user_yes: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_escrow.mint, token::authority = owner)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_place_order(
    _ctx: Context<PlaceOrder>,
    _side: Side,
    _kind: OrderKind,
    _price: u8,
    _qty: u64,
) -> Result<()> {
    err!(MeridianError::NotImplemented)
}

pub fn handle_cancel_order(_ctx: Context<CancelOrder>, _order_id: u64) -> Result<()> {
    err!(MeridianError::NotImplemented)
}

pub fn handle_settle_funds(_ctx: Context<SettleFunds>) -> Result<()> {
    err!(MeridianError::NotImplemented)
}
