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
    // ---- settlement ----
    #[msg("The market has not reached its close yet")]
    SettleTooEarly,
    #[msg("Oracle account is not the canonical close record for this slot, ticker and day")]
    InvalidOracleAccount,
    #[msg("The oracle slot is disabled")]
    OracleSlotDisabled,
    #[msg("A price update is too far from close_ts")]
    StalePrice,
    #[msg("A price update's confidence band is too wide")]
    ConfidenceTooWide,
    #[msg("A price must be positive")]
    NonPositivePrice,
    #[msg("A price update is outside the regular session")]
    OutsideRegularSession,
    #[msg("The price updates form no valid closing-price shape")]
    NoValidClosePrice,
    #[msg("The market is not settled yet")]
    MarketNotSettled,
    #[msg("The ticker-day already has its final price")]
    TickerDayFinal,
    #[msg("Too early to propose an admin price")]
    AdminProposeTooEarly,
    #[msg("Too early to finalize the admin price")]
    AdminFinalizeTooEarly,
    #[msg("No admin price is pending")]
    NoPendingAdminPrice,
}
