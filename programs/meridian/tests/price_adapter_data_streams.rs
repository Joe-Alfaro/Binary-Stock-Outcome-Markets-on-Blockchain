//! R32 price adapter, Chainlink Data Streams: slot 1 switched to `ChainlinkDataStreams` by
//! `update_config` alone settles a market from RWA Advanced (v11) reports, each verified by CPI to
//! the configured verifier program and normalized on-chain to `NormalizedPrice`.
//!
//! The verifier is a **mock**, loaded as a LiteSVM native builtin at the verifier's program ID. It
//! takes the real `verify` instruction and answers the real way, so the CPI, decode and normalize
//! path in Meridian is the production one; only the signature check is faked (a report "verifies"
//! when it starts with `MOCK_SIGNATURE`, and the mock returns the rest). Sources:
//! - `verify`: data `[133, 161, 141, 48, 120, 198, 88, 150]` (`sha256("global:verify")[..8]`)
//!   then Borsh `VerifyParams { signed_report: Vec<u8> }`; accounts `verifier_account`,
//!   `access_controller`, `user` (signer), `report_config_account`, all read-only.
//!   chainlink-solana `contracts/crates/chainlink-solana-data-streams/src/lib.rs`
//!   (`VerifierInstructions::verify`).
//! - The verified report comes back as return data (`get_return_data()`, then decode).
//!   docs.chain.link/data-streams/tutorials/solana-onchain-report-verification.
//! - Verifier program `Gt9S41PtjR58CbG9JhJ3J6vxesqrNAswbWYbLNTMZA3c` (devnet and mainnet), same
//!   tutorial.
//! - v11 report: ABI-encoded, one 32-byte word per field, in order `feedId bytes32`,
//!   `validFromTimestamp uint32`, `observationsTimestamp uint32`, `nativeFee uint192`,
//!   `linkFee uint192`, `expiresAt uint32`, `mid int192`, `lastSeenTimestampNs uint64`,
//!   `bid int192`, `bidVolume int192`, `ask int192`, `askVolume int192`, `lastTradedPrice int192`,
//!   `marketStatus uint32`; prices have 18 decimals; `marketStatus` 2 is the regular session (0
//!   unknown, 1 pre-market, 3 post-market, 4 overnight, 5 closed).
//!   docs.chain.link/data-streams/reference/report-schema-v11.
//!
//! Sample values are the recorded report
//! `packages/price-providers/fixtures/chainlink/v11-AAPL-2026-10-09-before-close.json`, re-timed to
//! this suite's close.

#![allow(clippy::result_large_err)]

mod common;
mod price_adapter_common;
mod settlement_common;

use std::str::FromStr;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{InstructionData, ToAccountMetas};
use common::*;
use litesvm::types::TransactionResult;
use meridian::errors::MeridianError;
use meridian::state::*;
use price_adapter_common::*;
use settlement_common::*;
use solana_keypair::Keypair;
use solana_program_runtime::__private::InstructionError;
use solana_program_runtime::declare_process_instruction;
use solana_program_runtime::solana_sbpf::program::BuiltinFunctionDefinition;
use solana_signer::Signer;

const VERIFY_DISCRIMINATOR: [u8; 8] = [133, 161, 141, 48, 120, 198, 88, 150];
const MOCK_SIGNATURE: &[u8; 8] = b"MOCKSIG!";
/// A Data Streams feed ID (schema 0x000b) for AAPL, as in the recorded sample.
const AAPL_STREAM: &str = "000b6a1e3c5f7d9b2a4c6e8f0a1b3c5d7e9f2a4b6c8d0e1f3a5b7c9d1e2f4a6b";
const MSFT_STREAM: &str = "000b0d0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12d";

const MARKET_STATUS_REGULAR: u32 = 2;
/// 1e18: v11 prices are fixed-point with 18 decimals.
const E18: i128 = 1_000_000_000_000_000_000;

fn verifier() -> Pubkey {
    Pubkey::from_str("Gt9S41PtjR58CbG9JhJ3J6vxesqrNAswbWYbLNTMZA3c").unwrap()
}

// The mock verifier. Checks the `verify` instruction's shape, "verifies" the signature, and sets
// the report as return data, as the real program does.
declare_process_instruction!(MockVerifier, 1_000, |invoke_context| {
    let (program_id, report) = {
        let ctx = invoke_context
            .transaction_context
            .get_current_instruction_context()?;
        if ctx.get_number_of_instruction_accounts() != 4 {
            return Err(InstructionError::MissingAccount);
        }
        if !ctx.is_instruction_account_signer(2)? {
            return Err(InstructionError::MissingRequiredSignature);
        }
        let data = ctx.get_instruction_data();
        if data.len() < 12 || data[..8] != VERIFY_DISCRIMINATOR {
            return Err(InstructionError::InvalidInstructionData);
        }
        let len = u32::from_le_bytes(data[8..12].try_into().unwrap()) as usize;
        let signed = &data[12..];
        if signed.len() != len {
            return Err(InstructionError::InvalidInstructionData);
        }
        let Some(report) = signed.strip_prefix(MOCK_SIGNATURE.as_slice()) else {
            // A bad signature.
            return Err(InstructionError::InvalidArgument);
        };
        (*ctx.get_program_key()?, report.to_vec())
    };
    invoke_context
        .transaction_context
        .set_return_data(program_id, report)?;
    Ok(())
});

