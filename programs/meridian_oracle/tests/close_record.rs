//! R31, oracle side: one write-once `CloseRecord` per (signer, ticker, trading day), holding
//! either an official close, an exact-timestamp close or an interpolation pair, built only from
//! the signer's own `PriceUpdate`s for that ticker. Settlement reads only this record, so a
//! caller can't choose which updates settle a market.

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountSerialize, Discriminator};
use common::*;
use meridian_oracle::{CloseRecord, CloseShape, OracleError, PriceUpdate, Session};
use solana_keypair::Keypair;
use solana_signer::Signer;

/// Publishes `input` for `ticker` and returns the `PriceUpdate` address.
fn publish(
    h: &mut Harness,
    relay: &Keypair,
    ticker: meridian_oracle::Ticker,
    input: meridian_oracle::PriceInput,
) -> Pubkey {
    h.publish_price(relay, ticker, input).unwrap();
    price_pda(&relay.pubkey(), ticker, input.publish_time)
}

fn record(h: &Harness, relay: &Keypair) -> CloseRecord {
    h.fetch(&close_pda(&relay.pubkey(), AAPL, TRADING_DAY))
        .expect("close record exists")
}

#[test]
fn official_close_record_holds_the_flagged_update() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let input = official(25_000, CLOSE_TS + 5);
    let update = publish(&mut h, &relay, AAPL, input);

    h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, update, None)
        .unwrap();

    let record = record(&h, &relay);
    assert_eq!(record.signer, relay.pubkey());
    assert_eq!(record.ticker, AAPL);
    assert_eq!(record.trading_day, TRADING_DAY);
    assert_eq!(record.close_ts, CLOSE_TS);
    assert_eq!(record.shape, CloseShape::OfficialClose);
    assert_eq!(record.first, input);
    assert_eq!(record.second, None);
}

#[test]
fn exact_timestamp_record_holds_the_update_at_close() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let input = regular(25_000, CLOSE_TS);
    let update = publish(&mut h, &relay, AAPL, input);

    h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, update, None)
        .unwrap();

    let record = record(&h, &relay);
    assert_eq!(record.shape, CloseShape::ExactTimestamp);
    assert_eq!(record.first, input);
    assert_eq!(record.second, None);
}

#[test]
fn interpolation_record_holds_both_sides_of_the_close() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let before = regular(25_000, CLOSE_TS - 1);
    let after = regular(25_020, CLOSE_TS + 1);
    let first = publish(&mut h, &relay, AAPL, before);
    let second = publish(&mut h, &relay, AAPL, after);

    h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, first, Some(second))
        .unwrap();

    let record = record(&h, &relay);
    assert_eq!(record.shape, CloseShape::Interpolation);
    assert_eq!(record.first, before);
    assert_eq!(record.second, Some(after));
    assert_eq!(record.close_ts, CLOSE_TS);
}

#[test]
fn close_record_is_write_once() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let close = publish(&mut h, &relay, AAPL, official(25_000, CLOSE_TS + 5));
    let before = publish(&mut h, &relay, AAPL, regular(24_000, CLOSE_TS - 1));
    let after = publish(&mut h, &relay, AAPL, regular(24_100, CLOSE_TS + 1));
    let exact = publish(&mut h, &relay, AAPL, regular(26_000, CLOSE_TS));
    h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, close, None)
        .unwrap();
    let address = close_pda(&relay.pubkey(), AAPL, TRADING_DAY);
    let stored = h.account_data(&address).unwrap();

    let replay = h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, close, None);
    let pair = h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, before, Some(after));
    let at_close = h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, exact, None);

    assert!(replay.is_err(), "rewriting the same close must fail");
    assert!(
        pair.is_err(),
        "replacing an official close with a pair must fail"
    );
    assert!(
        at_close.is_err(),
        "replacing an official close with another shape must fail"
    );
    assert_eq!(h.account_data(&address).unwrap(), stored);
}

#[test]
fn an_interpolation_record_cant_be_replaced_by_a_later_official_close() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let before = publish(&mut h, &relay, AAPL, regular(24_000, CLOSE_TS - 1));
    let after = publish(&mut h, &relay, AAPL, regular(24_100, CLOSE_TS + 1));
    h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, before, Some(after))
        .unwrap();
    h.set_now(CLOSE_TS + 300);
    let late_close = publish(&mut h, &relay, AAPL, official(25_000, CLOSE_TS + 200));

    let result = h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, late_close, None);

    assert!(result.is_err());
    assert_eq!(record(&h, &relay).shape, CloseShape::Interpolation);
}

