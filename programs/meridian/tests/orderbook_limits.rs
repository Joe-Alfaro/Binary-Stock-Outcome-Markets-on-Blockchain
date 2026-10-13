//! Order book limits: R19 side capacity, seat capacity, fill cap, compute units for a maximum
//! sweep, and the rent each market costs.

mod common;
mod orderbook_support;

use common::*;
use meridian::errors::MeridianError;
use meridian::state::*;
use orderbook_support::*;

use OrderKind::{Limit, Market as Mkt};
use Side::{Ask, Bid};

/// The local validator's per-transaction compute ceiling.
const MAX_TX_COMPUTE_UNITS: u32 = 1_400_000;

#[test]
fn r19_capacities_match_the_architecture() {
    assert_eq!(BOOK_SIDE_CAPACITY, 32);
    assert_eq!(SEAT_CAPACITY, 32);
    assert_eq!(MAX_FILLS_PER_ORDER, 16);
}

#[test]
fn r19_a_new_resting_order_on_a_full_side_fails_and_leaves_the_book_unchanged() {
    let (mut env, m) = trading_setup();
    let user = env.trader(&m, 100, BOOK_SIDE_CAPACITY as u64 + 1);
    for i in 0..BOOK_SIDE_CAPACITY {
        env.limit(&user, &m, Bid, 1 + (i % 40) as u8, 1);
        env.limit(&user, &m, Ask, 60 + (i % 40) as u8, 1);
    }
    assert_eq!(env.resting(&m, Bid).len(), BOOK_SIDE_CAPACITY);
    assert_eq!(env.resting(&m, Ask).len(), BOOK_SIDE_CAPACITY);
    let book0 = env.book_bytes(&m);
    let wallet0 = (env.balance(&user.usdc), env.balance(&user.yes));

    // Worse, equal and better (non-crossing) prices all fail: nothing is evicted.
    for price in [1, 20, 50] {
        assert_meridian_err(
            env.place(&user, &m, Bid, Limit, price, 1),
            MeridianError::BookSideFull,
        );
    }
    for price in [99, 70, 59] {
        assert_meridian_err(
            env.place(&user, &m, Ask, Limit, price, 1),
            MeridianError::BookSideFull,
        );
    }
    assert_eq!(env.book_bytes(&m), book0, "book unchanged");
    assert_eq!((env.balance(&user.usdc), env.balance(&user.yes)), wallet0);
}

#[test]
fn r19_a_new_trader_when_every_seat_is_taken_fails_and_leaves_the_book_unchanged() {
    let (mut env, m) = trading_setup();
    for i in 0..SEAT_CAPACITY {
        if i % 2 == 0 {
            let u = env.trader(&m, 1, 0);
            env.limit(&u, &m, Bid, 10, 1);
        } else {
            let u = env.trader(&m, 0, 1);
            env.limit(&u, &m, Ask, 90, 1);
        }
    }
    let late = env.trader(&m, 10, 0);
    let book0 = env.book_bytes(&m);

    assert_meridian_err(
        env.place(&late, &m, Bid, Limit, 20, 1),
        MeridianError::SeatsFull,
    );

    assert_eq!(env.book_bytes(&m), book0, "book unchanged");
    assert_eq!(env.balance(&late.usdc), 10 * UNIT);
}

#[test]
fn r19_a_market_order_beyond_the_fill_cap_fills_up_to_it_and_returns_the_rest() {
    let (mut env, m) = trading_setup();
    let extra = 4;
    let total = MAX_FILLS_PER_ORDER as u64 + extra;
    let maker = env.trader(&m, 0, total);
    for _ in 0..total {
        env.limit(&maker, &m, Ask, 50, 1);
    }
    let taker = env.trader(&m, 100, 0);
    let usdc0 = env.balance(&taker.usdc);

    let f = fills(&assert_ok(env.place(&taker, &m, Bid, Mkt, 99, total)));

    assert_eq!(f.len(), MAX_FILLS_PER_ORDER);
    assert!(f.iter().all(|f| f.qty == 1 && f.price == 50));
    assert_eq!(env.resting(&m, Ask).len(), extra as usize);
    assert!(
        env.resting(&m, Bid).is_empty(),
        "the rest is returned, not rested"
    );
    env.assert_escrow_backs_book(&m);

    assert_ok(env.settle_funds(&taker, &m));
    let filled = MAX_FILLS_PER_ORDER as u64;
    assert_eq!(env.balance(&taker.yes), filled * UNIT);
    assert_eq!(env.balance(&taker.usdc), usdc0 - usdc_at(50, filled));
}

