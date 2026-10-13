//! `settle_market`: R35 settle market, R33 closing-price rule and R34 staleness and confidence
//! on-chain, R31 settlement inputs can't be gamed, R9 outcome immutability.

mod common;
mod settlement_common;

use anchor_lang::prelude::Pubkey;
use common::*;
use meridian::errors::MeridianError;
use meridian::events::MarketSettled;
use meridian::state::*;
use meridian_oracle::{PriceInput, Session};
use settlement_common::*;
use solana_signer::Signer;

/// Initialized config, one AAPL market at `STRIKE` ($690.00), clock at 4:12 PM.
fn setup() -> (Env, MarketKeys) {
    let mut env = Env::initialized();
    let m = env.create_market(STRIKE);
    env.set_time(T_SETTLE);
    (env, m)
}

fn assert_settled(env: &Env, m: &MarketKeys, outcome: Outcome, price: i64, source: SettleSource) {
    let market = env.market(m);
    assert_eq!(market.status, MarketStatus::Settled);
    assert_eq!(
        market.outcome,
        Some(outcome),
        "outcome for strike {}",
        m.strike
    );
    assert_eq!(market.settle_price, price);
    assert_eq!(market.settle_source, source);
}

fn assert_open(env: &Env, m: &MarketKeys) {
    let market = env.market(m);
    assert_eq!(market.status, MarketStatus::Open);
    assert_eq!(market.outcome, None);
    assert_eq!(env.ticker_day(m).status, TickerDayStatus::Open);
}

/// A fresh AAPL `STRIKE` market settles from a slot-1 record built from `first` and `second`.
fn assert_accepted(first: PriceInput, second: Option<PriceInput>) {
    let (mut env, m) = setup();
    let record = env.relay_close(first, second);
    assert_ok(env.settle(&m, record));
    assert_eq!(env.market(&m).status, MarketStatus::Settled);
}

fn assert_settle_err(first: PriceInput, second: Option<PriceInput>, err: MeridianError) {
    let (mut env, m) = setup();
    let record = env.relay_close(first, second);
    assert_meridian_err(env.settle(&m, record), err);
    assert_open(&env, &m);
}

fn assert_settles(
    first: PriceInput,
    second: Option<PriceInput>,
    outcome: Outcome,
    settle_price: i64,
) {
    let (mut env, m) = setup();
    let record = env.relay_close(first, second);
    assert_ok(env.settle(&m, record));
    assert_settled(&env, &m, outcome, settle_price, SettleSource::OracleSlot0);
}

// ---- R35 settle market ----------------------------------------------------------------------

#[test]
fn r35_settle_market_fails_before_close_ts() {
    let (mut env, m) = setup();
    let record = env.relay_official_close(69_100);
    env.set_time(T_CLOSE - 1);
    assert_meridian_err(env.settle(&m, record), MeridianError::SettleTooEarly);
    assert_open(&env, &m);
}

#[test]
fn r35_settle_market_succeeds_at_close_ts() {
    let (mut env, m) = setup();
    let record = env.relay_close(regular(69_100, T_CLOSE), None);
    env.set_time(T_CLOSE);
    assert_ok(env.settle(&m, record));
    assert_settled(&env, &m, Outcome::Yes, 69_100, SettleSource::OracleSlot0);
}

#[test]
fn r35_settle_market_writes_outcome_price_source_and_the_ticker_day() {
    let (mut env, m) = setup();
    let record = env.relay_official_close(68_950);
    assert_ok(env.settle(&m, record));
    assert_settled(&env, &m, Outcome::No, 68_950, SettleSource::OracleSlot0);

    let day = env.ticker_day(&m);
    assert_eq!(day.status, TickerDayStatus::Final);
    assert_eq!(day.settle_price, 68_950);
    assert_eq!(day.settle_expo, EXPO);
    assert_eq!(day.settle_source, SettleSource::OracleSlot0);
}

#[test]
fn r35_settle_market_emits_market_settled() {
    let (mut env, m) = setup();
    let record = env.relay_official_close(69_100);
    let meta = assert_ok(env.settle(&m, record));
    let settled = events::<MarketSettled>(&meta);
    assert_eq!(settled.len(), 1, "exactly one MarketSettled");
    let e = &settled[0];
    assert_eq!(e.market, m.market);
    assert_eq!(e.ticker, ticker("AAPL"));
    assert_eq!(e.trading_day, DAY);
    assert_eq!(e.strike, STRIKE);
    assert_eq!(e.outcome, Outcome::Yes);
    assert_eq!(e.settle_price, 69_100);
    assert_eq!(e.settle_expo, EXPO);
    assert_eq!(e.settle_source, SettleSource::OracleSlot0);
}

