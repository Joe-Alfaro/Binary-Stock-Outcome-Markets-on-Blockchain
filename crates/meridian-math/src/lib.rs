//! Pure settlement math shared by the on-chain program and mirrored in `packages/sdk/src/math`.
//!
//! No Anchor or Solana dependency, so the `meridian` program and host-side tests can both use it.
//! `no_std` with `alloc`, no floating point: every comparison is exact `i128` integer math.

#![no_std]

extern crate alloc;

pub mod closing;
pub mod payout;
pub mod price;
pub mod strikes;

pub use closing::{closing_price, ClosingPrice, ClosingPriceError, ClosingShape, SettlementParams};
pub use payout::{payout_per_token, settle_outcome, Outcome, Side, Strike, PAYOUT_UNIT};
pub use price::{NormalizedPrice, Session, Ticker, MAX_EXPO, MIN_EXPO};
pub use strikes::compute_strikes;
