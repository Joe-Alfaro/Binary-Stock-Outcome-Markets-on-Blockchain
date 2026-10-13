/// Ticker symbol as ASCII bytes, right-padded with zero bytes (`b"AAPL\0\0\0\0"`).
pub type Ticker = [u8; 8];

/// Smallest price exponent a configured price source may use.
pub const MIN_EXPO: i32 = -12;
/// Largest price exponent a configured price source may use.
pub const MAX_EXPO: i32 = 0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Session {
    Regular,
    OutsideRegular,
}

/// One price update from any oracle kind, after the price adapter has normalized it.
/// The value is `price × 10^expo`; `conf` uses the same scale.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NormalizedPrice {
    pub ticker: Ticker,
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
    /// Unix seconds.
    pub publish_time: i64,
    pub session: Session,
    pub official_close: bool,
}
