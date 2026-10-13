use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::*;

/// Admin only. `price` is at `ADMIN_PRICE_EXPO` and applies to every strike of the ticker-day.
#[derive(Accounts)]
#[instruction(ticker: Ticker, trading_day: u32)]
pub struct ProposeAdminPrice<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [TICKER_DAY_SEED, ticker.as_ref(), &trading_day.to_le_bytes()],
        bump = ticker_day.bump,
    )]
    pub ticker_day: Account<'info, TickerDay>,
}

/// Anyone. Marks the ticker-day `Final` with the pending admin price.
#[derive(Accounts)]
#[instruction(ticker: Ticker, trading_day: u32)]
pub struct FinalizeAdminSettle<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [TICKER_DAY_SEED, ticker.as_ref(), &trading_day.to_le_bytes()],
        bump = ticker_day.bump,
    )]
    pub ticker_day: Account<'info, TickerDay>,
}

pub fn handle_propose_admin_price(
    _ctx: Context<ProposeAdminPrice>,
    _ticker: Ticker,
    _trading_day: u32,
    _price: i64,
) -> Result<()> {
    err!(MeridianError::NotImplemented)
}

pub fn handle_finalize_admin_settle(
    _ctx: Context<FinalizeAdminSettle>,
    _ticker: Ticker,
    _trading_day: u32,
) -> Result<()> {
    err!(MeridianError::NotImplemented)
}
