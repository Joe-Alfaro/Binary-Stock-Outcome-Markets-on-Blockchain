//! R47, on-chain part: one `LatestPrice` per (signer, ticker), overwritten in place with a
//! strictly increasing `publish_time`, written only by registered signers.

mod common;

use common::*;
use meridian_oracle::{LatestPrice, OracleError, PriceInput, Session, MAX_FUTURE_SECS};
use solana_signer::Signer;

#[test]
fn first_publish_creates_the_latest_price_account() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let input = PriceInput {
        price: 2_514_321,
        conf: 1_250,
        expo: -4,
        publish_time: h.now() - 3,
        session: Session::Regular,
        official_close: false,
    };

    h.publish_latest(&relay, AAPL, input).unwrap();

    let latest: LatestPrice = h
        .fetch(&latest_pda(&relay.pubkey(), AAPL))
        .expect("latest price exists");
    assert_eq!(latest.signer, relay.pubkey());
    assert_eq!(latest.ticker, AAPL);
    assert_eq!(latest.price, input.price);
    assert_eq!(latest.conf, input.conf);
    assert_eq!(latest.expo, input.expo);
    assert_eq!(latest.publish_time, input.publish_time);
    assert_eq!(latest.session, Session::Regular);
    assert!(!latest.official_close);
}

#[test]
fn a_newer_price_overwrites_in_place_with_flat_rent() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let address = latest_pda(&relay.pubkey(), AAPL);
    let t0 = h.now() - 60;
    h.publish_latest(&relay, AAPL, regular(25_000, t0)).unwrap();
    let first = h.svm.get_account(&address).unwrap();

    h.publish_latest(&relay, AAPL, regular(25_050, t0 + 60))
        .unwrap();

    let second = h.svm.get_account(&address).unwrap();
    assert_eq!(second.lamports, first.lamports, "rent must stay flat");
    assert_eq!(second.data.len(), first.data.len());
    let latest: LatestPrice = h.fetch(&address).unwrap();
    assert_eq!(latest.price, 25_050);
    assert_eq!(latest.publish_time, t0 + 60);
}

#[test]
fn an_equal_or_older_publish_time_is_rejected() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let address = latest_pda(&relay.pubkey(), AAPL);
    let t = h.now() - 10;
    h.publish_latest(&relay, AAPL, regular(25_000, t)).unwrap();
    let stored = h.account_data(&address).unwrap();

    let same = h.publish_latest(&relay, AAPL, regular(25_100, t));
    assert_oracle_error(same, OracleError::PublishTimeNotIncreasing);
    let older = h.publish_latest(&relay, AAPL, regular(25_100, t - 1));
    assert_oracle_error(older, OracleError::PublishTimeNotIncreasing);

    assert_eq!(h.account_data(&address).unwrap(), stored);
}

#[test]
fn a_far_future_publish_time_is_rejected() {
    // Without this, one bad timestamp would freeze the account, since later updates must have a
    // greater publish_time.
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let now = h.now();
    h.publish_latest(&relay, AAPL, regular(25_000, now + MAX_FUTURE_SECS))
        .unwrap();

    let result = h.publish_latest(&relay, AAPL, regular(25_000, now + MAX_FUTURE_SECS + 1));

    assert_oracle_error(result, OracleError::PublishTimeInFuture);
}

#[test]
fn unregistered_signer_is_rejected() {
    let mut h = Harness::with_registry();
    let stranger = h.new_funded();
    let now = h.now();

    let result = h.publish_latest(&stranger, AAPL, regular(25_000, now));

    assert_oracle_error(result, OracleError::UnregisteredSigner);
    assert!(h
        .account_data(&latest_pda(&stranger.pubkey(), AAPL))
        .is_none());
}

#[test]
fn there_is_one_account_per_signer_and_ticker() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let other_relay = h.new_relay();
    let now = h.now();

    h.publish_latest(&relay, AAPL, regular(25_000, now))
        .unwrap();
    h.publish_latest(&relay, MSFT, regular(41_000, now))
        .unwrap();
    h.publish_latest(&other_relay, AAPL, regular(25_003, now))
        .unwrap();

    let (mine, theirs) = (relay.pubkey(), other_relay.pubkey());
    let read = |signer, ticker| -> LatestPrice { h.fetch(&latest_pda(signer, ticker)).unwrap() };
    assert_eq!(read(&mine, AAPL).price, 25_000);
    assert_eq!(read(&mine, MSFT).price, 41_000);
    assert_eq!(read(&theirs, AAPL).price, 25_003);
}

#[test]
fn all_seven_tickers_update_in_one_transaction() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let now = h.now();
    let instructions: Vec<_> = TICKERS
        .iter()
        .enumerate()
        .map(|(i, ticker)| {
            ix_publish_latest(&relay.pubkey(), *ticker, regular(10_000 + i as i64, now))
        })
        .collect();

    h.send(&instructions, &[&relay]).unwrap();

    for (i, ticker) in TICKERS.iter().enumerate() {
        let latest: LatestPrice = h.fetch(&latest_pda(&relay.pubkey(), *ticker)).unwrap();
        assert_eq!(latest.ticker, *ticker);
        assert_eq!(latest.price, 10_000 + i as i64);
    }
}
