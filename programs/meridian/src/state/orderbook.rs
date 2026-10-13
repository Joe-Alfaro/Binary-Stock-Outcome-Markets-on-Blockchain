//! Order book types: one Yes-vs-USDC book per market (ARCHITECTURE.md §3.2, §3.7).
//!
//! Units: prices are whole cents from `MIN_PRICE` to `MAX_PRICE`, quantities are whole Yes
//! tokens (lot size `UNIT`), and seat balances are token base units.

use anchor_lang::prelude::*;

/// Resting orders per side.
pub const BOOK_SIDE_CAPACITY: usize = 32;
/// Trader seats per book.
pub const SEAT_CAPACITY: usize = 32;
/// Matches (fills plus self-trade cancels) per `place_order`.
pub const MAX_FILLS_PER_ORDER: usize = 16;
pub const MIN_PRICE: u8 = 1;
pub const MAX_PRICE: u8 = 99;
/// USDC base units per cent per whole token.
pub const USDC_PER_CENT: u64 = 10_000;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    /// Buy Yes with USDC.
    Bid,
    /// Sell Yes for USDC.
    Ask,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderKind {
    /// Matches, then rests the remainder.
    Limit,
    /// Matches up to `price` as a worst price, never rests, returns unfilled escrow.
    Market,
    /// Rejected if it would cross; otherwise rests.
    PostOnly,
}

/// A resting order. A slot with `qty == 0` is empty.
#[zero_copy]
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Order {
    pub order_id: u64,
    /// Remaining whole tokens.
    pub qty: u64,
    /// Cents.
    pub price: u8,
    /// Index into `OrderBook::seats`.
    pub seat: u8,
    pub _padding: [u8; 6],
}

/// A trader's seat inside the book. A seat with `owner == Pubkey::default()` is free. Locked
/// amounts are derived from the owner's resting orders.
#[zero_copy]
#[derive(Debug, Default, PartialEq, Eq)]
pub struct OpenOrders {
    pub owner: Pubkey,
    /// Yes base units the owner can withdraw with `settle_funds`.
    pub free_yes: u64,
    /// USDC base units the owner can withdraw with `settle_funds`.
    pub free_usdc: u64,
}