/// A decoded v11 report. Prices in 1e-18 units.
#[derive(Clone, Copy)]
struct V11 {
    feed_id: [u8; 32],
    observations_timestamp: u32,
    mid: i128,
    bid: i128,
    ask: i128,
    last_traded_price: i128,
    market_status: u32,
}

impl V11 {
    /// The recorded AAPL sample, observed exactly at the close (shape 2): last trade 245.25,
    /// bid 245.20, ask 245.33, mid 245.265, regular session.
    fn sample() -> Self {
        Self {
            feed_id: hex32(AAPL_STREAM),
            observations_timestamp: T_CLOSE as u32,
            mid: 245_265 * E18 / 1_000,
            bid: 24_520 * E18 / 100,
            ask: 24_533 * E18 / 100,
            last_traded_price: 24_525 * E18 / 100,
            market_status: MARKET_STATUS_REGULAR,
        }
    }

    /// The ABI encoding the verifier returns.
    fn abi(&self) -> Vec<u8> {
        fn word_u(v: u128) -> [u8; 32] {
            let mut w = [0u8; 32];
            w[16..].copy_from_slice(&v.to_be_bytes());
            w
        }
        fn word_i(v: i128) -> [u8; 32] {
            let mut w = if v < 0 { [0xff; 32] } else { [0u8; 32] };
            w[16..].copy_from_slice(&v.to_be_bytes());
            w
        }
        let obs = u128::from(self.observations_timestamp);
        let words: [[u8; 32]; 14] = [
            self.feed_id,
            word_u(obs),                               // validFromTimestamp
            word_u(obs),                               // observationsTimestamp
            word_u(195_617_094_561_000),               // nativeFee
            word_u(41_736_342_373_848_000),            // linkFee
            word_u(obs + 30 * 86_400),                 // expiresAt
            word_i(self.mid),                          // mid
            word_u(obs * 1_000_000_000 - 126_000_000), // lastSeenTimestampNs
            word_i(self.bid),                          // bid
            word_i(1_200 * E18),                       // bidVolume
            word_i(self.ask),                          // ask
            word_i(900 * E18),                         // askVolume
            word_i(self.last_traded_price),            // lastTradedPrice
            word_u(u128::from(self.market_status)),    // marketStatus
        ];
        words.concat()
    }

    /// What the worker passes to Meridian: a report the mock verifier accepts.
    fn signed(&self) -> Vec<u8> {
        [MOCK_SIGNATURE.as_slice(), &self.abi()].concat()
    }
}

fn data_streams_slot() -> OracleSlot {
    OracleSlot {
        kind: OracleKind::ChainlinkDataStreams,
        relay_signer: Pubkey::default(),
        feed_ids: feed_ids_with_aapl(hex32(AAPL_STREAM)),
        verifier_program: verifier(),
        min_verification_level: 0,
    }
}

struct VerifierAccounts {
    program: Pubkey,
    state: Pubkey,
    access_controller: Pubkey,
    report_config: Pubkey,
}

impl VerifierAccounts {
    fn new(program: Pubkey) -> Self {
        Self {
            program,
            state: Keypair::new().pubkey(),
            access_controller: Keypair::new().pubkey(),
            report_config: Keypair::new().pubkey(),
        }
    }
}

/// Relay config as initialized, the mock verifier loaded, then slot 1 switched to Data Streams by
/// `update_config` only. One AAPL market at `strike`, clock at 4:12 PM.
fn setup_at(strike: i64) -> (Env, MarketKeys) {
    let mut env = Env::initialized();
    env.svm.add_builtin(verifier(), MockVerifier::register);
    let m = env.create_market(strike);
    env.switch_slot_1(data_streams_slot());
    env.set_time(T_SETTLE);
    (env, m)
}

fn setup() -> (Env, MarketKeys) {
    setup_at(STRIKE_245_00)
}

