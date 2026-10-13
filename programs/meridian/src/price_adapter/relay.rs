//! `MeridianRelay`: the canonical `CloseRecord` for the slot's signer, ticker and day.

use anchor_lang::prelude::*;
use meridian_math::{NormalizedPrice, Session, MAX_EXPO, MIN_EXPO};
use meridian_oracle::{CloseRecord, PriceInput};

use crate::errors::MeridianError;
use crate::state::Market;

/// The record's one or two updates. The record must be the canonical PDA for `signer` and the
/// market's ticker and day, and stamped with the market's `close_ts`.
pub fn updates(
    account: &AccountInfo,
    signer: &Pubkey,
    market: &Market,
) -> Result<Vec<NormalizedPrice>> {
    let record = load_close_record(account, signer, market)?;
    require!(
        record.close_ts == market.close_ts,
        MeridianError::CloseTsMismatch
    );
    let mut updates = vec![normalize(&record, &record.first)?];
    if let Some(second) = &record.second {
        updates.push(normalize(&record, second)?);
    }
    Ok(updates)
}

fn normalize(record: &CloseRecord, input: &PriceInput) -> Result<NormalizedPrice> {
    require!(
        (MIN_EXPO..=MAX_EXPO).contains(&input.expo),
        MeridianError::NoValidClosePrice
    );
    Ok(NormalizedPrice {
        ticker: record.ticker,
        price: input.price,
        conf: input.conf,
        expo: input.expo,
        publish_time: input.publish_time,
        session: match input.session {
            meridian_oracle::Session::Regular => Session::Regular,
            meridian_oracle::Session::OutsideRegular => Session::OutsideRegular,
        },
        official_close: input.official_close,
    })
}

/// The canonical `CloseRecord` for `signer` and the market's ticker and day, or
/// `InvalidOracleAccount` for any other account: wrong owner, wrong type, wrong address or not
/// yet published.
fn load_close_record(
    account: &AccountInfo,
    signer: &Pubkey,
    market: &Market,
) -> Result<CloseRecord> {
    require_keys_eq!(
        *account.owner,
        meridian_oracle::ID,
        MeridianError::InvalidOracleAccount
    );
    let data = account.try_borrow_data()?;
    let record = CloseRecord::try_deserialize(&mut &data[..])
        .map_err(|_| error!(MeridianError::InvalidOracleAccount))?;
    let trading_day = market.trading_day.to_le_bytes();
    // The canonical address, not one rebuilt from the record's own `bump` field.
    let (expected, _) = Pubkey::find_program_address(
        &[
            meridian_oracle::CLOSE_SEED,
            signer.as_ref(),
            &market.ticker,
            &trading_day,
        ],
        &meridian_oracle::ID,
    );
    require!(
        expected == account.key()
            && record.signer == *signer
            && record.ticker == market.ticker
            && record.trading_day == market.trading_day,
        MeridianError::InvalidOracleAccount
    );
    Ok(record)
}