#[test]
fn r35_second_settle_market_call_fails() {
    let (mut env, m) = setup();
    let record = env.relay_official_close(69_100);
    assert_ok(env.settle(&m, record));
    let before = settled_fields(&env.market(&m));
    env.set_time(T_SETTLE + 60);
    assert_meridian_err(env.settle(&m, record), MeridianError::MarketSettled);
    assert_eq!(settled_fields(&env.market(&m)), before);
}

#[test]
fn r35_settle_market_works_while_paused() {
    let (mut env, m) = setup();
    let record = env.relay_official_close(69_100);
    env.pause();
    assert_ok(env.settle(&m, record));
    assert_settled(&env, &m, Outcome::Yes, 69_100, SettleSource::OracleSlot0);
}

// ---- R33 closing-price rule on-chain --------------------------------------------------------

#[test]
fn r33_official_close_at_above_and_below_strike() {
    assert_settles(official(69_000, T_CLOSE), None, Outcome::Yes, 69_000);
    assert_settles(official(69_001, T_CLOSE), None, Outcome::Yes, 69_001);
    assert_settles(official(68_999, T_CLOSE), None, Outcome::No, 68_999);
}

#[test]
fn r33_official_close_published_after_close_is_accepted() {
    // The official close is often stamped a little after 4:00 PM.
    assert_settles(official(69_050, T_CLOSE + 45), None, Outcome::Yes, 69_050);
}

#[test]
fn r33_exact_timestamp_at_above_and_below_strike() {
    assert_settles(regular(69_000, T_CLOSE), None, Outcome::Yes, 69_000);
    assert_settles(regular(69_001, T_CLOSE), None, Outcome::Yes, 69_001);
    assert_settles(regular(68_999, T_CLOSE), None, Outcome::No, 68_999);
}

#[test]
fn r33_interpolation_at_above_and_below_strike() {
    // Symmetric pair around close: the closing price is the midpoint.
    let pair = |p1, p2| (regular(p1, T_BEFORE), Some(regular(p2, T_AFTER)));
    let (a, b) = pair(68_990, 69_010);
    assert_settles(a, b, Outcome::Yes, 69_000);
    let (a, b) = pair(68_990, 69_012);
    assert_settles(a, b, Outcome::Yes, 69_001);
    let (a, b) = pair(68_990, 69_008);
    assert_settles(a, b, Outcome::No, 68_999);
}

#[test]
fn r33_interpolation_compares_exactly_not_with_the_rounded_price() {
    // (68_999 × 100 + 69_000 × 200) / 300 = 68_999.67: rounds to 69_000 for display, but the
    // exact value is below the strike, so No wins.
    let (mut env, m) = setup();
    let record = env.relay_close(
        regular(68_999, T_CLOSE - 200),
        Some(regular(69_000, T_CLOSE + 100)),
    );
    assert_ok(env.settle(&m, record));
    assert_settled(&env, &m, Outcome::No, 69_000, SettleSource::OracleSlot0);
}

#[test]
fn r33_exact_interpolated_comparison_holds_for_strikes_settled_after_the_first() {
    // Every strike settles from the same exact closing price, including strikes settled after
    // the ticker-day is final.
    let mut env = Env::initialized();
    let low = env.create_market(68_900);
    let at = env.create_market(STRIKE);
    env.set_time(T_SETTLE);
    let record = env.relay_close(
        regular(68_999, T_CLOSE - 200),
        Some(regular(69_000, T_CLOSE + 100)),
    );
    assert_ok(env.settle(&low, record));
    assert_ok(env.settle(&at, record));
    assert_eq!(env.market(&low).outcome, Some(Outcome::Yes));
    assert_eq!(env.market(&at).outcome, Some(Outcome::No));
    assert_eq!(env.market(&low).settle_price, env.market(&at).settle_price);
}

#[test]
fn r33_interpolation_window_start_boundary() {
    let after = Some(regular(69_100, T_AFTER));
    assert_accepted(regular(69_000, T_CLOSE - 300), after);
    assert_settle_err(
        regular(69_000, T_CLOSE - 301),
        after,
        MeridianError::StalePrice,
    );
}