#[test]
fn each_signer_has_its_own_record_for_a_ticker_and_day() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let other_relay = h.new_relay();
    let mine = publish(&mut h, &relay, AAPL, official(25_000, CLOSE_TS + 5));
    let theirs = publish(&mut h, &other_relay, AAPL, official(25_002, CLOSE_TS + 6));

    h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, mine, None)
        .unwrap();
    h.publish_close(&other_relay, AAPL, TRADING_DAY, CLOSE_TS, theirs, None)
        .unwrap();

    assert_eq!(record(&h, &relay).first.price, 25_000);
    assert_eq!(record(&h, &other_relay).first.price, 25_002);
}

#[test]
fn records_for_other_days_and_tickers_are_separate() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let aapl = publish(&mut h, &relay, AAPL, official(25_000, CLOSE_TS + 5));
    let msft = publish(&mut h, &relay, MSFT, official(41_000, CLOSE_TS + 5));
    let next_close = CLOSE_TS + 86_400;
    h.set_now(next_close + 120);
    let next_day = publish(&mut h, &relay, AAPL, official(25_500, next_close + 5));

    h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, aapl, None)
        .unwrap();
    h.publish_close(&relay, MSFT, TRADING_DAY, CLOSE_TS, msft, None)
        .unwrap();
    h.publish_close(&relay, AAPL, TRADING_DAY + 1, next_close, next_day, None)
        .unwrap();

    let msft_record: CloseRecord = h
        .fetch(&close_pda(&relay.pubkey(), MSFT, TRADING_DAY))
        .unwrap();
    let next_record: CloseRecord = h
        .fetch(&close_pda(&relay.pubkey(), AAPL, TRADING_DAY + 1))
        .unwrap();
    assert_eq!(record(&h, &relay).first.price, 25_000);
    assert_eq!(msft_record.first.price, 41_000);
    assert_eq!(next_record.first.price, 25_500);
    assert_eq!(next_record.close_ts, next_close);
}

#[test]
fn unregistered_signer_cannot_write_a_close_record() {
    let mut h = Harness::with_registry();
    let admin = h.admin.insecure_clone();
    let relay = h.new_relay();
    let update = publish(&mut h, &relay, AAPL, official(25_000, CLOSE_TS + 5));
    h.remove_signer(&admin, relay.pubkey()).unwrap();

    let result = h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, update, None);

    assert_oracle_error(result, OracleError::UnregisteredSigner);
    assert!(h
        .account_data(&close_pda(&relay.pubkey(), AAPL, TRADING_DAY))
        .is_none());
}

#[test]
fn another_signers_updates_are_rejected() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let other_relay = h.new_relay();
    let theirs = publish(&mut h, &other_relay, AAPL, official(30_000, CLOSE_TS + 5));
    let before = publish(&mut h, &relay, AAPL, regular(25_000, CLOSE_TS - 1));
    let their_after = publish(&mut h, &other_relay, AAPL, regular(30_000, CLOSE_TS + 1));

    let single = h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, theirs, None);
    assert_oracle_error(single, OracleError::UpdateMismatch);
    let mixed = h.publish_close(
        &relay,
        AAPL,
        TRADING_DAY,
        CLOSE_TS,
        before,
        Some(their_after),
    );
    assert_oracle_error(mixed, OracleError::UpdateMismatch);
    assert!(h
        .account_data(&close_pda(&relay.pubkey(), AAPL, TRADING_DAY))
        .is_none());
}

#[test]
fn updates_for_another_ticker_are_rejected() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let msft = publish(&mut h, &relay, MSFT, official(41_000, CLOSE_TS + 5));
    let before = publish(&mut h, &relay, AAPL, regular(25_000, CLOSE_TS - 1));
    let msft_after = publish(&mut h, &relay, MSFT, regular(41_000, CLOSE_TS + 1));

    let single = h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, msft, None);
    assert_oracle_error(single, OracleError::UpdateMismatch);
    let mixed = h.publish_close(
        &relay,
        AAPL,
        TRADING_DAY,
        CLOSE_TS,
        before,
        Some(msft_after),
    );
    assert_oracle_error(mixed, OracleError::UpdateMismatch);
}

