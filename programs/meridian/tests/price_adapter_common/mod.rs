//! Helpers shared by the third-party price adapter tests (R32): switching oracle slot 1 to another
//! kind through `update_config`, and reading back the exact settled price.
#![allow(dead_code, clippy::result_large_err)]

use anchor_lang::prelude::Pubkey;
use meridian::state::*;
use solana_signer::Signer;

use crate::common::*;
use crate::settlement_common::*;

/// AAPL at $245.00, below every sample price, so a correct normalization settles Yes.
pub const STRIKE_245_00: i64 = 24_500;

impl Env {
    /// Replaces oracle slot 1 with `slot` through `update_config` only, as an operator would.
    pub fn switch_slot_1(&mut self, slot: OracleSlot) {
        let mut slots = self.config().oracle_slots;
        slots[SLOT_1 as usize] = slot;
        self.update_config_with(meridian::UpdateConfigArgs {
            oracle_slots: Some(slots),
            ..Default::default()
        });
        assert_eq!(self.config().oracle_slots[SLOT_1 as usize], slot);
    }

    /// The automation authority, which third-party slots require as the settle signer (§4.3).
    pub fn automation_kp(&self) -> solana_keypair::Keypair {
        self.automation.insecure_clone()
    }

    pub fn automation_key(&self) -> Pubkey {
        self.automation.pubkey()
    }
}

/// Feed or stream IDs with `id` at AAPL's index (0) and distinct dummies elsewhere.
pub fn feed_ids_with_aapl(id: [u8; 32]) -> [[u8; 32]; TICKER_COUNT] {
    let mut ids = [[0u8; 32]; TICKER_COUNT];
    for (i, slot) in ids.iter_mut().enumerate() {
        *slot = [0xA0 + i as u8; 32];
    }
    ids[0] = id;
    ids
}

/// Asserts the ticker-day's exact final price equals `units × 10^-decimals`, whatever exponent
/// the adapter chose.
pub fn assert_exact_price(day: &TickerDay, units: i128, decimals: u32) {
    assert_eq!(day.status, TickerDayStatus::Final);
    assert!(day.settle_denominator > 0, "price not set");
    let shift = day.settle_expo + decimals as i32;
    let (lhs, rhs) = if shift >= 0 {
        (
            day.settle_numerator * 10i128.pow(shift as u32),
            units * day.settle_denominator,
        )
    } else {
        (
            day.settle_numerator,
            units * day.settle_denominator * 10i128.pow(shift.unsigned_abs()),
        )
    };
    assert_eq!(
        lhs, rhs,
        "settled {} / {} × 10^{} != {units} × 10^-{decimals}",
        day.settle_numerator, day.settle_denominator, day.settle_expo
    );
}

pub fn hex32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}
