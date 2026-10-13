//! Turns each oracle kind's inputs into `NormalizedPrice` updates (R32, ARCHITECTURE §5.3).
//!
//! Each adapter validates its own inputs (owner, type, feed, verification) and maps them across.
//! The closing-price rule only ever sees the resulting `NormalizedPrice`s, so settlement is the
//! same whichever kind a slot is configured with.

pub mod data_streams;
pub mod pyth;
pub mod relay;

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::{Config, Market};

/// The configured feed or stream ID for the market's ticker, in `Config.tickers` order.
fn feed_id(config: &Config, feed_ids: &[[u8; 32]], market: &Market) -> Result<[u8; 32]> {
    let index = config
        .tickers
        .iter()
        .position(|t| *t == market.ticker)
        .ok_or(MeridianError::UnknownTicker)?;
    Ok(feed_ids[index])
}
