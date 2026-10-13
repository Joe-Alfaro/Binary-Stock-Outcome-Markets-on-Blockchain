//! R44 demo mode: the admin toggle, the regular-schedule check on market times, and the
//! `Market.demo` flag.
//!
//! With demo mode off, a market's times must be the regular schedule of its `trading_day` in
//! America/New_York: `mint_open_ts` 9:00 AM, `trading_open_ts` 9:30 AM and `close_ts` 4:00 PM
//! (or 1:00 PM on an early close). Any other time is custom and needs demo mode (and the admin).

mod common;

use common::*;
use meridian::errors::MeridianError;
use meridian::state::*;
use meridian::{CreateMarketArgs, UpdateConfigArgs};
use solana_keypair::Keypair;
use solana_signer::Signer;

const HOUR: i64 = 3600;
const EDT: i64 = 4 * HOUR;
const EST: i64 = 5 * HOUR;

fn assert_market_absent(env: &Env, m: &MarketKeys) {
    for key in [m.market, m.yes_mint, m.no_mint, m.vault, m.book] {
        assert!(!env.exists(&key), "account {key} must not exist");
    }
}

fn keys_of(args: &CreateMarketArgs) -> MarketKeys {
    MarketKeys::derive(args.ticker, args.trading_day, args.strike)
}

/// Regular-schedule args for a day starting at `day0_utc` (midnight UTC) with ET `offset`.
fn regular_args(
    ticker_str: &str,
    trading_day: u32,
    day0_utc: i64,
    offset: i64,
    close_hour: i64,
) -> CreateMarketArgs {
    let et = |secs: i64| day0_utc + secs + offset;
    CreateMarketArgs {
        ticker: ticker(ticker_str),
        trading_day,
        strike: STRIKE,
        strike_expo: STRIKE_EXPO,
        close_ts: et(close_hour * HOUR),
        mint_open_ts: et(9 * HOUR),
        trading_open_ts: et(9 * HOUR + 1800),
    }
}

/// Demo times around `now`: minting already open, trading in 30 s, close in 5 minutes.
fn demo_args(env: &Env, ticker_str: &str, strike: i64) -> CreateMarketArgs {
    let now = env.now();
    CreateMarketArgs {
        close_ts: now + 300,
        mint_open_ts: now - 60,
        trading_open_ts: now + 30,
        ..env.market_args(ticker_str, strike)
    }
}

fn create_as(env: &mut Env, signer: &Keypair, args: CreateMarketArgs) -> MarketKeys {
    let ix = env.ix_create_strike_market(&signer.pubkey(), args);
    assert_ok(env.send_one(ix, signer));
    keys_of(&args)
}

// ---- the admin toggle ---------------------------------------------------------------------------

#[test]
fn r44_admin_turns_demo_mode_on_and_off() {
    let mut env = Env::initialized();
    assert!(!env.config().demo_mode);
    let before = env.config();

    env.set_demo_mode(true);
    assert!(env.config().demo_mode);
    // Nothing else in config moves.
    assert_eq!(
        Config {
            demo_mode: false,
            ..env.config()
        },
        before
    );

    env.set_demo_mode(false);
    assert_eq!(env.config(), before);
}

#[test]
fn r44_non_admin_cannot_set_demo_mode() {
    let mut env = Env::initialized();
    let attackers = [
        env.automation.insecure_clone(),
        env.upgrade_authority.insecure_clone(),
        Keypair::new(),
    ];
    for signer in &attackers {
        env.svm.airdrop(&signer.pubkey(), 1_000_000_000).unwrap();
        let ix = env.ix_set_demo_mode(&signer.pubkey(), true);
        assert_meridian_err(env.send_one(ix, signer), MeridianError::Unauthorized);
        assert!(!env.config().demo_mode);
    }

    // Nor can they turn it off once the admin has turned it on.
    env.set_demo_mode(true);
    for signer in &attackers {
        let ix = env.ix_set_demo_mode(&signer.pubkey(), false);
        assert_meridian_err(env.send_one(ix, signer), MeridianError::Unauthorized);
        assert!(env.config().demo_mode);
    }
}

#[test]
fn r44_update_config_leaves_demo_mode_alone() {
    let mut env = Env::initialized();
    env.set_demo_mode(true);
    let admin = env.admin.insecure_clone();
    let args = UpdateConfigArgs {
        automation_authority: Some(Keypair::new().pubkey()),
        max_staleness_secs: Some(120),
        ..UpdateConfigArgs::default()
    };
    let ix = env.ix_update_config(&admin.pubkey(), args);
    assert_ok(env.send_one(ix, &admin));
    assert!(env.config().demo_mode);
}

