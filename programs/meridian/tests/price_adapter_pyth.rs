//! R32 price adapter, Pyth: slot 1 switched to `Pyth` by `update_config` alone settles a market
//! from Pyth receiver `PriceUpdateV2` accounts, normalized on-chain to `NormalizedPrice`.
//!
//! The accounts are written byte for byte in the receiver's layout, from the official sources
//! (no Pyth crate is vendored offline):
//! - `PriceUpdateV2 { write_authority: Pubkey, verification_level: VerificationLevel,
//!   price_message: PriceFeedMessage, posted_slot: u64 }`, an Anchor account of
//!   `LEN = 8 + 32 + 2 + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8` bytes, Borsh-encoded.
//!   pyth-crosschain `target_chains/solana/pyth_solana_receiver_sdk/src/price_update.rs`.
//! - `enum VerificationLevel { Partial { num_signatures: u8 }, Full }` (Borsh tag 0 or 1), same file.
//! - `PriceFeedMessage { feed_id: [u8; 32], price: i64, conf: u64, exponent: i32,
//!   publish_time: i64, prev_publish_time: i64, ema_price: i64, ema_conf: u64 }`.
//!   pyth-crosschain `pythnet/pythnet_sdk/src/messages.rs`.
//! - Discriminator: `sha256("account:PriceUpdateV2")[..8]`.
//! - Receiver program `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` (devnet and mainnet).
//!
//! Slot config for `Pyth` (decision log, R32): `verifier_program` holds the receiver program that
//! must own the update accounts, `feed_ids` the feed per ticker, and `min_verification_level` 0
//! means `Full` is required (a zeroed slot fails safe). Prices come from the recorded Hermes sample
//! `packages/price-providers/fixtures/pyth/hermes-2026-10-09-before-close.json` (AAPL 245.25000,
//! conf 0.12000, expo −5), re-timed to this suite's close.

#![allow(clippy::result_large_err)]

mod common;
mod price_adapter_common;
mod settlement_common;

use std::str::FromStr;

use anchor_lang::prelude::Pubkey;
use common::*;
use meridian::errors::MeridianError;
use meridian::state::*;
use price_adapter_common::*;
use settlement_common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd];
const PRICE_UPDATE_V2_LEN: usize = 8 + 32 + 2 + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8;
/// `Equity.US.AAPL/USD` and `Equity.US.MSFT/USD` (ARCHITECTURE §5.7).
const AAPL_FEED: &str = "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688";
const MSFT_FEED: &str = "d0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1";
/// `min_verification_level` value that requires `VerificationLevel::Full`.
const REQUIRE_FULL: u8 = 0;

const SAMPLE_PRICE: i64 = 24_525_000;
const SAMPLE_CONF: u64 = 12_000;
const SAMPLE_EXPO: i32 = -5;

fn receiver() -> Pubkey {
    Pubkey::from_str("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ").unwrap()
}

#[derive(Clone, Copy)]
enum Verification {
    Partial(u8),
    Full,
}

#[derive(Clone, Copy)]
struct PythUpdate {
    feed_id: [u8; 32],
    verification: Verification,
    price: i64,
    conf: u64,
    expo: i32,
    publish_time: i64,
}

impl PythUpdate {
    /// The AAPL sample, fully verified, published exactly at the close (shape 2).
    fn sample() -> Self {
        Self {
            feed_id: hex32(AAPL_FEED),
            verification: Verification::Full,
            price: SAMPLE_PRICE,
            conf: SAMPLE_CONF,
            expo: SAMPLE_EXPO,
            publish_time: T_CLOSE,
        }
    }

