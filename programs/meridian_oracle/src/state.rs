use anchor_lang::prelude::*;

use crate::MAX_SIGNERS;

/// ASCII ticker symbol, right-padded with zero bytes (`b"AAPL\0\0\0\0"`). Account fields spell out
/// `[u8; 8]` because `InitSpace` can't see through the alias.
pub type Ticker = [u8; 8];

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Session {
    Regular,
    OutsideRegular,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum CloseShape {
    OfficialClose,
    ExactTimestamp,
    Interpolation,
}

/// One price as the source reported it, modeled on a Pyth price update: `price × 10^expo`, with
/// `conf` on the same scale and `publish_time` the source's timestamp in unix seconds.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct PriceInput {
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
    pub publish_time: i64,
    pub session: Session,
    pub official_close: bool,
}

/// `["signers"]`. Admin-controlled list of relay signers.
#[account]
#[derive(InitSpace)]
pub struct SignerRegistry {
    pub admin: Pubkey,
    #[max_len(MAX_SIGNERS)]
    pub signers: Vec<Pubkey>,
    pub bump: u8,
}

/// `["price", signer, ticker, publish_time]`. Append-only.
#[account]
#[derive(InitSpace)]
pub struct PriceUpdate {
    pub signer: Pubkey,
    pub ticker: [u8; 8],
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
    pub publish_time: i64,
    pub session: Session,
    pub official_close: bool,
    pub bump: u8,
}

/// `["close", signer, ticker, trading_day]`. Write-once; the only relay account settlement reads.
#[account]
#[derive(InitSpace)]
pub struct CloseRecord {
    pub signer: Pubkey,
    pub ticker: [u8; 8],
    /// `YYYYMMDD`.
    pub trading_day: u32,
    pub close_ts: i64,
    pub shape: CloseShape,
    /// The official close, the exact-timestamp update, or the update before `close_ts`.
    pub first: PriceInput,
    /// The update after `close_ts` for an interpolation pair; `None` otherwise.
    pub second: Option<PriceInput>,
    pub bump: u8,
}

/// `["latest", signer, ticker]`. Overwritten in place; display only, never a settlement input.
#[account]
#[derive(InitSpace)]
pub struct LatestPrice {
    pub signer: Pubkey,
    pub ticker: [u8; 8],
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
    pub publish_time: i64,
    pub session: Session,
    pub official_close: bool,
    pub bump: u8,
}