// ---- demo mode off: only the regular schedule ---------------------------------------------------

#[test]
fn r44_demo_off_rejects_a_market_closing_minutes_after_creation() {
    let mut env = Env::initialized();
    let args = demo_args(&env, "AAPL", STRIKE);
    let admin = env.admin.insecure_clone();
    let ix = env.ix_create_strike_market(&admin.pubkey(), args);
    assert_meridian_err(env.send_one(ix, &admin), MeridianError::NonStandardSchedule);
    assert_market_absent(&env, &keys_of(&args));
    assert!(!env.exists(&keys_of(&args).ticker_day));
}

#[test]
fn r44_demo_off_rejects_every_custom_time() {
    let mut env = Env::initialized();
    let base = env.market_args("AAPL", STRIKE);
    let cases: [(&str, CreateMarketArgs); 7] = [
        (
            "mint opens a minute late",
            CreateMarketArgs {
                mint_open_ts: T_MINT_OPEN + 60,
                ..base
            },
        ),
        (
            "mint opens at the trading open",
            CreateMarketArgs {
                mint_open_ts: T_TRADING_OPEN,
                ..base
            },
        ),
        (
            "trading opens at 9:15",
            CreateMarketArgs {
                trading_open_ts: T_TRADING_OPEN - 900,
                ..base
            },
        ),
        (
            "close at 4:30 PM",
            CreateMarketArgs {
                close_ts: T_CLOSE + 1800,
                ..base
            },
        ),
        (
            "close at 3:00 PM",
            CreateMarketArgs {
                close_ts: T_CLOSE - HOUR,
                ..base
            },
        ),
        (
            "EST times on an EDT day",
            regular_args("AAPL", DAY, DAY0_UTC, EST, 16),
        ),
        (
            "the next day's times",
            regular_args("AAPL", DAY, DAY0_UTC + 86_400, EDT, 16),
        ),
    ];
    let admin = env.admin.insecure_clone();
    for (i, (name, args)) in cases.into_iter().enumerate() {
        let args = CreateMarketArgs {
            strike: STRIKE + (i as i64 + 1) * 1_000,
            ..args
        };
        let ix = env.ix_create_strike_market(&admin.pubkey(), args);
        let res = env.send_one(ix, &admin);
        assert!(res.is_err(), "{name}: custom times must be rejected");
        assert_meridian_err(res, MeridianError::NonStandardSchedule);
        assert_market_absent(&env, &keys_of(&args));
    }
}

#[test]
fn r44_demo_off_add_strike_rejects_custom_times() {
    let mut env = Env::initialized();
    env.set_time(T_CLOSE - HOUR);
    let args = CreateMarketArgs {
        close_ts: T_CLOSE - 1800,
        ..env.market_args("AAPL", STRIKE)
    };
    let admin = env.admin.insecure_clone();
    let ix = env.ix_add_strike(&admin.pubkey(), args);
    assert_meridian_err(env.send_one(ix, &admin), MeridianError::NonStandardSchedule);
    assert_market_absent(&env, &keys_of(&args));
}

/// Regression guard: the check follows US daylight saving and allows early closes.
#[test]
fn r44_demo_off_accepts_the_regular_schedule_across_dst_and_early_closes() {
    let mut env = Env::initialized();
    let auto = env.automation.insecure_clone();
    let days = [
        ("AAPL", 20261013, DAY0_UTC, EDT, 16),
        // Friday before and Monday after daylight saving ends (2026-11-01).
        ("MSFT", 20261030, 1_793_318_400, EDT, 16),
        ("GOOGL", 20261102, 1_793_577_600, EST, 16),
        // Early close the day after Thanksgiving.
        ("AMZN", 20261127, 1_795_737_600, EST, 13),
        ("NVDA", 20261201, 1_796_083_200, EST, 16),
        // Friday before and Monday after daylight saving starts (2027-03-14).
        ("META", 20270312, 1_804_809_600, EST, 16),
        ("TSLA", 20270315, 1_805_068_800, EDT, 16),
    ];
    for (t, day, day0, offset, close_hour) in days {
        // 6:00 AM ET on the day, as the morning job runs.
        env.set_time(day0 + 6 * HOUR + offset);
        let args = regular_args(t, day, day0, offset, close_hour);
        let m = create_as(&mut env, &auto, args);
        let market = env.market(&m);
        assert_eq!(market.close_ts, args.close_ts, "{t} {day}");
        assert!(!market.demo, "{t} {day}");
    }
}

// ---- demo mode on: custom times for the admin ---------------------------------------------------

