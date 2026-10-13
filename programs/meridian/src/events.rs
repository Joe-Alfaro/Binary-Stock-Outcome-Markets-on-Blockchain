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
