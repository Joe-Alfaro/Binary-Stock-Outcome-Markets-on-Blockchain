use anchor_lang::prelude::*;

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
