//! Shared LiteSVM harness for the `meridian_oracle` program tests.
//!
//! The tests run the SBF build at `target/deploy/meridian_oracle.so`, so run `anchor build`
//! first (`make test` and `make gates` do).

#![allow(dead_code)]

use anchor_lang::prelude::{Clock, Pubkey};
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use meridian_oracle::{
    accounts, instruction, OracleError, PriceInput, Session, Ticker, CLOSE_SEED, LATEST_SEED,
    PRICE_SEED, SIGNERS_SEED,
};
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_message::{Instruction, Message};
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

/// 2026-10-12 16:00:00 ET (20:00 UTC), a regular trading day.
pub const CLOSE_TS: i64 = 1_791_835_200;
pub const TRADING_DAY: u32 = 20_261_012;

pub const AAPL: Ticker = *b"AAPL\0\0\0\0";
pub const MSFT: Ticker = *b"MSFT\0\0\0\0";
pub const TICKERS: [Ticker; 7] = [
    *b"AAPL\0\0\0\0",
    *b"MSFT\0\0\0\0",
    *b"GOOGL\0\0\0",
    *b"AMZN\0\0\0\0",
    *b"NVDA\0\0\0\0",
    *b"META\0\0\0\0",
    *b"TSLA\0\0\0\0",
];

const LAMPORTS: u64 = 100_000_000_000;

/// Offset of `upgrade_authority_address` in an upgradeable loader `ProgramData` account:
/// a 4-byte enum tag and an 8-byte slot, then a 1-byte option tag and the 32-byte key.
const PROGRAM_DATA_AUTHORITY_OFFSET: usize = 12;

pub type TxResult = Result<(), TransactionError>;

pub struct Harness {
    pub svm: LiteSVM,
    pub upgrade_authority: Keypair,
    pub admin: Keypair,
}

impl Harness {
    /// Loads the program with `upgrade_authority` as its upgrade authority and sets the clock to
    /// `CLOSE_TS + 120`. The registry is not initialized.
    pub fn new() -> Self {
        let so_path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../target/deploy/meridian_oracle.so"
        );
        let program = std::fs::read(so_path)
            .unwrap_or_else(|e| panic!("read {so_path}: {e}. Run `anchor build` first."));

        let mut svm = LiteSVM::new();
        svm.add_program(meridian_oracle::ID, &program)
            .expect("load meridian_oracle");

