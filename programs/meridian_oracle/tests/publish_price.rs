//! R30: `publish_price` accepts only registered signers, is append-only per
//! `(signer, ticker, publish_time)`, and rejects a `publish_time` more than 60 s in the future.

mod common;

use common::*;
use meridian_oracle::{OracleError, PriceInput, PriceUpdate, Session, MAX_FUTURE_SECS};
use solana_signer::Signer;

#[test]
fn registered_signer_publishes_a_price_update_with_every_field() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let input = PriceInput {
        price: 2_514_321,
        conf: 1_250,
        expo: -4,
        publish_time: CLOSE_TS - 1,
        session: Session::Regular,
        official_close: false,
    };

    h.publish_price(&relay, AAPL, input).unwrap();

    let address = price_pda(&relay.pubkey(), AAPL, input.publish_time);
    let update: PriceUpdate = h.fetch(&address).expect("price update exists");
    assert_eq!(update.signer, relay.pubkey());
    assert_eq!(update.ticker, AAPL);
    assert_eq!(update.price, input.price);
    assert_eq!(update.conf, input.conf);
    assert_eq!(update.expo, input.expo);
    assert_eq!(update.publish_time, input.publish_time);
    assert_eq!(update.session, Session::Regular);
    assert!(!update.official_close);
}

#[test]
fn stores_official_close_and_outside_regular_flags() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let after_hours = PriceInput {
        session: Session::OutsideRegular,
        ..regular(25_100, CLOSE_TS + 30)
    };

    h.publish_price(&relay, AAPL, official(25_000, CLOSE_TS))
        .unwrap();
    h.publish_price(&relay, AAPL, after_hours).unwrap();

    let close: PriceUpdate = h
        .fetch(&price_pda(&relay.pubkey(), AAPL, CLOSE_TS))
        .unwrap();
    assert!(close.official_close);
    let late: PriceUpdate = h
        .fetch(&price_pda(&relay.pubkey(), AAPL, CLOSE_TS + 30))
        .unwrap();
    assert_eq!(late.session, Session::OutsideRegular);
    assert!(!late.official_close);
}

#[test]
fn unregistered_signer_is_rejected() {
    let mut h = Harness::with_registry();
    let stranger = h.new_funded();
    let input = regular(25_000, CLOSE_TS - 1);

    let result = h.publish_price(&stranger, AAPL, input);

    assert_oracle_error(result, OracleError::UnregisteredSigner);
    assert!(h
        .account_data(&price_pda(&stranger.pubkey(), AAPL, input.publish_time))
        .is_none());
}

#[test]
fn second_write_to_the_same_key_fails_and_leaves_the_record_unchanged() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let address = price_pda(&relay.pubkey(), AAPL, CLOSE_TS - 1);
    h.publish_price(&relay, AAPL, regular(25_000, CLOSE_TS - 1))
        .unwrap();
    let before = h.account_data(&address).unwrap();

    let rewrite = h.publish_price(&relay, AAPL, regular(30_000, CLOSE_TS - 1));
    let replay = h.publish_price(&relay, AAPL, regular(25_000, CLOSE_TS - 1));

    assert!(
        rewrite.is_err(),
        "a different price for the same key must fail"
    );
    assert!(replay.is_err(), "the same price for the same key must fail");
    assert_eq!(h.account_data(&address).unwrap(), before);
}

#[test]
fn records_are_keyed_by_signer_ticker_and_publish_time() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let other_relay = h.new_relay();

    h.publish_price(&relay, AAPL, regular(25_000, CLOSE_TS - 1))
        .unwrap();
    h.publish_price(&relay, AAPL, regular(25_010, CLOSE_TS + 1))
        .unwrap();
    h.publish_price(&relay, MSFT, regular(41_000, CLOSE_TS - 1))
        .unwrap();
    h.publish_price(&other_relay, AAPL, regular(25_001, CLOSE_TS - 1))
        .unwrap();

    let (mine, theirs) = (relay.pubkey(), other_relay.pubkey());
    let read =
        |signer, ticker, t| -> PriceUpdate { h.fetch(&price_pda(signer, ticker, t)).unwrap() };
    assert_eq!(read(&mine, AAPL, CLOSE_TS - 1).price, 25_000);
    assert_eq!(read(&mine, AAPL, CLOSE_TS + 1).price, 25_010);
    assert_eq!(read(&mine, MSFT, CLOSE_TS - 1).price, 41_000);
    assert_eq!(read(&theirs, AAPL, CLOSE_TS - 1).price, 25_001);
}

#[test]
fn rejects_an_account_that_is_not_the_canonical_pda() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let input = regular(25_000, CLOSE_TS - 1);
    let wrong = price_pda(&relay.pubkey(), AAPL, CLOSE_TS - 2);

    let ix = ix_publish_price_at(&relay.pubkey(), AAPL, input, wrong);
    let result = h.send(&[ix], &[&relay]);

    assert!(
        result.is_err(),
        "a PriceUpdate at a non-canonical address must fail"
    );
    assert!(h.account_data(&wrong).is_none());
    // Control: the canonical address works.
    h.publish_price(&relay, AAPL, input).unwrap();
}

#[test]
fn publish_time_exactly_60_seconds_ahead_is_accepted() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let publish_time = h.now() + MAX_FUTURE_SECS;

    h.publish_price(&relay, AAPL, regular(25_000, publish_time))
        .unwrap();

    assert!(h
        .fetch::<PriceUpdate>(&price_pda(&relay.pubkey(), AAPL, publish_time))
        .is_some());
}

#[test]
fn publish_time_more_than_60_seconds_ahead_is_rejected() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let publish_time = h.now() + MAX_FUTURE_SECS + 1;

    let result = h.publish_price(&relay, AAPL, regular(25_000, publish_time));

    assert_oracle_error(result, OracleError::PublishTimeInFuture);
    assert!(h
        .account_data(&price_pda(&relay.pubkey(), AAPL, publish_time))
        .is_none());
}

#[test]
fn past_publish_times_are_accepted() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    h.set_now(CLOSE_TS + 3_600);

    h.publish_price(&relay, AAPL, regular(25_000, CLOSE_TS - 1))
        .unwrap();
}