#[test]
fn r44_demo_on_admin_creates_a_market_closing_in_minutes() {
    let mut env = Env::initialized();
    env.set_demo_mode(true);
    // 7:00 PM ET, well outside the regular session.
    env.set_time(T_CLOSE + 3 * HOUR);
    let args = demo_args(&env, "AAPL", STRIKE);
    let admin = env.admin.insecure_clone();
    let m = create_as(&mut env, &admin, args);

    let market = env.market(&m);
    assert!(market.demo);
    assert_eq!(market.close_ts, args.close_ts);
    assert_eq!(market.mint_open_ts, args.mint_open_ts);
    assert_eq!(market.trading_open_ts, args.trading_open_ts);
    assert_eq!(market.created_at, env.now());
    assert_eq!(env.ticker_day(&m).close_ts, args.close_ts);

    // Minting is open right away, as the demo needs.
    let user = env.new_user(&m, 10);
    assert_ok(env.mint_pair(&user, &m, 1));
}

#[test]
fn r44_demo_on_admin_adds_a_strike_with_custom_times() {
    let mut env = Env::initialized();
    env.set_demo_mode(true);
    let admin = env.admin.insecure_clone();
    let first = demo_args(&env, "AAPL", STRIKE);
    create_as(&mut env, &admin, first);

    let args = CreateMarketArgs {
        strike: STRIKE + 1_000,
        ..first
    };
    let ix = env.ix_add_strike(&admin.pubkey(), args);
    assert_ok(env.send_one(ix, &admin));
    let market = env.market(&keys_of(&args));
    assert!(market.demo);
    assert_eq!(market.close_ts, first.close_ts);
}

#[test]
fn r44_demo_on_automation_authority_still_needs_the_regular_schedule() {
    let mut env = Env::initialized();
    env.set_demo_mode(true);
    let auto = env.automation.insecure_clone();
    let args = demo_args(&env, "MSFT", 50_000);
    let ix = env.ix_create_strike_market(&auto.pubkey(), args);
    assert_meridian_err(env.send_one(ix, &auto), MeridianError::NonStandardSchedule);
    assert_market_absent(&env, &keys_of(&args));

    // The regular schedule still works for it, and the market is marked demo.
    let args = env.market_args("MSFT", 50_000);
    let m = create_as(&mut env, &auto, args);
    assert!(env.market(&m).demo);
}

#[test]
fn r44_demo_on_still_checks_time_order_and_close_in_the_future() {
    let mut env = Env::initialized();
    env.set_demo_mode(true);
    let admin = env.admin.insecure_clone();
    let now = env.now();
    let base = demo_args(&env, "AAPL", STRIKE);

    let mint_after_trading = CreateMarketArgs {
        mint_open_ts: now + 60,
        trading_open_ts: now + 30,
        ..base
    };
    let ix = env.ix_create_strike_market(&admin.pubkey(), mint_after_trading);
    assert_meridian_err(env.send_one(ix, &admin), MeridianError::InvalidMarketTimes);

    let closed = CreateMarketArgs {
        close_ts: now,
        mint_open_ts: now - 120,
        trading_open_ts: now - 60,
        ..base
    };
    let ix = env.ix_create_strike_market(&admin.pubkey(), closed);
    assert_meridian_err(env.send_one(ix, &admin), MeridianError::MarketClosed);
}

// ---- Market.demo is fixed at creation -----------------------------------------------------------

#[test]
fn r44_market_demo_flag_never_changes_after_creation() {
    let mut env = Env::initialized();
    let admin = env.admin.insecure_clone();

    // A regular market created with demo mode off.
    let regular = env.create_market(STRIKE);
    assert!(!env.market(&regular).demo);

    // A demo market on another ticker.
    env.set_demo_mode(true);
    let args = demo_args(&env, "MSFT", 50_000);
    let demo = create_as(&mut env, &admin, args);
    assert!(env.market(&demo).demo);
    assert!(!env.market(&regular).demo, "turning demo mode on");

    // Turning demo mode off, updating config and minting leave both flags as they were.
    env.set_demo_mode(false);
    let ix = env.ix_update_config(
        &admin.pubkey(),
        UpdateConfigArgs {
            max_staleness_secs: Some(120),
            ..UpdateConfigArgs::default()
        },
    );
    assert_ok(env.send_one(ix, &admin));
    let user = env.new_user(&demo, 10);
    assert_ok(env.mint_pair(&user, &demo, 1));

    let demo_market = env.market(&demo);
    assert!(demo_market.demo, "turning demo mode off");
    assert_eq!(demo_market.close_ts, T_CREATE + 300);
    assert!(!env.market(&regular).demo);

    env.set_demo_mode(true);
    assert!(!env.market(&regular).demo, "turning demo mode on again");
}
