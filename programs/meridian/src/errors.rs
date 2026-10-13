use anchor_lang::prelude::*;

#[error_code]
pub enum MeridianError {
    #[msg("Instruction not implemented yet")]
    NotImplemented,
    #[msg("Signer is not allowed to call this instruction")]
    Unauthorized,
    #[msg("The program is paused")]
    Paused,
    #[msg("Minting has not opened for this market yet")]
    MintNotOpen,
    #[msg("The market is at or past its close")]
    MarketClosed,
    #[msg("The market is already settled")]
    MarketSettled,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Ticker is not in the configured ticker list")]
    UnknownTicker,
    #[msg("Market times must satisfy mint_open_ts <= trading_open_ts < close_ts")]
    InvalidMarketTimes,
    #[msg("close_ts differs from the ticker-day's close_ts")]
    CloseTsMismatch,
    #[msg("Collateral invariant violated")]
    CollateralInvariant,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
