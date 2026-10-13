//! `Pyth`: price update accounts posted through the Pyth Solana receiver (ARCHITECTURE §5.7).
//!
//! The account layout is the receiver's `PriceUpdateV2`, read directly so no Pyth crate is needed
//! (pyth-crosschain `pyth_solana_receiver_sdk/src/price_update.rs` and
//! `pythnet_sdk/src/messages.rs`). The slot's `verifier_program` is the receiver program that must
//! own every update account.

use anchor_lang::prelude::*;
use meridian_math::{NormalizedPrice, Session, MAX_EXPO, MIN_EXPO};

use super::feed_id;
use crate::errors::MeridianError;
use crate::state::{Config, Market, OracleSlot};

/// `sha256("account:PriceUpdateV2")[..8]`.
const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd];

#[derive(AnchorDeserialize)]
enum VerificationLevel {
    Partial { num_signatures: u8 },
    Full,
}

#[derive(AnchorDeserialize)]
struct PriceFeedMessage {
    feed_id: [u8; 32],
    price: i64,
    conf: u64,
    exponent: i32,
    publish_time: i64,
    _prev_publish_time: i64,
    _ema_price: i64,
    _ema_conf: u64,
}

#[derive(AnchorDeserialize)]
struct PriceUpdateV2 {
    _write_authority: Pubkey,
    verification_level: VerificationLevel,
    price_message: PriceFeedMessage,
    _posted_slot: u64,
}

/// One `NormalizedPrice` per update account, `first` then `rest`. Every account must be a
/// `PriceUpdateV2` owned by the slot's receiver, for the ticker's configured feed, and verified at
/// least to the slot's level.
pub fn updates(
    first: &AccountInfo,
    rest: &[AccountInfo],
    slot: &OracleSlot,
    config: &Config,
    market: &Market,
) -> Result<Vec<NormalizedPrice>> {
    // A zeroed slot names no receiver and fails safe.
    require!(
        slot.verifier_program != Pubkey::default(),
        MeridianError::InvalidOracleAccount
    );
    let feed = feed_id(config, &slot.feed_ids, market)?;
    let mut updates = vec![normalize(first, slot, &feed, market)?];
    for account in rest {
        updates.push(normalize(account, slot, &feed, market)?);
    }
    Ok(updates)
}

fn normalize(
    account: &AccountInfo,
    slot: &OracleSlot,
    feed: &[u8; 32],
    market: &Market,
) -> Result<NormalizedPrice> {
    require_keys_eq!(
        *account.owner,
        slot.verifier_program,
        MeridianError::InvalidOracleAccount
    );
    let data = account.try_borrow_data()?;
    require!(
        data.starts_with(&PRICE_UPDATE_V2_DISCRIMINATOR),
        MeridianError::InvalidOracleAccount
    );
    // `deserialize` rather than `try_from_slice`: the receiver zero-pads the account.
    let update = PriceUpdateV2::deserialize(&mut &data[8..])
        .map_err(|_| error!(MeridianError::InvalidOracleAccount))?;
    require!(
        meets_level(&update.verification_level, slot.min_verification_level),
        MeridianError::InvalidOracleAccount
    );
    let message = update.price_message;
    require!(
        message.feed_id == *feed,
        MeridianError::InvalidOracleAccount
    );
    require!(
        (MIN_EXPO..=MAX_EXPO).contains(&message.exponent),
        MeridianError::NoValidClosePrice
    );
    Ok(NormalizedPrice {
        ticker: market.ticker,
        price: message.price,
        conf: message.conf,
        expo: message.exponent,
        publish_time: message.publish_time,
        // Pyth equity feeds carry no session flag. The feeds only publish in regular hours, so
        // the session is the market's own trading window, which is 09:30 to the close outside
        // demo mode. A price after the close is after-hours.
        session: if (market.trading_open_ts..=market.close_ts).contains(&message.publish_time) {
            Session::Regular
        } else {
            Session::OutsideRegular
        },
        // Pyth labels no official close, so it settles through shapes 2 and 3.
        official_close: false,
    })
}

/// `min_verification_level` 0 requires `Full`, so a zeroed slot fails safe. Any other value `n`
/// accepts `Full` or a partial verification with at least `n` guardian signatures.
fn meets_level(level: &VerificationLevel, min: u8) -> bool {
    match level {
        VerificationLevel::Full => true,
        VerificationLevel::Partial { num_signatures } => min != 0 && *num_signatures >= min,
    }
}
