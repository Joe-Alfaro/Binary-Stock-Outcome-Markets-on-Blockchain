use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::MeridianError;
use crate::schedule::is_regular_schedule;
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
    ctx: Context<CreateMarket>,
    args: CreateMarketArgs,
) -> Result<()> {
    let config = &ctx.accounts.config;
    let authority = ctx.accounts.authority.key();
    require!(
        authority == config.admin || authority == config.automation_authority,
        MeridianError::Unauthorized
    );
    create(ctx, args)
}

/// Intraday strike addition: admin only. The before-close check lives in `create`.
pub fn handle_add_strike(ctx: Context<CreateMarket>, args: CreateMarketArgs) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.config.admin,
        MeridianError::Unauthorized
    );
    create(ctx, args)
}

/// Writes the `TickerDay` (on its first strike), the `Market` and the `OrderBook` header. The
/// mints, vault and escrows are already created by the account constraints.
fn create(ctx: Context<CreateMarket>, args: CreateMarketArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let config = &ctx.accounts.config;
    require!(
        args.ticker != Ticker::default() && config.tickers.contains(&args.ticker),
        MeridianError::UnknownTicker
    );
    require!(
        args.mint_open_ts <= args.trading_open_ts && args.trading_open_ts < args.close_ts,
        MeridianError::InvalidMarketTimes
    );
    require!(now < args.close_ts, MeridianError::MarketClosed);
    // Custom times only for the admin in demo mode (R44, D49).
    let custom_allowed = config.demo_mode && ctx.accounts.authority.key() == config.admin;
    require!(
        custom_allowed
            || is_regular_schedule(
                args.trading_day,
                args.mint_open_ts,
                args.trading_open_ts,
                args.close_ts
            ),
        MeridianError::NonStandardSchedule
    );

    let ticker_day = &mut ctx.accounts.ticker_day;
    // `init_if_needed` leaves a fresh account zeroed, and no real day is 0.
    if ticker_day.trading_day == 0 {
        ticker_day.set_inner(TickerDay {
            ticker: args.ticker,
            trading_day: args.trading_day,
            close_ts: args.close_ts,
            status: TickerDayStatus::Open,
            settle_price: 0,
            settle_expo: 0,
            settle_source: SettleSource::None,
            pending_admin_price: 0,
            pending_admin_at: 0,
            bump: ctx.bumps.ticker_day,
            settle_numerator: 0,
            settle_denominator: 0,
        });
    } else {
        require!(
            ticker_day.close_ts == args.close_ts,
            MeridianError::CloseTsMismatch
        );
        require!(
            ticker_day.status == TickerDayStatus::Open,
            MeridianError::MarketSettled
        );
    }

    let market_key = ctx.accounts.market.key();
    ctx.accounts.market.set_inner(Market {
        ticker: args.ticker,
        trading_day: args.trading_day,
        strike: args.strike,
        strike_expo: args.strike_expo,
        close_ts: args.close_ts,
        mint_open_ts: args.mint_open_ts,
        trading_open_ts: args.trading_open_ts,
        ticker_day: ctx.accounts.ticker_day.key(),
        yes_mint: ctx.accounts.yes_mint.key(),
        no_mint: ctx.accounts.no_mint.key(),
        vault: ctx.accounts.vault.key(),
        book: ctx.accounts.book.key(),
        collateral: 0,
        pairs_outstanding: 0,
        status: MarketStatus::Open,
        outcome: None,
        settle_price: 0,
        settle_source: SettleSource::None,
        demo: config.demo_mode,
        created_at: now,
        bump: ctx.bumps.market,
        _reserved: [0; MARKET_RESERVED],
    });

    let mut book = ctx.accounts.book.load_init()?;
    book.market = market_key;
    book.yes_escrow = ctx.accounts.yes_escrow.key();
    book.usdc_escrow = ctx.accounts.usdc_escrow.key();
    book.next_seq = 0;
    book.bump = ctx.bumps.book;
    Ok(())
}
