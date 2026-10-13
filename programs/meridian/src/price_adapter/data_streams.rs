//! `ChainlinkDataStreams`: RWA Advanced (v11) reports, each verified by CPI to the slot's verifier
//! program (ARCHITECTURE §5.8).
//!
//! Meridian never decodes a report the verifier hasn't returned. The `verify` instruction and its
//! accounts follow chainlink-solana `chainlink-solana-data-streams` (`VerifierInstructions::verify`);
//! the verifier returns the report as return data. The v11 layout is one ABI word per field, from
//! docs.chain.link/data-streams/reference/report-schema-v11.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{get_return_data, invoke};
use meridian_math::{NormalizedPrice, Session};

use super::feed_id;
use crate::errors::MeridianError;
use crate::state::{Config, Market, OracleSlot};

/// `sha256("global:verify")[..8]`.
const VERIFY_DISCRIMINATOR: [u8; 8] = [133, 161, 141, 48, 120, 198, 88, 150];

/// v11 prices are fixed-point with 18 decimals. They are stored at the smallest exponent the
/// closing-price rule allows, which keeps 12 decimals and fits prices up to about $9.2M in `i64`.
pub const EXPO: i32 = -12;
const RESCALE: i128 = 1_000_000; // 10^(18 - 12)

const WORD: usize = 32;
const V11_WORDS: usize = 14;
// Word indexes in the v11 report.
const FEED_ID: usize = 0;
const OBSERVATIONS_TIMESTAMP: usize = 2;
const MID: usize = 6;
const BID: usize = 8;
const ASK: usize = 10;
const LAST_TRADED_PRICE: usize = 12;
const MARKET_STATUS: usize = 13;
/// `marketStatus` for regular hours. 0 unknown, 1 pre-market, 3 post-market, 4 overnight and
/// 5 closed are all outside the regular session.
const MARKET_STATUS_REGULAR: u32 = 2;

/// The verifier program and its `verify` accounts. `user` signs the settle transaction.
pub struct Verifier<'a, 'info> {
    pub program: &'a AccountInfo<'info>,
    pub verifier_account: &'a AccountInfo<'info>,
    pub access_controller: &'a AccountInfo<'info>,
    pub user: &'a AccountInfo<'info>,
    pub report_config: &'a AccountInfo<'info>,
}

/// One `NormalizedPrice` per signed report. Each is verified by the slot's configured verifier and
/// must be for the ticker's configured stream.
pub fn updates(
    verifier: &Verifier,
    reports: &[Vec<u8>],
    slot: &OracleSlot,
    config: &Config,
    market: &Market,
) -> Result<Vec<NormalizedPrice>> {
    require!(
        slot.verifier_program != Pubkey::default()
            && verifier.program.key() == slot.verifier_program,
        MeridianError::InvalidOracleAccount
    );
    let stream = feed_id(config, &slot.feed_ids, market)?;
    reports
        .iter()
        .map(|signed| {
            let report = verify(verifier, signed)?;
            normalize(&report, &stream, market)
        })
        .collect()
}

/// CPIs `verify` and returns the verified report the verifier sets as return data.
fn verify(verifier: &Verifier, signed_report: &[u8]) -> Result<Vec<u8>> {
    let len =
        u32::try_from(signed_report.len()).map_err(|_| MeridianError::InvalidOracleAccount)?;
    let mut data = Vec::with_capacity(12 + signed_report.len());
    data.extend_from_slice(&VERIFY_DISCRIMINATOR);
    data.extend_from_slice(&len.to_le_bytes());
    data.extend_from_slice(signed_report);
    let ix = Instruction {
        program_id: verifier.program.key(),
        accounts: vec![
            AccountMeta::new_readonly(verifier.verifier_account.key(), false),
            AccountMeta::new_readonly(verifier.access_controller.key(), false),
            AccountMeta::new_readonly(verifier.user.key(), true),
            AccountMeta::new_readonly(verifier.report_config.key(), false),
        ],
        data,
    };
    invoke(
        &ix,
        &[
            verifier.verifier_account.clone(),
            verifier.access_controller.clone(),
            verifier.user.clone(),
            verifier.report_config.clone(),
            verifier.program.clone(),
        ],
    )?;
    // The runtime clears return data before each CPI, so this is the verifier's answer or none.
    match get_return_data() {
        Some((program, report)) if program == verifier.program.key() => Ok(report),
        _ => err!(MeridianError::InvalidOracleAccount),
    }
}

fn normalize(report: &[u8], stream: &[u8; 32], market: &Market) -> Result<NormalizedPrice> {
    require!(
        report.len() >= V11_WORDS * WORD,
        MeridianError::InvalidOracleAccount
    );
    let word = |i: usize| -> &[u8; WORD] { report[i * WORD..(i + 1) * WORD].try_into().unwrap() };
    require!(word(FEED_ID) == stream, MeridianError::InvalidOracleAccount);

    let last_traded = int192(word(LAST_TRADED_PRICE))?;
    let price = if last_traded != 0 {
        last_traded
    } else {
        int192(word(MID))?
    };
    let spread = int192(word(ASK))?
        .checked_sub(int192(word(BID))?)
        .filter(|s| *s >= 0)
        .ok_or(MeridianError::NoValidClosePrice)?;

    Ok(NormalizedPrice {
        ticker: market.ticker,
        price: rescale_nearest(price)
            .and_then(|p| i64::try_from(p).ok())
            .ok_or(MeridianError::NoValidClosePrice)?,
        // Half the spread, rounded up so the confidence check is never looser than the report.
        conf: spread
            .checked_add(2 * RESCALE - 1)
            .and_then(|s| u64::try_from(s / (2 * RESCALE)).ok())
            .ok_or(MeridianError::NoValidClosePrice)?,
        expo: EXPO,
        publish_time: i64::from(uint32(word(OBSERVATIONS_TIMESTAMP))?),
        session: if uint32(word(MARKET_STATUS))? == MARKET_STATUS_REGULAR {
            Session::Regular
        } else {
            Session::OutsideRegular
        },
        official_close: false,
    })
}

/// An 18-decimal value at `EXPO`, halves away from zero.
fn rescale_nearest(value: i128) -> Option<i128> {
    let half = if value < 0 { -RESCALE / 2 } else { RESCALE / 2 };
    Some(value.checked_add(half)? / RESCALE)
}

/// A sign-extended ABI `int192`. Every v11 price is far inside `i128`; anything wider is refused.
fn int192(word: &[u8; WORD]) -> Result<i128> {
    let low = i128::from_be_bytes(word[16..].try_into().unwrap());
    let sign = if low < 0 { 0xff } else { 0 };
    require!(
        word[..16].iter().all(|b| *b == sign),
        MeridianError::NoValidClosePrice
    );
    Ok(low)
}

/// A zero-padded ABI `uint32`.
fn uint32(word: &[u8; WORD]) -> Result<u32> {
    require!(
        word[..28].iter().all(|b| *b == 0),
        MeridianError::InvalidOracleAccount
    );
    Ok(u32::from_be_bytes(word[28..].try_into().unwrap()))
}