#[test]
fn r33_interpolation_window_end_boundary() {
    let before = regular(69_000, T_BEFORE);
    assert_accepted(before, Some(regular(69_100, T_CLOSE + 300)));
    assert_settle_err(
        before,
        Some(regular(69_100, T_CLOSE + 301)),
        MeridianError::StalePrice,
    );
}

#[test]
fn r33_after_hours_update_is_rejected() {
    let after_hours = |p: PriceInput| PriceInput {
        session: Session::OutsideRegular,
        ..p
    };
    assert_settle_err(
        after_hours(official(69_100, T_CLOSE)),
        None,
        MeridianError::OutsideRegularSession,
    );
    assert_settle_err(
        regular(69_000, T_BEFORE),
        Some(after_hours(regular(69_100, T_AFTER))),
        MeridianError::OutsideRegularSession,
    );
}

#[test]
fn r33_non_positive_price_is_rejected() {
    assert_settle_err(official(0, T_CLOSE), None, MeridianError::NonPositivePrice);
    assert_settle_err(official(-1, T_CLOSE), None, MeridianError::NonPositivePrice);
    assert_settle_err(
        regular(-69_000, T_BEFORE),
        Some(regular(69_000, T_AFTER)),
        MeridianError::NonPositivePrice,
    );
}

// ---- R34 staleness and confidence -----------------------------------------------------------

#[test]
fn r34_a_3_59_30_price_is_accepted_when_settle_lands_at_4_12() {
    let (mut env, m) = setup();
    assert_eq!(env.now(), T_CLOSE + 12 * 60);
    let record = env.relay_close(regular(69_040, T_BEFORE), Some(regular(69_060, T_AFTER)));
    assert_ok(env.settle(&m, record));
    assert_settled(&env, &m, Outcome::Yes, 69_050, SettleSource::OracleSlot0);
}

#[test]
fn r34_staleness_is_measured_from_close_not_from_settle_time() {
    // Two days late, the same inputs still settle.
    let (mut env, m) = setup();
    env.set_time(T_CLOSE + 2 * 86_400);
    let record = env.relay_close(regular(69_040, T_BEFORE), Some(regular(69_060, T_AFTER)));
    assert_ok(env.settle(&m, record));
    assert_settled(&env, &m, Outcome::Yes, 69_050, SettleSource::OracleSlot0);
}

#[test]
fn r34_a_3_50_price_is_rejected_as_stale() {
    assert_settle_err(
        regular(69_000, T_CLOSE - 600),
        Some(regular(69_100, T_AFTER)),
        MeridianError::StalePrice,
    );
    assert_settle_err(
        official(69_000, T_CLOSE - 600),
        None,
        MeridianError::StalePrice,
    );
}

#[test]
fn r34_a_lone_4_01_price_is_rejected() {
    // The relay can't publish this shape, but settlement must not accept it either.
    assert_settle_err(
        regular(69_100, T_CLOSE + 60),
        None,
        MeridianError::NoValidClosePrice,
    );
}

#[test]
fn r34_wide_confidence_is_rejected() {
    // max_conf_bps = 50: conf / price may be at most 0.5%, so 345 / 69_000 passes and 346 fails.
    let with_conf = |conf| PriceInput {
        conf,
        ..official(69_000, T_CLOSE)
    };
    assert_accepted(with_conf(345), None);
    assert_settle_err(with_conf(346), None, MeridianError::ConfidenceTooWide);
    assert_settle_err(
        regular(69_000, T_BEFORE),
        Some(PriceInput {
            conf: 1_000,
            ..regular(69_100, T_AFTER)
        }),
        MeridianError::ConfidenceTooWide,
    );
}

#[test]
fn r34_max_staleness_secs_is_configurable() {
    let (mut env, m) = setup();
    env.update_config_with(meridian::UpdateConfigArgs {
        max_staleness_secs: Some(600),
        ..Default::default()
    });
    let record = env.relay_close(
        regular(69_000, T_CLOSE - 600),
        Some(regular(69_100, T_AFTER)),
    );
    assert_ok(env.settle(&m, record));

    let (mut env, m) = setup();
    env.update_config_with(meridian::UpdateConfigArgs {
        max_staleness_secs: Some(20),
        ..Default::default()
    });
    let record = env.relay_close(regular(69_000, T_BEFORE), Some(regular(69_100, T_AFTER)));
    assert_meridian_err(env.settle(&m, record), MeridianError::StalePrice);
}

