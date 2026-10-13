use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::MeridianError;
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq)]
pub struct CreateMarketArgs {
    pub ticker: Ticker,
    /// YYYYMMDD.
    pub trading_day: u32,
    pub strike: i64,
    pub strike_expo: i32,
    pub close_ts: i64,
    pub mint_open_ts: i64,
    pub trading_open_ts: i64,
}

/// One strike per call. Used by `create_strike_market` (admin or automation authority) and
/// `add_strike` (admin, before `close_ts`).
///
/// Seeds: `trading_day` as u32 little-endian bytes, `strike` as i64 little-endian bytes.
#[derive(Accounts)]
#[instruction(args: CreateMarketArgs)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + TickerDay::INIT_SPACE,
        seeds = [TICKER_DAY_SEED, args.ticker.as_ref(), &args.trading_day.to_le_bytes()],
        bump,
    )]
    pub ticker_day: Account<'info, TickerDay>,
    #[account(
        init,
        payer = authority,
        space = 8 + Market::INIT_SPACE,
        seeds = [
            MARKET_SEED,
            args.ticker.as_ref(),
            &args.trading_day.to_le_bytes(),
            &args.strike.to_le_bytes(),
        ],
        bump,
    )]
    pub market: Box<Account<'info, Market>>,
    #[account(
        init,
        payer = authority,
        seeds = [YES_MINT_SEED, market.key().as_ref()],
        bump,
        mint::decimals = 6,
        mint::authority = market,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = authority,
        seeds = [NO_MINT_SEED, market.key().as_ref()],
        bump,
        mint::decimals = 6,
        mint::authority = market,
    )]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = authority,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = market,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<OrderBook>(),
        seeds = [BOOK_SEED, market.key().as_ref()],
        bump,
    )]
    pub book: AccountLoader<'info, OrderBook>,
    #[account(
        init,
        payer = authority,
        seeds = [YES_ESCROW_SEED, market.key().as_ref()],
        bump,
        token::mint = yes_mint,
        token::authority = book,
    )]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = authority,
        seeds = [USDC_ESCROW_SEED, market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = book,
    )]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_strike_market(
    _ctx: Context<CreateMarket>,
    _args: CreateMarketArgs,
) -> Result<()> {
    err!(MeridianError::NotImplemented)
}

pub fn handle_add_strike(_ctx: Context<CreateMarket>, _args: CreateMarketArgs) -> Result<()> {
    err!(MeridianError::NotImplemented)
}