impl Env {
    fn ix_settle_with_reports(
        &self,
        m: &MarketKeys,
        v: &VerifierAccounts,
        reports: Vec<Vec<u8>>,
    ) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::SettleMarketWithReports {
                caller: self.automation_key(),
                config: config_pda(),
                ticker_day: m.ticker_day,
                market: m.market,
                verifier_program: v.program,
                verifier_account: v.state,
                access_controller: v.access_controller,
                report_config: v.report_config,
            }
            .to_account_metas(None),
            data: meridian::instruction::SettleMarketWithReports {
                slot: SLOT_1,
                reports,
            }
            .data(),
        }
    }

    /// Settles slot 1 from `reports`, signed by the automation authority (§4.3).
    fn settle_reports(&mut self, m: &MarketKeys, reports: Vec<Vec<u8>>) -> TransactionResult {
        let v = VerifierAccounts::new(verifier());
        self.settle_reports_via(m, &v, reports)
    }

    fn settle_reports_via(
        &mut self,
        m: &MarketKeys,
        v: &VerifierAccounts,
        reports: Vec<Vec<u8>>,
    ) -> TransactionResult {
        let ix = self.ix_settle_with_reports(m, v, reports);
        let auto = self.automation_kp();
        self.send_one(ix, &auto)
    }
}

fn assert_open(env: &Env, m: &MarketKeys) {
    assert_eq!(env.market(m).status, MarketStatus::Open);
    assert_eq!(env.ticker_day(m).status, TickerDayStatus::Open);
}

/// `bad` is rejected with `err`; the sample then settles the same market, so the rejection is
/// about the defect and not about the slot kind.
fn assert_rejected_then_sample_settles(bad: V11, err: MeridianError) {
    let (mut env, m) = setup();
    assert_meridian_err(env.settle_reports(&m, vec![bad.signed()]), err);
    assert_open(&env, &m);
    assert_ok(env.settle_reports(&m, vec![V11::sample().signed()]));
    assert_eq!(env.market(&m).status, MarketStatus::Settled);
}

// ---- decode, normalize, settle -----------------------------------------------------------------

/// R32: "Every oracle kind is normalized to one NormalizedPrice on-chain" (Data Streams) and
/// "Switching slot 1 to another kind takes update_config plus env vars, with no change to
/// settlement code". Price is `lastTradedPrice` when present.
#[test]
fn r32_data_streams_slot_switched_by_update_config_settles_from_a_verified_v11_report() {
    let (mut env, m) = setup();
    assert_ok(env.settle_reports(&m, vec![V11::sample().signed()]));

    let market = env.market(&m);
    assert_eq!(market.status, MarketStatus::Settled);
    assert_eq!(market.outcome, Some(Outcome::Yes));
    assert_eq!(market.settle_source, SettleSource::OracleSlot0);
    let day = env.ticker_day(&m);
    assert_eq!(day.settle_source, SettleSource::OracleSlot0);
    assert!(
        (meridian_math::MIN_EXPO..=meridian_math::MAX_EXPO).contains(&day.settle_expo),
        "18-decimal prices are rescaled into the on-chain exponent range"
    );
    assert_exact_price(&day, 24_525, 2);
}

/// R32 (Data Streams adapter): `lastTradedPrice` wins over `mid`. At a $245.26 strike the last
/// trade (245.25) settles No, where the mid (245.265) would settle Yes.
#[test]
fn r32_data_streams_prefers_last_traded_price_over_mid() {
    let (mut env, m) = setup_at(24_526);
    assert_ok(env.settle_reports(&m, vec![V11::sample().signed()]));
    assert_eq!(env.market(&m).outcome, Some(Outcome::No));
    assert_exact_price(&env.ticker_day(&m), 24_525, 2);
}

/// R32 (Data Streams adapter): with no last trade (0, "availability varies by stream"), price is
/// `mid`, exactly 245.265.
#[test]
fn r32_data_streams_falls_back_to_mid_without_a_last_trade() {
    let (mut env, m) = setup_at(24_526);
    let report = V11 {
        last_traded_price: 0,
        ..V11::sample()
    };
    assert_ok(env.settle_reports(&m, vec![report.signed()]));
    assert_eq!(env.market(&m).outcome, Some(Outcome::Yes));
    assert_exact_price(&env.ticker_day(&m), 245_265, 3);
}

/// R32 (Data Streams adapter): conf is half the spread. A 2.40 spread is a 1.20 band, 48.9 bps of
/// 245.25 and inside `max_conf_bps` (50); the full spread would be 97.9 bps.
#[test]
fn r32_data_streams_conf_is_half_the_bid_ask_spread() {
    let (mut env, m) = setup();
    let report = V11 {
        bid: 24_405 * E18 / 100,
        ask: 24_645 * E18 / 100,
        ..V11::sample()
    };
    assert_ok(env.settle_reports(&m, vec![report.signed()]));
    assert_eq!(env.market(&m).status, MarketStatus::Settled);
}