        let upgrade_authority = Keypair::new();
        let admin = Keypair::new();
        let mut harness = Self {
            svm,
            upgrade_authority,
            admin,
        };
        harness.set_upgrade_authority(harness.upgrade_authority.pubkey());
        harness.fund(&harness.upgrade_authority.pubkey());
        harness.fund(&harness.admin.pubkey());
        harness.set_now(CLOSE_TS + 120);
        harness
    }

    /// `new()` plus an initialized registry whose admin is `self.admin`.
    pub fn with_registry() -> Self {
        let mut harness = Self::new();
        let admin = harness.admin.pubkey();
        harness
            .initialize_registry(&harness.upgrade_authority.insecure_clone(), admin)
            .expect("initialize_registry");
        harness
    }

    fn set_upgrade_authority(&mut self, authority: Pubkey) {
        let program_data = program_data_address();
        let mut account = self.svm.get_account(&program_data).expect("program data");
        account.data[PROGRAM_DATA_AUTHORITY_OFFSET] = 1;
        account.data[PROGRAM_DATA_AUTHORITY_OFFSET + 1..PROGRAM_DATA_AUTHORITY_OFFSET + 33]
            .copy_from_slice(authority.as_ref());
        self.svm.set_account(program_data, account).unwrap();
    }

    pub fn fund(&mut self, address: &Pubkey) {
        self.svm.airdrop(address, LAMPORTS).expect("airdrop");
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn set_now(&mut self, unix_timestamp: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    /// Sends one transaction paid by the first signer. The blockhash is expired afterwards so an
    /// identical retry is a new transaction rather than `AlreadyProcessed`.
    pub fn send(&mut self, instructions: &[Instruction], signers: &[&Keypair]) -> TxResult {
        let payer = signers[0].pubkey();
        let message =
            Message::new_with_blockhash(instructions, Some(&payer), &self.svm.latest_blockhash());
        let tx = Transaction::new(signers, message, self.svm.latest_blockhash());
        let result = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        result.map(|_| ()).map_err(|failed| failed.err)
    }

    pub fn account_data(&self, address: &Pubkey) -> Option<Vec<u8>> {
        self.svm
            .get_account(address)
            .filter(|account| account.lamports > 0)
            .map(|account| account.data)
    }

    /// Deserializes an Anchor account, checking that this program owns it.
    pub fn fetch<T: AccountDeserialize>(&self, address: &Pubkey) -> Option<T> {
        let account = self
            .svm
            .get_account(address)
            .filter(|account| account.lamports > 0)?;
        assert_eq!(
            account.owner,
            meridian_oracle::ID,
            "account {address} is not owned by meridian_oracle"
        );
        Some(T::try_deserialize(&mut account.data.as_slice()).expect("deserialize account"))
    }

    // Instruction wrappers.

    pub fn initialize_registry(&mut self, authority: &Keypair, admin: Pubkey) -> TxResult {
        let ix = ix_initialize_registry(&authority.pubkey(), admin);
        self.send(&[ix], &[authority])
    }

    pub fn add_signer(&mut self, admin: &Keypair, signer: Pubkey) -> TxResult {
        let ix = ix_add_signer(&admin.pubkey(), signer);
        self.send(&[ix], &[admin])
    }

    pub fn remove_signer(&mut self, admin: &Keypair, signer: Pubkey) -> TxResult {
        let ix = ix_remove_signer(&admin.pubkey(), signer);
        self.send(&[ix], &[admin])
    }

    /// A funded keypair that is not registered.
    pub fn new_funded(&mut self) -> Keypair {
        let keypair = Keypair::new();
        self.fund(&keypair.pubkey());
        keypair
    }

    /// A funded relay signer registered by the admin.
    pub fn new_relay(&mut self) -> Keypair {
        let relay = self.new_funded();
        let admin = self.admin.insecure_clone();
        self.add_signer(&admin, relay.pubkey()).expect("add_signer");
        relay
    }

    pub fn publish_price(
        &mut self,
        signer: &Keypair,
        ticker: Ticker,
        input: PriceInput,
    ) -> TxResult {
        let ix = ix_publish_price(&signer.pubkey(), ticker, input);
        self.send(&[ix], &[signer])
    }

    pub fn publish_close(
        &mut self,
        signer: &Keypair,
        ticker: Ticker,
        trading_day: u32,
        close_ts: i64,
        first: Pubkey,
        second: Option<Pubkey>,
    ) -> TxResult {
        let ix = ix_publish_close(
            &signer.pubkey(),
            ticker,
            trading_day,
            close_ts,
            first,
            second,
        );
        self.send(&[ix], &[signer])
    }

    pub fn publish_latest(
        &mut self,
        signer: &Keypair,
        ticker: Ticker,
        input: PriceInput,
    ) -> TxResult {
        let ix = ix_publish_latest(&signer.pubkey(), ticker, input);
        self.send(&[ix], &[signer])
    }
}

// Addresses.

pub fn program_data_address() -> Pubkey {
    let loader = Pubkey::from_str_const("BPFLoaderUpgradeab1e11111111111111111111111");
    Pubkey::find_program_address(&[meridian_oracle::ID.as_ref()], &loader).0
}

pub fn registry_pda() -> Pubkey {
    Pubkey::find_program_address(&[SIGNERS_SEED], &meridian_oracle::ID).0
}

pub fn price_pda(signer: &Pubkey, ticker: Ticker, publish_time: i64) -> Pubkey {
    Pubkey::find_program_address(
        &[
            PRICE_SEED,
            signer.as_ref(),
            &ticker,
            &publish_time.to_le_bytes(),
        ],
        &meridian_oracle::ID,
    )
    .0
}

pub fn close_pda(signer: &Pubkey, ticker: Ticker, trading_day: u32) -> Pubkey {
    Pubkey::find_program_address(
        &[
            CLOSE_SEED,
            signer.as_ref(),
            &ticker,
            &trading_day.to_le_bytes(),
        ],
        &meridian_oracle::ID,
    )
    .0
}

pub fn latest_pda(signer: &Pubkey, ticker: Ticker) -> Pubkey {
    Pubkey::find_program_address(
        &[LATEST_SEED, signer.as_ref(), &ticker],
        &meridian_oracle::ID,
    )
    .0
}

// Instruction builders.

fn system_program() -> Pubkey {
    Pubkey::default()
}

fn build(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction {
        program_id: meridian_oracle::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

pub fn ix_initialize_registry(authority: &Pubkey, admin: Pubkey) -> Instruction {
    build(
        accounts::InitializeRegistry {
            authority: *authority,
            registry: registry_pda(),
            program: meridian_oracle::ID,
            program_data: program_data_address(),
            system_program: system_program(),
        },
        instruction::InitializeRegistry { admin },
    )
}

pub fn ix_add_signer(admin: &Pubkey, signer: Pubkey) -> Instruction {
    build(
        accounts::UpdateRegistry {
            admin: *admin,
            registry: registry_pda(),
        },
        instruction::AddSigner { signer },
    )
}

pub fn ix_remove_signer(admin: &Pubkey, signer: Pubkey) -> Instruction {
    build(
        accounts::UpdateRegistry {
            admin: *admin,
            registry: registry_pda(),
        },
        instruction::RemoveSigner { signer },
    )
}

pub fn ix_publish_price(signer: &Pubkey, ticker: Ticker, input: PriceInput) -> Instruction {
    ix_publish_price_at(
        signer,
        ticker,
        input,
        price_pda(signer, ticker, input.publish_time),
    )
}

/// `publish_price` with an explicit `price_update` address, to test the seed checks.
pub fn ix_publish_price_at(
    signer: &Pubkey,
    ticker: Ticker,
    input: PriceInput,
    price_update: Pubkey,
) -> Instruction {
    build(
        accounts::PublishPrice {
            signer: *signer,
            registry: registry_pda(),
            price_update,
            system_program: system_program(),
        },
        instruction::PublishPrice { ticker, input },
    )
}

pub fn ix_publish_close(
    signer: &Pubkey,
    ticker: Ticker,
    trading_day: u32,
    close_ts: i64,
    first: Pubkey,
    second: Option<Pubkey>,
) -> Instruction {
    ix_publish_close_at(
        signer,
        ticker,
        trading_day,
        close_ts,
        first,
        second,
        close_pda(signer, ticker, trading_day),
    )
}

/// `publish_close` with an explicit `close_record` address, to test the seed checks.
pub fn ix_publish_close_at(
    signer: &Pubkey,
    ticker: Ticker,
    trading_day: u32,
    close_ts: i64,
    first: Pubkey,
    second: Option<Pubkey>,
    close_record: Pubkey,
) -> Instruction {
    build(
        accounts::PublishClose {
            signer: *signer,
            registry: registry_pda(),
            close_record,
            first_update: first,
            second_update: second,
            system_program: system_program(),
        },
        instruction::PublishClose {
            ticker,
            trading_day,
            close_ts,
        },
    )
}

pub fn ix_publish_latest(signer: &Pubkey, ticker: Ticker, input: PriceInput) -> Instruction {
    build(
        accounts::PublishLatest {
            signer: *signer,
            registry: registry_pda(),
            latest_price: latest_pda(signer, ticker),
            system_program: system_program(),
        },
        instruction::PublishLatest { ticker, input },
    )
}

// Inputs and assertions.

/// A regular-session price of `price / 100` with a 1-cent confidence.
pub fn regular(price: i64, publish_time: i64) -> PriceInput {
    PriceInput {
        price,
        conf: 1,
        expo: -2,
        publish_time,
        session: Session::Regular,
        official_close: false,
    }
}

pub fn official(price: i64, publish_time: i64) -> PriceInput {
    PriceInput {
        official_close: true,
        ..regular(price, publish_time)
    }
}

pub fn custom_code(error: OracleError) -> u32 {
    error.into()
}

/// Asserts that the transaction failed with the given program error.
#[track_caller]
pub fn assert_oracle_error(result: TxResult, expected: OracleError) {
    let code = custom_code(expected);
    match result {
        Err(TransactionError::InstructionError(_, InstructionError::Custom(actual))) => assert_eq!(
            actual, code,
            "expected {expected:?} ({code}), got custom error {actual}"
        ),
        other => panic!("expected {expected:?} ({code}), got {other:?}"),
    }
}
