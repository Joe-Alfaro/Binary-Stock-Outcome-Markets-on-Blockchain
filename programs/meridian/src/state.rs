use anchor_lang::prelude::*;

pub mod orderbook;
pub use orderbook::*;

/// Base units per whole Yes, No or USDC token (6 decimals).
pub const UNIT: u64 = 1_000_000;
pub const TICKER_COUNT: usize = 7;
/// Tickers are ASCII, uppercase and zero-padded to this length, in accounts and in seeds.
pub const TICKER_LEN: usize = 8;
pub type Ticker = [u8; TICKER_LEN];

pub const CONFIG_SEED: &[u8] = b"config";
pub const TICKER_DAY_SEED: &[u8] = b"day";
pub const MARKET_SEED: &[u8] = b"market";
pub const YES_MINT_SEED: &[u8] = b"yes";
pub const NO_MINT_SEED: &[u8] = b"no";
pub const VAULT_SEED: &[u8] = b"vault";
pub const BOOK_SEED: &[u8] = b"book";
pub const YES_ESCROW_SEED: &[u8] = b"yes_escrow";
pub const USDC_ESCROW_SEED: &[u8] = b"usdc_escrow";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum OracleKind {
    Disabled,
    MeridianRelay,
    Pyth,
    ChainlinkDataStreams,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct OracleSlot {
    pub kind: OracleKind,
    /// `MeridianRelay`: the relay signer for this slot.
    pub relay_signer: Pubkey,
    /// `Pyth` feed IDs or `ChainlinkDataStreams` stream IDs, in `Config.tickers` order.
    pub feed_ids: [[u8; 32]; TICKER_COUNT],
    /// `ChainlinkDataStreams`: the verifier program.
    pub verifier_program: Pubkey,
    /// `Pyth`: the minimum verification level.
    pub min_verification_level: u8,
}

#[account]
#[derive(InitSpace, Debug, PartialEq)]
pub struct Config {
    pub admin: Pubkey,
    pub automation_authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub tickers: [[u8; TICKER_LEN]; TICKER_COUNT],
    pub oracle_slots: [OracleSlot; 2],
    pub max_staleness_secs: u32,
    pub max_conf_bps: u16,
    pub admin_propose_delay_secs: u32,
    pub admin_finalize_delay_secs: u32,
    pub paused: bool,
    pub demo_mode: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum TickerDayStatus {
    Open,
    Final,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum SettleSource {
    None,
    OracleSlot0,
    OracleSlot1,
    Admin,
}

/// One settlement price for every strike of a ticker and trading day.
#[account]
#[derive(InitSpace, Debug, PartialEq)]
pub struct TickerDay {
    pub ticker: [u8; TICKER_LEN],
    /// YYYYMMDD.
    pub trading_day: u32,
    pub close_ts: i64,
    pub status: TickerDayStatus,
    pub settle_price: i64,
    pub settle_expo: i32,
    pub settle_source: SettleSource,
    pub pending_admin_price: i64,
    /// 0 when no admin price is pending.
    pub pending_admin_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum MarketStatus {
    Open,
    Settled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Outcome {
    Yes,
    No,
}

#[account]
#[derive(InitSpace, Debug, PartialEq)]
pub struct Market {
    pub ticker: [u8; TICKER_LEN],
    /// YYYYMMDD.
    pub trading_day: u32,
    /// `strike × 10^strike_expo` is the strike price.
    pub strike: i64,
    pub strike_expo: i32,
    pub close_ts: i64,
    pub mint_open_ts: i64,
    pub trading_open_ts: i64,
    pub ticker_day: Pubkey,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub vault: Pubkey,
    pub book: Pubkey,
    /// USDC base units backing outstanding pairs. Never read from the vault balance.
    pub collateral: u64,
    /// Whole Yes/No pairs outstanding (each backed by `UNIT` USDC base units).
    pub pairs_outstanding: u64,
    pub status: MarketStatus,
    pub outcome: Option<Outcome>,
    pub settle_price: i64,
    pub settle_source: SettleSource,
    pub demo: bool,
    pub created_at: i64,
    pub bump: u8,
    /// Zeroed space for the settlement package (pending admin price and time, and the like), so
    /// its fields fit in markets created before that upgrade.
    pub _reserved: [u8; MARKET_RESERVED],
}

pub const MARKET_RESERVED: usize = 64;

/// Owned signer seeds for a `Market` PDA, which signs as mint authority and vault owner.
pub struct MarketSeeds {
    ticker: Ticker,
    trading_day: [u8; 4],
    strike: [u8; 8],
    bump: [u8; 1],
}

impl MarketSeeds {
    pub fn as_slices(&self) -> [&[u8]; 5] {
        [
            MARKET_SEED,
            &self.ticker,
            &self.trading_day,
            &self.strike,
            &self.bump,
        ]
    }
}

pub fn market_seeds(market: &Market) -> MarketSeeds {
    MarketSeeds {
        ticker: market.ticker,
        trading_day: market.trading_day.to_le_bytes(),
        strike: market.strike.to_le_bytes(),
        bump: [market.bump],
    }
}

/// Order book for one market. The order-book fields follow the header; `market` stays first.
/// Order and seat types live in `state/orderbook.rs`.
#[account(zero_copy)]
#[derive(Debug)]
pub struct OrderBook {
    pub market: Pubkey,
    pub yes_escrow: Pubkey,
    pub usdc_escrow: Pubkey,
    pub next_seq: u64,
    pub bump: u8,
    pub _padding: [u8; 7],
    pub bids: [Order; BOOK_SIDE_CAPACITY],
    pub asks: [Order; BOOK_SIDE_CAPACITY],
    pub seats: [OpenOrders; SEAT_CAPACITY],
}