#[test]
fn a_forged_update_not_owned_by_the_oracle_is_rejected() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let genuine = publish(&mut h, &relay, AAPL, official(25_000, CLOSE_TS + 5));
    // Same bytes as a genuine PriceUpdate, but owned by the system program.
    let forged_data = {
        let update = PriceUpdate {
            price: 99_999,
            ..h.fetch::<PriceUpdate>(&genuine).unwrap()
        };
        let mut data = Vec::new();
        update.try_serialize(&mut data).unwrap();
        assert_eq!(&data[..8], PriceUpdate::DISCRIMINATOR);
        data
    };
    let forged = Keypair::new().pubkey();
    let mut account = h.svm.get_account(&genuine).unwrap();
    account.data = forged_data;
    account.owner = Pubkey::default();
    h.svm.set_account(forged, account).unwrap();

    let result = h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, forged, None);

    assert!(
        result.is_err(),
        "an update not owned by meridian_oracle must be rejected"
    );
    assert!(h
        .account_data(&close_pda(&relay.pubkey(), AAPL, TRADING_DAY))
        .is_none());
    // Control: the genuine update works.
    h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, genuine, None)
        .unwrap();
}

#[test]
fn a_latest_price_account_is_not_a_close_input() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let genuine = publish(&mut h, &relay, AAPL, official(25_000, CLOSE_TS + 5));
    h.publish_latest(&relay, AAPL, official(30_000, CLOSE_TS + 5))
        .unwrap();
    let latest = latest_pda(&relay.pubkey(), AAPL);

    let result = h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, latest, None);

    assert!(
        result.is_err(),
        "a LatestPrice must not be accepted as a PriceUpdate"
    );
    assert!(h
        .account_data(&close_pda(&relay.pubkey(), AAPL, TRADING_DAY))
        .is_none());
    h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, genuine, None)
        .unwrap();
}

#[test]
fn rejects_a_record_at_a_non_canonical_address() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let update = publish(&mut h, &relay, AAPL, official(25_000, CLOSE_TS + 5));
    let wrong = close_pda(&relay.pubkey(), AAPL, TRADING_DAY + 1);

    let ix = ix_publish_close_at(
        &relay.pubkey(),
        AAPL,
        TRADING_DAY,
        CLOSE_TS,
        update,
        None,
        wrong,
    );
    let result = h.send(&[ix], &[&relay]);

    assert!(
        result.is_err(),
        "a CloseRecord at a non-canonical address must fail"
    );
    assert!(h.account_data(&wrong).is_none());
    h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, update, None)
        .unwrap();
}

#[test]
fn a_single_unflagged_update_off_the_close_is_not_a_shape() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let early = publish(&mut h, &relay, AAPL, regular(25_000, CLOSE_TS - 30));
    let late = publish(&mut h, &relay, AAPL, regular(25_000, CLOSE_TS + 60));

    let result = h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, early, None);
    assert_oracle_error(result, OracleError::InvalidCloseShape);
    let result = h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, late, None);
    assert_oracle_error(result, OracleError::InvalidCloseShape);
}

#[test]
fn a_pair_must_straddle_the_close_in_order() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let early = publish(&mut h, &relay, AAPL, regular(25_000, CLOSE_TS - 60));
    let before = publish(&mut h, &relay, AAPL, regular(25_010, CLOSE_TS - 1));
    let after = publish(&mut h, &relay, AAPL, regular(25_020, CLOSE_TS + 1));
    let at_close = publish(&mut h, &relay, AAPL, regular(25_015, CLOSE_TS));

    let same_side = h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, early, Some(before));
    assert_oracle_error(same_side, OracleError::InvalidCloseShape);
    let reversed = h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, after, Some(before));
    assert_oracle_error(reversed, OracleError::InvalidCloseShape);
    let touches_close =
        h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, before, Some(at_close));
    assert_oracle_error(touches_close, OracleError::InvalidCloseShape);
    assert!(h
        .account_data(&close_pda(&relay.pubkey(), AAPL, TRADING_DAY))
        .is_none());
}

#[test]
fn an_after_hours_update_keeps_its_session_in_the_record() {
    // The oracle copies values verbatim; settlement rejects after-hours inputs (R33). This pins
    // that `session` survives the copy, so settlement can see it.
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let before = regular(25_000, CLOSE_TS - 1);
    let after = meridian_oracle::PriceInput {
        session: Session::OutsideRegular,
        ..regular(25_500, CLOSE_TS + 1)
    };
    let first = publish(&mut h, &relay, AAPL, before);
    let second = publish(&mut h, &relay, AAPL, after);

    h.publish_close(&relay, AAPL, TRADING_DAY, CLOSE_TS, first, Some(second))
        .unwrap();

    assert_eq!(
        record(&h, &relay).second.unwrap().session,
        Session::OutsideRegular
    );
}