    /// Borsh bytes of the `PriceUpdateV2` account, zero-padded to `LEN` like the receiver's.
    fn account_data(&self) -> Vec<u8> {
        let mut d = Vec::with_capacity(PRICE_UPDATE_V2_LEN);
        d.extend_from_slice(&PRICE_UPDATE_V2_DISCRIMINATOR);
        d.extend_from_slice(Keypair::new().pubkey().as_ref()); // write_authority
        match self.verification {
            Verification::Partial(n) => d.extend_from_slice(&[0, n]),
            Verification::Full => d.push(1),
        }
        d.extend_from_slice(&self.feed_id);
        d.extend_from_slice(&self.price.to_le_bytes());
        d.extend_from_slice(&self.conf.to_le_bytes());
        d.extend_from_slice(&self.expo.to_le_bytes());
        d.extend_from_slice(&self.publish_time.to_le_bytes());
        d.extend_from_slice(&(self.publish_time - 1).to_le_bytes()); // prev_publish_time
        d.extend_from_slice(&(self.price - 5_150).to_le_bytes()); // ema_price
        d.extend_from_slice(&(self.conf + 1_110).to_le_bytes()); // ema_conf
        d.extend_from_slice(&233_441_902u64.to_le_bytes()); // posted_slot
        d.resize(PRICE_UPDATE_V2_LEN, 0);
        d
    }
}

fn pyth_slot() -> OracleSlot {
    OracleSlot {
        kind: OracleKind::Pyth,
        relay_signer: Pubkey::default(),
        feed_ids: feed_ids_with_aapl(hex32(AAPL_FEED)),
        verifier_program: receiver(),
        min_verification_level: REQUIRE_FULL,
    }
}

/// Relay config as initialized, then slot 1 switched to Pyth by `update_config` only. One AAPL
/// market at $245.00, clock at 4:12 PM.
fn setup() -> (Env, MarketKeys) {
    let mut env = Env::initialized();
    let m = env.create_market(STRIKE_245_00);
    env.switch_slot_1(pyth_slot());
    env.set_time(T_SETTLE);
    (env, m)
}

impl Env {
    /// Writes `update` as a new account owned by `owner` and returns its address.
    fn put_pyth(&mut self, update: &PythUpdate, owner: Pubkey) -> Pubkey {
        let key = Keypair::new().pubkey();
        self.put_account(key, update.account_data(), owner);
        key
    }

    /// `settle_market` on slot 1 signed by the automation authority, with `first` as the slot's
    /// input account and `extra` appended as remaining accounts.
    fn settle_pyth(
        &mut self,
        m: &MarketKeys,
        first: Pubkey,
        extra: &[Pubkey],
    ) -> litesvm::types::TransactionResult {
        let auto = self.automation_kp();
        let mut ix = self.ix_settle_market(&auto.pubkey(), m, first);
        ix.accounts.extend(extra.iter().map(|k| {
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(*k, false)
        }));
        self.send_one(ix, &auto)
    }
}

/// `bad` is rejected with `err` and leaves the market open; the valid sample then settles the same
/// market, so the rejection is about the defect and not about the slot kind.
fn assert_rejected_then_sample_settles(bad: PythUpdate, bad_owner: Pubkey, err: MeridianError) {
    let (mut env, m) = setup();
    let bad_key = env.put_pyth(&bad, bad_owner);
    assert_meridian_err(env.settle_pyth(&m, bad_key, &[]), err);
    assert_eq!(env.market(&m).status, MarketStatus::Open);
    assert_eq!(env.ticker_day(&m).status, TickerDayStatus::Open);

    let good = env.put_pyth(&PythUpdate::sample(), receiver());
    assert_ok(env.settle_pyth(&m, good, &[]));
    assert_eq!(env.market(&m).status, MarketStatus::Settled);
}

// ---- normalization and settlement ------------------------------------------------------------

/// R32: "Every oracle kind is normalized to one NormalizedPrice on-chain" (Pyth) and "Switching
/// slot 1 to another kind takes update_config plus env vars, with no change to settlement code".
#[test]
fn r32_pyth_slot_switched_by_update_config_settles_from_a_full_price_update() {
    let (mut env, m) = setup();
    let update = env.put_pyth(&PythUpdate::sample(), receiver());
    assert_ok(env.settle_pyth(&m, update, &[]));

    let market = env.market(&m);
    assert_eq!(market.status, MarketStatus::Settled);
    assert_eq!(market.outcome, Some(Outcome::Yes));
    assert_eq!(market.settle_source, SettleSource::OracleSlot0);
    let day = env.ticker_day(&m);
    // Pyth keeps its native exponent: price and expo map straight across.
    assert_eq!(day.settle_price, SAMPLE_PRICE);
    assert_eq!(day.settle_expo, SAMPLE_EXPO);
    assert_eq!(day.settle_source, SettleSource::OracleSlot0);
    assert_exact_price(&day, 24_525, 2);
}