#[test]
fn r19_a_maximum_sweep_stays_under_1_4m_compute_units() {
    let (mut env, m) = trading_setup();
    // One maker per fill, each at its own price, so every fill touches a different seat.
    let n = MAX_FILLS_PER_ORDER;
    for i in 0..n {
        let maker = env.trader(&m, 0, 2);
        env.limit(&maker, &m, Ask, 40 + i as u8, 2);
    }
    // A full book behind them, so the sweep searches a full side.
    let filler = env.trader(&m, 0, (BOOK_SIDE_CAPACITY - n) as u64);
    for _ in n..BOOK_SIDE_CAPACITY {
        env.limit(&filler, &m, Ask, 98, 1);
    }
    let bidder = env.trader(&m, 100, 0);
    for i in 0..BOOK_SIDE_CAPACITY {
        env.limit(&bidder, &m, Bid, 1 + (i % 30) as u8, 1);
    }
    let taker = env.trader(&m, 100, 0);

    let ixs = [
        ix_compute_limit(MAX_TX_COMPUTE_UNITS),
        env.ix_place_order(&taker, &m, Bid, Mkt, 99, 2 * n as u64),
    ];
    let meta = assert_ok(env.send(&ixs, &taker.kp, &[]));

    assert_eq!(fills(&meta).len(), n);
    println!(
        "max sweep ({n} fills, {n} makers, full sides): {} compute units",
        meta.compute_units_consumed
    );
    assert!(
        meta.compute_units_consumed < MAX_TX_COMPUTE_UNITS as u64,
        "{} compute units",
        meta.compute_units_consumed
    );
}

/// Measures the rent every account `create_strike_market` creates, for the README. Run with
/// `--nocapture` to see the figures.
#[test]
fn r19_rent_per_market_is_measured_and_bounded() {
    let mut env = Env::initialized();
    let m = env.create_market(STRIKE);
    let m2 = env.create_market(STRIKE + 1_000);

    let book_len = env.raw(&m.book).data.len();
    assert_eq!(book_len, 8 + std::mem::size_of::<OrderBook>());
    let per_market: u64 = [
        m.market,
        m.yes_mint,
        m.no_mint,
        m.vault,
        m.book,
        m.yes_escrow,
        m.usdc_escrow,
    ]
    .iter()
    .map(|k| env.lamports(k))
    .sum();
    let ticker_day = env.lamports(&m.ticker_day);
    let second: u64 = [
        m2.market,
        m2.yes_mint,
        m2.no_mint,
        m2.vault,
        m2.book,
        m2.yes_escrow,
        m2.usdc_escrow,
    ]
    .iter()
    .map(|k| env.lamports(k))
    .sum();
    assert_eq!(per_market, second, "every strike costs the same");

    let sol = |l: u64| l as f64 / 1e9;
    let markets_per_day = 49u64;
    let per_day = per_market * markets_per_day + ticker_day * TICKER_COUNT as u64;
    println!(
        "rent: book {book_len} bytes = {:.6} SOL; per market {:.6} SOL; ticker day {:.6} SOL; \
         per day ({markets_per_day} markets, {TICKER_COUNT} tickers) {:.4} SOL",
        sol(env.lamports(&m.book)),
        sol(per_market),
        sol(ticker_day),
        sol(per_day),
    );
    // ARCHITECTURE.md §3.8 budgets about 0.04 SOL per market.
    assert!(
        per_market < 50_000_000,
        "{:.6} SOL per market",
        sol(per_market)
    );
}