#[test]
fn r34_max_conf_bps_is_configurable() {
    let (mut env, m) = setup();
    env.update_config_with(meridian::UpdateConfigArgs {
        max_conf_bps: Some(100),
        ..Default::default()
    });
    let record = env.relay_close(
        PriceInput {
            conf: 690,
            ..official(69_000, T_CLOSE)
        },
        None,
    );
    assert_ok(env.settle(&m, record));
}

#[test]
fn r34_record_built_for_another_close_ts_is_rejected() {
    let (mut env, m) = setup();
    let signer = env.relay_signer;
    let key = close_pda(&signer, ticker("AAPL"), DAY);
    // A record built for a 1:00 PM early close.
    let early = T_CLOSE - 3 * 3600;
    let record = Env::close_record_value(
        signer,
        ticker("AAPL"),
        DAY,
        early,
        official(69_100, early),
        None,
    );
    env.write_close_record_at(key, &record);
    assert_meridian_err(env.settle(&m, key), MeridianError::CloseTsMismatch);
    assert_open(&env, &m);
}

// ---- R31 settlement inputs can't be gamed ---------------------------------------------------

#[test]
fn r31_rejects_a_record_not_owned_by_the_oracle_program() {
    let (mut env, m) = setup();
    let canonical = env.relay_official_close(69_100);
    let data = env.raw(&canonical).data;
    for owner in [meridian::ID, Pubkey::new_unique()] {
        env.put_account(canonical, data.clone(), owner);
        assert_meridian_err(
            env.settle(&m, canonical),
            MeridianError::InvalidOracleAccount,
        );
    }
    // The same bytes, owned by the oracle program, at an address that isn't the record's PDA.
    let elsewhere = Pubkey::new_unique();
    env.put_account(elsewhere, data, meridian_oracle::ID);
    assert_meridian_err(
        env.settle(&m, elsewhere),
        MeridianError::InvalidOracleAccount,
    );
    // A record that doesn't exist yet.
    env.svm.set_account(canonical, Default::default()).unwrap();
    assert_meridian_err(
        env.settle(&m, canonical),
        MeridianError::InvalidOracleAccount,
    );
    assert_open(&env, &m);
}

#[test]
fn r31_rejects_a_record_from_an_unregistered_signer() {
    let (mut env, m) = setup();
    let stranger = Pubkey::new_unique();
    let record = env.write_close(
        stranger,
        ticker("AAPL"),
        DAY,
        official(69_100, T_CLOSE),
        None,
    );
    assert_meridian_err(env.settle(&m, record), MeridianError::InvalidOracleAccount);
    assert_open(&env, &m);
}

#[test]
fn r31_rejects_a_record_from_a_registered_signer_outside_the_slot() {
    let (mut env, m) = setup();
    let _slot_relay = env.load_oracle_with_relay();
    // A second registered relay publishes a valid close through the oracle program.
    let other = solana_keypair::Keypair::new();
    env.svm.airdrop(&other.pubkey(), 10_000_000_000).unwrap();
    let admin = env.admin.insecure_clone();
    let add = env.ix_oracle_add_signer(other.pubkey());
    assert_ok(env.send_one(add, &admin));
    let update = env.oracle_publish_price(&other, ticker("AAPL"), official(69_100, T_CLOSE));
    let record = env.oracle_publish_close(&other, ticker("AAPL"), update, None);

    assert_meridian_err(env.settle(&m, record), MeridianError::InvalidOracleAccount);
    assert_open(&env, &m);
}

#[test]
fn r31_rejects_a_record_for_the_wrong_ticker_or_day() {
    let (mut env, m) = setup();
    let signer = env.relay_signer;
    let msft = env.write_close(signer, ticker("MSFT"), DAY, official(69_100, T_CLOSE), None);
    assert_meridian_err(env.settle(&m, msft), MeridianError::InvalidOracleAccount);
    let yesterday = env.write_close(
        signer,
        ticker("AAPL"),
        PREV_DAY,
        official(69_100, T_CLOSE),
        None,
    );
    assert_meridian_err(
        env.settle(&m, yesterday),
        MeridianError::InvalidOracleAccount,
    );
    assert_open(&env, &m);
}