/// R32: the normalized price drives the outcome: the same update settles a strike above it No.
#[test]
fn r32_pyth_price_above_and_below_the_strike_settles_each_way() {
    let mut env = Env::initialized();
    let below = env.create_market(24_520);
    let above = env.create_market(24_530);
    env.switch_slot_1(pyth_slot());
    env.set_time(T_SETTLE);
    let update = env.put_pyth(&PythUpdate::sample(), receiver());
    assert_ok(env.settle_pyth(&below, update, &[]));
    assert_ok(env.settle_pyth(&above, update, &[]));
    assert_eq!(env.market(&below).outcome, Some(Outcome::Yes));
    assert_eq!(env.market(&above).outcome, Some(Outcome::No));
}

// ---- rejections ------------------------------------------------------------------------------

/// R32 (Pyth adapter): an account not owned by the configured receiver program is rejected.
#[test]
fn r32_pyth_rejects_an_update_not_owned_by_the_configured_receiver() {
    assert_rejected_then_sample_settles(
        PythUpdate::sample(),
        Keypair::new().pubkey(),
        MeridianError::InvalidOracleAccount,
    );
}

/// R32 (Pyth adapter): a receiver-owned account that isn't a `PriceUpdateV2` is rejected.
#[test]
fn r32_pyth_rejects_a_receiver_account_with_another_discriminator() {
    let (mut env, m) = setup();
    let mut data = PythUpdate::sample().account_data();
    data[..8].copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
    let key = Keypair::new().pubkey();
    env.put_account(key, data, receiver());
    assert_meridian_err(
        env.settle_pyth(&m, key, &[]),
        MeridianError::InvalidOracleAccount,
    );

    let good = env.put_pyth(&PythUpdate::sample(), receiver());
    assert_ok(env.settle_pyth(&m, good, &[]));
}

/// R32 (Pyth adapter): an update for another feed than the market ticker's configured feed.
#[test]
fn r32_pyth_rejects_an_update_for_another_feed() {
    let msft = PythUpdate {
        feed_id: hex32(MSFT_FEED),
        ..PythUpdate::sample()
    };
    assert_rejected_then_sample_settles(msft, receiver(), MeridianError::InvalidOracleAccount);
}

/// R32 (Pyth adapter): partial Wormhole verification fails a slot that requires full.
#[test]
fn r32_pyth_rejects_a_partially_verified_update_when_full_is_required() {
    let partial = PythUpdate {
        verification: Verification::Partial(13),
        ..PythUpdate::sample()
    };
    assert_rejected_then_sample_settles(partial, receiver(), MeridianError::InvalidOracleAccount);
}

/// R32 / R34: a Pyth update further than `max_staleness_secs` (300) from the close is stale.
#[test]
fn r32_pyth_rejects_a_stale_update() {
    let stale = PythUpdate {
        publish_time: T_CLOSE - 301,
        ..PythUpdate::sample()
    };
    assert_rejected_then_sample_settles(stale, receiver(), MeridianError::StalePrice);
}

/// R32 / R34: conf maps across on the price's scale, so a band over `max_conf_bps` (50) fails.
/// 1.23000 / 245.25000 is 50.15 bps.
#[test]
fn r32_pyth_rejects_a_wide_confidence_band() {
    let wide = PythUpdate {
        conf: 123_000,
        ..PythUpdate::sample()
    };
    assert_rejected_then_sample_settles(wide, receiver(), MeridianError::ConfidenceTooWide);
}

/// R32 / R34: the limit is not tighter than configured: 1.22000 / 245.25000 is 49.7 bps and passes.
#[test]
fn r32_pyth_accepts_a_confidence_band_just_inside_the_limit() {
    let (mut env, m) = setup();
    let ok = PythUpdate {
        conf: 122_000,
        ..PythUpdate::sample()
    };
    let key = env.put_pyth(&ok, receiver());
    assert_ok(env.settle_pyth(&m, key, &[]));
    assert_eq!(env.market(&m).status, MarketStatus::Settled);
}
