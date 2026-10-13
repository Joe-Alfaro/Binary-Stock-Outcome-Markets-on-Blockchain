//! Settlement: `settle_market`, the delayed admin fallback and `redeem`.
//!
//! One price settles every strike of a ticker and trading day. The first settlement writes it to
//! the `TickerDay` and marks it `Final`; every later strike reuses it.

pub mod admin;
pub mod redeem;
pub mod settle;

pub use admin::*;
pub use redeem::*;
pub use settle::*;

/// Exponent of an admin-entered price: whole cents, the same scale as the strikes.
pub const ADMIN_PRICE_EXPO: i32 = -2;