/// R32 / R34: a 2.46 spread is a 1.23 band, 50.15 bps, so it is too wide.
#[test]
fn r32_data_streams_rejects_a_spread_wider_than_the_conf_limit() {
    let report = V11 {
        bid: 24_402 * E18 / 100,
        ask: 24_648 * E18 / 100,
        ..V11::sample()
    };
    assert_rejected_then_sample_settles(report, MeridianError::ConfidenceTooWide);
}

/// R32 (Data Streams adapter): only `marketStatus` 2 is the regular session; unknown,
/// pre-market, post-market, overnight and closed are outside it.
#[test]
fn r32_data_streams_maps_market_status_to_session() {
    for status in [0u32, 1, 3, 4, 5] {
        let (mut env, m) = setup();
        let report = V11 {
            market_status: status,
            ..V11::sample()
        };
        let res = env.settle_reports(&m, vec![report.signed()]);
        assert_meridian_err(res, MeridianError::OutsideRegularSession);
        assert_open(&env, &m);
    }
    let (mut env, m) = setup();
    assert_ok(env.settle_reports(&m, vec![V11::sample().signed()]));
}

/// R32 / R34: `observationsTimestamp` is the publish time, so one 301 s before the close is stale.
#[test]
fn r32_data_streams_rejects_a_stale_report() {
    let report = V11 {
        observations_timestamp: (T_CLOSE - 301) as u32,
        ..V11::sample()
    };
    assert_rejected_then_sample_settles(report, MeridianError::StalePrice);
}

/// R32 (Data Streams adapter): a report for another stream than the ticker's configured one.
#[test]
fn r32_data_streams_rejects_a_report_for_another_stream() {
    let report = V11 {
        feed_id: hex32(MSFT_STREAM),
        ..V11::sample()
    };
    assert_rejected_then_sample_settles(report, MeridianError::InvalidOracleAccount);
}

// ---- verification by CPI -----------------------------------------------------------------------

/// R32 (Data Streams adapter): every report goes through the verifier. One the verifier refuses
/// fails the settle, so Meridian never decodes an unverified report itself.
#[test]
fn r32_data_streams_report_the_verifier_rejects_fails_settlement() {
    let (mut env, m) = setup();
    let unsigned = V11::sample().abi();
    let res = env.settle_reports(&m, vec![unsigned]);
    assert_failed(res);
    assert_open(&env, &m);
    assert_ok(env.settle_reports(&m, vec![V11::sample().signed()]));
}

/// R32 (Data Streams adapter): the verifier must be the slot's configured `verifier_program`. A
/// stand-in that approves anything is refused.
#[test]
fn r32_data_streams_rejects_a_verifier_other_than_the_configured_one() {
    let (mut env, m) = setup();
    let rogue = Keypair::new().pubkey();
    env.svm.add_builtin(rogue, MockVerifier::register);
    let v = VerifierAccounts::new(rogue);
    let res = env.settle_reports_via(&m, &v, vec![V11::sample().signed()]);
    assert_meridian_err(res, MeridianError::InvalidOracleAccount);
    assert_open(&env, &m);
    assert_ok(env.settle_reports(&m, vec![V11::sample().signed()]));
}

/// R32: `settle_market_with_reports` reads only report kinds. On a relay slot it is refused, and
/// the relay slot's own path is unchanged.
#[test]
fn r32_reports_are_refused_on_a_relay_slot() {
    let (mut env, m) = setup();
    let relay = env.relay_signer;
    env.switch_slot_1(relay_slot(relay));
    let res = env.settle_reports(&m, vec![V11::sample().signed()]);
    assert_meridian_err(res, MeridianError::InvalidOracleAccount);
    assert_open(&env, &m);
}

// ---- harness self-check --------------------------------------------------------------------------

/// Not a requirement test: the mock answers a well-formed `verify` with the report as return data
/// under the verifier's program ID, and refuses an unsigned one, so the tests above exercise it.
#[test]
fn harness_mock_verifier_returns_the_verified_report() {
    let (mut env, _) = setup();
    let user = env.automation_kp();
    let v = VerifierAccounts::new(verifier());
    let verify = |signed: Vec<u8>| Instruction {
        program_id: verifier(),
        accounts: vec![
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(v.state, false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                v.access_controller,
                false,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                user.pubkey(),
                true,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                v.report_config,
                false,
            ),
        ],
        data: [
            VERIFY_DISCRIMINATOR.as_slice(),
            &(signed.len() as u32).to_le_bytes(),
            &signed,
        ]
        .concat(),
    };
    let meta = assert_ok(env.send_one(verify(V11::sample().signed()), &user));
    assert_eq!(meta.return_data.program_id, verifier());
    assert_eq!(meta.return_data.data, V11::sample().abi());
    assert_failed(env.send_one(verify(V11::sample().abi()), &user));
}