#[test]
fn r31_rejects_intraday_and_latest_price_accounts() {
    let (mut env, m) = setup();
    let signer = env.relay_signer;
    let update = env.write_price_update(signer, ticker("AAPL"), official(69_100, T_CLOSE));
    let latest = env.write_latest_price(signer, ticker("AAPL"), official(69_100, T_CLOSE));
    for key in [update, latest] {
        assert_meridian_err(env.settle(&m, key), MeridianError::InvalidOracleAccount);
    }
    assert_open(&env, &m);
}

#[test]
fn r31_rejects_a_disabled_slot() {
    let (mut env, m) = setup();
    let record = env.relay_official_close(69_100);
    let ix = env.ix_settle_market_with(&Pubkey::default(), m.ticker_day, m.market, record, 1);
    assert_meridian_err(env.send_as_anyone(ix), MeridianError::OracleSlotDisabled);
    assert_open(&env, &m);
}

#[test]
fn r31_rejects_another_ticker_days_account() {
    let mut env = Env::initialized();
    let aapl = env.create_market(STRIKE);
    let msft = env.create_ticker_market("MSFT", STRIKE);
    env.set_time(T_SETTLE);
    let signer = env.relay_signer;
    let msft_record = env.write_close(signer, ticker("MSFT"), DAY, official(80_000, T_CLOSE), None);
    assert_ok(env.settle(&msft, msft_record));

    // Pairing the AAPL market with MSFT's final ticker-day (and record) must not settle it.
    let ix = env.ix_settle_market_with(
        &Pubkey::default(),
        msft.ticker_day,
        aapl.market,
        msft_record,
        SLOT_1,
    );
    assert_failed(env.send_as_anyone(ix));
    assert_eq!(env.market(&aapl).status, MarketStatus::Open);
}

#[test]
fn r31_caller_choice_of_relay_accounts_cannot_change_the_outcome() {
    let mut env = Env::initialized();
    let strikes = [68_000, 69_000, 69_050, 69_100, 70_000];
    let markets: Vec<MarketKeys> = strikes.iter().map(|&s| env.create_market(s)).collect();
    let relay = env.load_oracle_with_relay();
    let aapl = ticker("AAPL");

    // The relay publishes intraday updates through the day, then the official close.
    let mut decoys = Vec::new();
    for (t, p) in [
        (T_CLOSE - 3600, 68_000),
        (T_CLOSE - 300, 70_000),
        (T_BEFORE, 69_000),
        (T_AFTER, 69_200),
    ] {
        env.set_time(t);
        decoys.push(env.oracle_publish_price(&relay, aapl, regular(p, t)));
    }
    env.set_time(T_CLOSE + 60);
    let close_update = env.oracle_publish_price(&relay, aapl, official(69_050, T_CLOSE + 60));
    decoys.push(close_update);
    let canonical = env.oracle_publish_close(&relay, aapl, close_update, None);
    decoys.push(env.write_latest_price(relay.pubkey(), aapl, regular(70_000, T_CLOSE + 120)));
    decoys.push(env.write_close(
        relay.pubkey(),
        aapl,
        PREV_DAY,
        official(60_000, T_CLOSE),
        None,
    ));
    decoys.push(env.write_close(
        Pubkey::new_unique(),
        aapl,
        DAY,
        official(70_000, T_CLOSE),
        None,
    ));

    env.set_time(T_SETTLE);
    for m in &markets {
        for decoy in &decoys {
            assert_failed(env.settle(m, *decoy));
            assert_eq!(env.market(m).status, MarketStatus::Open);
        }
    }
    for m in &markets {
        assert_ok(env.settle(m, canonical));
    }
    for (m, strike) in markets.iter().zip(strikes) {
        let expected = if strike <= 69_050 {
            Outcome::Yes
        } else {
            Outcome::No
        };
        assert_settled(&env, m, expected, 69_050, SettleSource::OracleSlot0);
    }
}

