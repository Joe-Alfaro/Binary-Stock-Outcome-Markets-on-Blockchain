use anchor_lang::prelude::*;

use crate::state::Side;

#[event]
pub struct PairMinted {
    pub market: Pubkey,
    pub user: Pubkey,
    /// Whole pairs.
    pub n: u64,
}

#[event]
pub struct PairMerged {
    pub market: Pubkey,
    pub user: Pubkey,
    /// Whole pairs.
    pub n: u64,
}

/// One per fill, emitted with `emit_cpi!`. Names both sides because the maker's fill happens in
/// the taker's transaction.
#[event]
pub struct OrderFilled {
    pub market: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub maker_order_id: u64,
    pub taker_side: Side,
    /// Cents: the maker's price.
    pub price: u8,
    /// Whole tokens.
    pub qty: u64,
    pub ts: i64,
}

#[event]
pub struct MarketSettled {
    pub market: Pubkey,
    pub ticker: [u8; 8],
    pub trading_day: u32,
    pub strike: i64,
    pub outcome: crate::state::Outcome,
    pub settle_price: i64,
    pub settle_expo: i32,
    pub settle_source: crate::state::SettleSource,
}

/// An oracle price settled a ticker-day that had a different admin price pending.
#[event]
pub struct AdminPriceMismatch {
    pub ticker_day: Pubkey,
    pub ticker: [u8; 8],
    pub trading_day: u32,
    pub oracle_price: i64,
    pub admin_price: i64,
}

#[event]
pub struct Redeemed {
    pub market: Pubkey,
    pub user: Pubkey,
    pub yes_amount: u64,
    pub no_amount: u64,
    /// USDC base units paid.
    pub payout: u64,
}