#[test]
fn r31_every_strike_of_a_ticker_day_settles_at_one_price_and_outcomes_are_monotone() {
    let mut env = Env::initialized();
    let strikes = [
        67_500, 68_900, 69_000, 69_049, 69_050, 69_051, 69_100, 71_000,
    ];
    let markets: Vec<MarketKeys> = strikes.iter().map(|&s| env.create_market(s)).collect();
    env.set_time(T_SETTLE);
    let record = env.relay_close(regular(69_040, T_BEFORE), Some(regular(69_060, T_AFTER)));
    // Settle in a scrambled order: the price must not depend on which strike went first.
    for i in [3, 0, 7, 5, 1, 6, 2, 4] {
        assert_ok(env.settle(&markets[i], record));
    }

    let settled: Vec<Market> = markets.iter().map(|m| env.market(m)).collect();
    for market in &settled {
        assert_eq!(
            market.settle_price, 69_050,
            "identical price for every strike"
        );
        assert_eq!(market.settle_source, SettleSource::OracleSlot0);
    }
    for pair in settled.windows(2) {
        // Strikes ascend, so once Yes stops winning it never wins again.
        assert!(
            !(pair[0].outcome == Some(Outcome::No) && pair[1].outcome == Some(Outcome::Yes)),
            "outcomes must be monotone in strike"
        );
    }
    for (market, strike) in settled.iter().zip(strikes) {
        let expected = if strike <= 69_050 {
            Outcome::Yes
        } else {
            Outcome::No
        };
        assert_eq!(market.outcome, Some(expected), "strike {strike}");
    }
    assert_eq!(env.ticker_day(&markets[0]).settle_price, 69_050);
}

#[test]
fn r31_settling_another_strike_at_a_different_price_fails() {
    let mut env = Env::initialized();
    let first = env.create_market(STRIKE);
    let second = env.create_market(69_500);
    env.set_time(T_SETTLE);
    let record = env.relay_official_close(69_100);
    assert_ok(env.settle(&first, record));

    // The slot is repointed at another signer whose record says $700.00.
    let other = Pubkey::new_unique();
    let other_record = env.write_close(other, ticker("AAPL"), DAY, official(70_000, T_CLOSE), None);
    env.set_slot_1_signer(other);
    let res = env.settle(&second, other_record);
    // Settling at $700.00 must fail. Reusing the ticker-day's $691.00 is the only other result
    // allowed.
    if res.is_ok() {
        assert_settled(
            &env,
            &second,
            Outcome::No,
            69_100,
            SettleSource::OracleSlot0,
        );
    } else {
        assert_eq!(env.market(&second).status, MarketStatus::Open);
    }
    assert_eq!(env.ticker_day(&first).settle_price, 69_100);
    assert_eq!(env.ticker_day(&first).status, TickerDayStatus::Final);
}

#[test]
fn r31_end_to_end_interpolation_through_the_oracle_program() {
    let (mut env, m) = setup();
    let relay = env.load_oracle_with_relay();
    let aapl = ticker("AAPL");
    env.set_time(T_BEFORE);
    let before = env.oracle_publish_price(&relay, aapl, regular(68_990, T_BEFORE));
    env.set_time(T_AFTER);
    let after = env.oracle_publish_price(&relay, aapl, regular(69_012, T_AFTER));
    env.set_time(T_CLOSE + 4 * 60);
    let record = env.oracle_publish_close(&relay, aapl, before, Some(after));
    env.set_time(T_SETTLE);
    assert_ok(env.settle(&m, record));
    assert_settled(&env, &m, Outcome::Yes, 69_001, SettleSource::OracleSlot0);
}

// ---- R9 outcome immutability ----------------------------------------------------------------

#[test]
fn r9_settled_market_rejects_settle_propose_and_finalize_and_keeps_its_fields() {
    let (mut env, m) = setup();
    let record = env.relay_official_close(69_100);
    assert_ok(env.settle(&m, record));
    let market_before = settled_fields(&env.market(&m));
    let day_before = env.ticker_day(&m);

    env.set_time(T_CLOSE + 3600);
    assert_meridian_err(env.settle(&m, record), MeridianError::MarketSettled);
    assert_meridian_err(env.propose(68_000), MeridianError::TickerDayFinal);
    assert_failed(env.finalize());

    // A different record appearing later changes nothing either.
    let other = Pubkey::new_unique();
    let other_record = env.write_close(other, ticker("AAPL"), DAY, official(60_000, T_CLOSE), None);
    env.set_slot_1_signer(other);
    assert_failed(env.settle(&m, other_record));

    assert_eq!(settled_fields(&env.market(&m)), market_before);
    assert_eq!(env.ticker_day(&m), day_before);
}
