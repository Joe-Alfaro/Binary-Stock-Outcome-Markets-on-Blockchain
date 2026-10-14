# Meridian

Meridian lets you trade same-day binary contracts on the closing prices of seven US stocks: AAPL,
MSFT, GOOGL, AMZN, NVDA, META and TSLA. Each contract asks one question: "Will [TICKER] close at or
above [STRIKE] today?" A Yes token pays $1.00 USDC if it does. A No token pays $1.00 USDC if it
doesn't. A close exactly at the strike pays Yes.

It runs on Solana devnet only. There is no mainnet deployment and no real money, and every deploy,
bootstrap and demo script refuses to run against mainnet. Meridian makes no regulatory or compliance
claims. This is not financial advice.

How it works, in one paragraph: every trading morning a worker creates one market per strike. Anyone
can deposit $1.00 USDC to mint a Yes + No pair, trade Yes against USDC on an on-chain order book,
and merge a pair back into $1.00 before settlement. After the 4:00 PM ET close a price relay
publishes the closing price on-chain, the market settles from it, and winners redeem their tokens
for $1.00 each from a fully collateralized vault.

[ARCHITECTURE.md](ARCHITECTURE.md) has the full design: accounts, instructions, invariants, the
closing-price rule and the test strategy. This README covers running it and the main trade-offs.
[AGENTS.md](AGENTS.md) has the contribution rules and quality gates.

## What's in the repo

| Path                       | What it is                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `programs/meridian`        | Anchor program: config, strike markets, Yes/No mints, USDC vaults, order books, mint/merge/redeem, settlement, admin fallback, pause  |
| `programs/meridian_oracle` | Anchor program for the price relay: signer registry, append-only price updates, write-once close records, one latest price per ticker |
| `crates/meridian-math`     | `no_std` Rust crate with the closing-price rule, payout rule and strike ladder                                                        |
| `packages/sdk`             | TypeScript twin of the math, the four trade-path transaction builders, the No view of the book, P&L replay and the mainnet guard      |
| `packages/price-providers` | Price sources: the Yahoo chart API, a `mock` source that replays fixtures, and Pyth and Chainlink normalizers                         |
| `services/automation`      | Worker: trading calendar, morning job, settlement job, relay publisher, alert sinks, `/healthz` and the chart's intraday price route  |
| `app`                      | Next.js web app                                                                                                                       |
| `scripts`                  | `make dev`, `make deploy-devnet`, `make demo`, the config bootstrap and the mainnet guard                                             |

Markets use whole cents. An order's price is the Yes price, 1 to 99 cents. The No price is always
100 minus the Yes price, and the app shows the book from the No side too.

Strikes for each ticker are the previous close rounded to $10, plus that close ±3%, ±6% and ±9%,
each rounded to $10, then deduplicated.

## Setup

You need Rust (the version in `rust-toolchain.toml`), the Solana CLI, Anchor 1.2.1 and Node 22.12
or newer (`.nvmrc` pins 24).

```sh
npm install
anchor keys sync            # program keypairs are not committed; this makes yours
cp .env.example .env
```

Create the role keys and point `.env` at them. Each must be a different keypair. The `keys/`
folder is ignored by git.

```sh
mkdir -p keys
solana-keygen new --no-bip39-passphrase -o keys/admin.json
solana-keygen new --no-bip39-passphrase -o keys/automation.json
solana-keygen new --no-bip39-passphrase -o keys/relay-1.json
# then set ADMIN_KEYPAIR, AUTOMATION_KEYPAIR and RELAY_SIGNER_1_KEYPAIR in .env to these paths
```

`ANCHOR_WALLET` is the upgrade authority that deploys the programs and signs `initialize_config`.
Leave it empty to use the Solana CLI default, `~/.config/solana/id.json`.

Then one command runs everything locally:

```sh
make dev
```

`make dev` starts a local validator, builds and deploys both programs, bootstraps config with a mock
USDC mint, creates sample AAPL and MSFT markets that close in 30 minutes, then starts the worker
(with the `mock` price source and demo mode on) and the web app. The validator uses
`LOCAL_VALIDATOR_RPC_PORT` (default 8913, WebSocket on the next port, faucet on the one after),
gossip on the RPC port + 400 and a 40-port dynamic range just above it, and refuses ports that
touch 8899, 8900, 9900 or 9600-9650. The worker and the web app get the program IDs from the
keypairs just deployed, and the web app gets relay signer 1's public key (never its secret) for
live prices. On a local validator the script airdrops SOL to every role key, so no funding is
needed. `make dev ARGS=--dry-run` prints the steps without running them.

`make gates` runs every quality gate (formatting, lint, type checks, clippy and all test suites).
`make test` runs only the tests. `make e2e` runs the Playwright specs locally against a private
validator and `next dev` with a flag-gated test wallet; it isn't part of the MR pipeline.

## Devnet funding

Devnet needs two things: SOL for fees and rent, and USDC to trade.

**SOL.** Airdrop devnet SOL to the upgrade authority, admin, automation and relay keys:

```sh
solana airdrop 2 <PUBKEY> --url devnet
```

The airdrop is rate-limited. If it fails, wait and retry, or use the web faucet at
`https://faucet.solana.com`. Measured rent is 0.035 SOL per market (the market, both mints, the
vault, the book and the two escrows) and 1.74 SOL per trading day (49 markets across the seven
tickers plus their `TickerDay` accounts). It isn't reclaimed, so only run the morning job on devnet
when you need it.

**USDC.** On devnet the bootstrap uses Circle's devnet USDC mint
(`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) unless `USDC_MINT` is set. Fund a wallet from
Circle's faucet at `https://faucet.circle.com` (choose Solana Devnet). The faucet needs a manual
request per wallet, so for an unfunded run pass `--mock-usdc`: the bootstrap then creates a mock
USDC mint (6 decimals) with the admin as mint authority, and the demo mints its own test USDC from
it. Local `make dev` always uses a mock mint.

## Devnet deploy

```sh
make deploy-devnet                    # Circle devnet USDC
make deploy-devnet ARGS=--mock-usdc   # mock USDC mint instead
```

This checks the mainnet guard, runs `anchor build` and `anchor deploy` to devnet, reads the program
IDs from `anchor keys list` and writes them to `Anchor.toml` and `.env`, then bootstraps config:
the seven tickers, oracle slot 1 as the relay with relay signer 1, slot 2 disabled, a 300 s
staleness limit, a 1% confidence limit, and the 15 and 60 minute admin delays. Last, it registers
the relay signers in `meridian_oracle`. The admin, automation and relay keys must be distinct, and
the script checks that before it sends anything.

**Hosting.** The web app and the worker are meant to run as two Railway services, configured in
`app/railway.json` and `services/automation/railway.json` with build and start commands and health
checks (`/` and `/healthz`). Both services have been built and started locally to check the config.
Railway builds from a clean checkout without `target/`, so the worker ships both program IDLs in
`services/automation/idl/`; run `make ship-idls` after changing a program's interface.
The first live Railway deploy waits for the user's confirmation, so there is no public URL yet.

**Markets chart.** Each Markets card charts its ticker's price for today's session while the market
is open, else the last complete session. The browser reads the series only from the worker's
`GET /prices/intraday/<ticker>` on the health server, at `NEXT_PUBLIC_PRICE_API_URL`. The worker
proxies the relay source (Yahoo 1-minute bars, or a synthetic offline series in mock mode) and
caches each ticker for 60 s, so there is at most one upstream request per ticker per minute. The
chart is a plain SVG line with no charting dependency.

## Lifecycle demo

```sh
make demo                  # against SOLANA_CLUSTER (devnet by default)
make demo ARGS=--dry-run   # the same steps against a built-in fake chain
```

`make demo` runs one full market lifecycle in a few minutes instead of waiting for a real 4:00 PM
close:

1. Creates an AAPL market whose close is 90 seconds away. The relay replays the recorded AAPL close
   of 2026-10-12, $340.97, re-stamped to the demo close, and the strike is one dollar over it
   ($341.97), so the replayed close settles No.
2. Funds two fresh wallets, a trader and a counterparty, and the counterparty mints 10 Yes + No
   pairs.
3. Runs the four trade paths. Before each one the counterparty quotes it, then the trader takes the
   quote with the same SDK transaction the web app sends: Buy Yes 2, Sell Yes 2, Buy No 2 (mint
   pairs and sell their Yes) and Sell No 1 (buy Yes and merge the pairs back into USDC). After
   every step it records both wallets' balances and stops if a path doesn't fill as promised.
4. Waits for the close, publishes the replayed close through the relay signer, settles the market and
   redeems the trader's remaining No for its payout.

It prints every transaction's signature, explorer link and confirmation time, and the settlement
delay measured from the close. The demo refuses any cluster other than localnet or devnet. Demo
markets are flagged on-chain, and the relay logs the replayed price as replayed. The 2026-10-12
close was transcribed from one live chart API response (`origin: recorded-transcribed` in
`packages/price-providers/fixtures/provenance.json`); the worker in demo mode replays the same close
for AAPL and the hand-written fixtures for MSFT.

Known gaps: the demo has not been run end to end on devnet. `tests/demo.test.ts` runs it on a local
validator and checks every path's fill from the confirmed transactions.

## Why Solana

The order book lives on-chain, and every order, cancel and fill is a transaction. That needs fast,
cheap blocks.

- **Solana:** about 400 ms blocks and sub-second confirmation at `confirmed`, fees of a fraction of
  a cent, and Anchor for safe account handling. The project spec also prefers it.
- **An EVM L2** (Arbitrum, Base): cheap enough and with mature tooling, but an on-chain order book
  pays gas for every order and cancel, and the L2 still depends on its sequencer and on L1 for
  finality. It would need extra work to match Solana on order book latency.
- **HyperLiquid:** has a fast native order book, but it may not support custom instruments like a
  new contract per strike per day.

Solana's main costs here are account rent (each market and book is an account, 1.74 SOL per
trading day on devnet) and a 1,232-byte transaction size limit, which the four trade-path
transactions fit within.

## Price oracle

Settlement needs a closing price on-chain. Meridian has two oracle slots. In the MVP, slot 1 runs
our own **Meridian Price Relay** and slot 2 is disabled.

**Why a custom relay.** When this was built, no third-party oracle could be used on devnet without
cost or credentials the project doesn't have: Pyth's US equity feeds need a paid plan (about
$500/month), Chainlink Data Streams needs streams assigned to the account, and other Solana oracles
had no suitable US equity feeds. The relay is free and exercises the same settlement path a
third-party oracle would.

**How it works.** A publisher in the worker reads prices from the Yahoo chart API and signs them
into `meridian_oracle`: append-only `PriceUpdate`s and one write-once `CloseRecord` per signer,
ticker and day. `settle_market` accepts only that canonical close record, so the caller can't pick
the input. The price is the official close if the source reports one, else a regular-session price
stamped exactly at the close, else a linear interpolation between regular-session prices within 5
minutes on each side. Comparisons with the strike use exact integer math. The first strike to
settle fixes the price for every strike of that ticker and day. During market hours the relay also
updates one `LatestPrice` account per ticker, about every 30 seconds, for the app's live prices.

**The trust trade-off.** The relay is a centralized oracle with one data source and one signer key.
A false close record would settle markets, and settled outcomes are final. Nothing on-chain stops
that in the MVP. What limits it: every published price and close record is public, records can't be
rewritten, only regular-session prices near the close are accepted, the relay signer is a separate
key, and the admin fallback and alerts cover a missing price.

**Switching a slot to Pyth or Chainlink Data Streams.** It takes `update_config` plus worker env
vars, with no code change. The worker reads `ORACLE_SLOT_1` and `ORACLE_SLOT_2` at start and refuses
to start, naming the variable, when a kind is unknown or a setting it needs is missing or malformed.
It settles each slot by its kind: a relay slot through `settle_market` with the relay `CloseRecord`;
a Pyth slot by reading the Hermes update at `close_ts`, posting it through the Pyth receiver as a
`PriceUpdateV2` account and passing that account to `settle_market`; a Data Streams slot by fetching
the signed report at `close_ts` and sending its `fullReport` to `settle_market_with_reports`. A slot
set to `disabled` in the env is never polled, whatever `Config` says. Steps, outside market hours so
no ticker-day is half-settled under the old slot:

1. Get the provider account: a Pyth plan entitled to US equities (an access token), or Data Streams
   credentials (user ID and HMAC secret) with the US equity streams assigned.
2. As the admin, call `update_config` with the new `oracle_slots` (there's no admin CLI yet, so use
   the Anchor client as `tests/worker_pyth_slot.test.ts` does). For Pyth: `kind: { pyth: {} }`,
   `feedIds` in `Config.tickers` order, `verifierProgram` = the receiver program, and
   `minVerificationLevel: 0` (full Wormhole verification). For Data Streams:
   `kind: { chainlinkDataStreams: {} }`, the stream IDs as `feedIds`, and `verifierProgram` = the
   verifier program. Leave every other argument `null`.
3. Set the worker env (see `.env.example`). For Pyth: `ORACLE_SLOT_1=pyth`,
   `PYTH_RECEIVER_PROGRAM_ID`, `PYTH_FEED_IDS` (`AAPL=<64 hex>,MSFT=<64 hex>,…`) and
   `PYTH_ACCESS_TOKEN`; `PYTH_HERMES_URL` is optional. For Data Streams: `ORACLE_SLOT_1=chainlink`,
   `CHAINLINK_VERIFIER_PROGRAM_ID`, `CHAINLINK_STREAM_IDS`, `CHAINLINK_DATA_STREAMS_USERNAME` and
   `CHAINLINK_HMAC_SECRET`; `CHAINLINK_DATA_STREAMS_URL` and `CHAINLINK_ACCESS_CONTROLLER_ID` are
   optional. To keep the relay in slot 1, use slot 2 and `ORACLE_SLOT_2` instead.
4. Restart the `automation` service. It fails fast if step 3 is incomplete.
5. Check that the next close settles with `settle_source` equal to the switched slot.

Rolling back is the same steps with `kind: { meridianRelay: {} }` and the relay signer, and
`ORACLE_SLOT_1=relay`. On a third-party slot the first settle needs the automation authority or the
admin, which is the worker's signer. [ARCHITECTURE.md §5.6](ARCHITECTURE.md#56-switching-a-slot-to-pyth-or-chainlink)
lists the feed IDs and stream schema. Known gaps: posted `PriceUpdateV2` accounts aren't closed, so
their rent isn't reclaimed, and the Data Streams path is tested against a mock verifier only (no
provisioned streams were available).

## Settlement schedule

All times are relative to the market's close (`close_ts`, normally 4:00 PM ET; early-close days use
their own time). The schedule runs per ticker and day, since one price settles every strike.

| Time    | What happens                                                                                                                                                                                                                                                         |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| +0      | The worker polls oracle slot 1 every 30 s and calls `settle_market` as soon as a valid close record exists. The relay publishes an official close as soon as it has one, and waits until +3 min before falling back to an exact-time price or an interpolation pair. |
| +4 min  | Slot 2 would also be polled every 30 s. Skipped while slot 2 is disabled.                                                                                                                                                                                            |
| +15 min | No valid price yet: the first admin alert, sent once. Polling slows to once every 3 minutes per slot. The admin can now propose the exchange's official closing price with `propose_admin_price`.                                                                    |
| +50 min | Still no price: the second admin alert.                                                                                                                                                                                                                              |
| +60 min | A pending admin price can be finalized with `finalize_admin_settle`, and the worker then settles every strike. Without a proposal, polling continues until an oracle answers or the admin proposes.                                                                  |

An oracle answer always beats a pending admin price. If they differ, the program emits
`AdminPriceMismatch` and the worker alerts. With the relay working, every market settles within
about 5 minutes of the close. The worker reads everything from the chain and works out each phase
from the clock, so a restart doesn't lose its place: it can repeat an alert, but not skip one.

**Alert sinks.** Two exist: a log sink that writes each alert as one JSON line, always on, and a
webhook sink that POSTs JSON to `ALERT_WEBHOOK_URL` when it's set. There is no email, SMS or chat
sink; new ones implement the same interface. A failing sink is logged and never stops the worker.

## Finality and commitment

The app, the relay and the demo wait for `confirmed` commitment, not `finalized`. On Solana,
`confirmed` means a supermajority of stake has voted on the block, which usually takes under a
second. `finalized` waits for about 31 more confirmed blocks, roughly 13 seconds, and a confirmed
block being rolled back is very unlikely. For a trading UI the sub-second answer matters
more than that extra margin. The demo prints each transaction's confirmation time so you can check
it.

## The merge_pair deviation

The source spec says Yes and No tokens are destroyed only by redeeming them after settlement.
Meridian adds a second way out: `merge_pair(n)` burns `n` Yes and `n` No from the caller and pays
back `n` × $1.00 USDC from the vault, at any time before settlement (including while trading is
paused). This is a deliberate deviation. Without it, someone holding a pair has $1.00 locked until
the close for no reason, and the Buy No and Sell No paths would leave stray pairs behind.

`merge_pair_up_to(max_n, keep_yes)` is the same burn, sized on-chain. Sell No and market Buy No use
it to merge exactly the Yes their own transaction added, because the fill size isn't known when the
transaction is built. Mint, merge and redeem are the only instructions that create or burn Yes and
No, and the vault's collateral counter always covers every outstanding pair.

## Vault donations and direct burns

Two things can happen to a market's tokens that Meridian doesn't control, and neither breaks it.

**USDC donated to a vault.** Anyone can send USDC straight to a market's vault with the token
program. The program never reads the vault balance: mint, merge and redeem use the market's
internal `collateral` counter, which only mint adds to. A donation is never paid out. Merge still
pays exactly $1.00 a pair, winners still redeem exactly $1.00 a token, and the donated USDC stays in
the vault after the last redemption. The validator test `tests/measurements.test.ts` donates 5 USDC
and then mints, merges, trades, settles and redeems in one scenario with exact payouts.

**Yes or No burned directly.** A holder can burn their own Yes or No with the token program,
outside Meridian. The market keeps working: mint, merge, settlement and redeem are unaffected, and
the counter still covers every token left. The $1.00 behind each burned token simply stays in the
vault, unpaid.

## Adjusting strikes

The admin adjusts a day's strike ladder only by adding strikes with `add_strike`, which is allowed
until the close. No instruction changes an existing market's strike, so a strike someone already
trades against never moves.

## Dependencies

Every direct dependency in the npm and Cargo manifests, with the reason it's there.

### Programs (Rust)

| Crate             | Why                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `anchor-lang`     | Account validation, PDAs, instruction dispatch and IDL generation for both programs        |
| `anchor-spl`      | SPL Token and associated token account CPIs for the Yes/No mints and USDC vaults           |
| `bytemuck`        | Zero-copy casting of the large order book account without deserializing it                 |
| `meridian-math`   | Our own crate: the closing-price, payout and strike rules shared by the programs and tests |
| `meridian_oracle` | Our relay oracle program, imported so `meridian` can read its close records                |
| `litesvm`         | Fast in-process Solana VM for program tests, without a local validator (dev only)          |
| `proptest`        | Property tests running thousands of random prices and strikes against the math (dev only)  |

### Web app

| Package                                            | Why                                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| `next`                                             | React framework, routing and production server for the web app          |
| `react`, `react-dom`                               | UI rendering for the pages and components                               |
| `jsdom`                                            | DOM implementation so component tests run under `node:test`             |
| `@testing-library/react`, `@testing-library/dom`   | Render components and query them the way a user sees them               |
| `@testing-library/user-event`                      | Simulates realistic clicks and typing in component tests                |
| `axe-core`                                         | Accessibility rule engine run against rendered components in tests      |
| `@playwright/test`                                 | Browser end-to-end tests against the running app                        |
| `@axe-core/playwright`                             | Runs the accessibility checks inside Playwright browser tests           |
| `@types/react`, `@types/react-dom`, `@types/jsdom` | TypeScript types for React, React DOM and jsdom                         |
| `@solana/wallet-adapter-base`                      | Shared wallet adapter interface and network names for the wallet button |
| `@solana/wallet-adapter-phantom`                   | Connects and signs with the Phantom browser wallet                      |
| `@solana/wallet-adapter-solflare`                  | Connects and signs with the Solflare browser wallet                     |

### SDK, worker and scripts

| Package                             | Why                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| `@solana/web3.js`                   | Solana RPC, keypairs and transaction building in the SDK, worker and scripts    |
| `@anchor-lang/core`                 | Anchor TypeScript client for calling the programs from the IDLs                 |
| `bs58`                              | Decodes base58 secret keys passed through environment variables                 |
| `tsx`                               | Runs TypeScript directly for the worker, scripts and tests without a build step |
| `@pythnetwork/pyth-solana-receiver` | Posts Hermes updates as verified `PriceUpdateV2` accounts when a slot is Pyth   |

### Tooling and tests

| Package                       | Why                                                         |
| ----------------------------- | ----------------------------------------------------------- |
| `typescript`                  | Type checking for every workspace                           |
| `@types/node`                 | TypeScript types for Node.js built-in modules               |
| `eslint`, `@eslint/js`        | Lints all TypeScript and JavaScript in the repo             |
| `typescript-eslint`           | ESLint parser and rules for TypeScript code                 |
| `@next/eslint-plugin-next`    | Next.js specific lint rules for the web app                 |
| `eslint-config-prettier`      | Turns off lint rules that conflict with Prettier            |
| `globals`                     | Browser and Node global names for the ESLint config         |
| `prettier`                    | Enforces one code format across the repo                    |
| `husky`                       | Runs `make gates` in a git pre-push hook                    |
| `mocha`, `chai`               | Test runner and assertions for the Anchor integration tests |
| `@types/mocha`, `@types/chai` | TypeScript types for Mocha and Chai in integration tests    |

## Status

Built and tested: both programs (markets, mint and merge, the order book, the four trade paths,
settlement, the admin fallback and redeem), the on-chain Pyth and Data Streams price adapters, the
shared math in Rust and TypeScript, the SDK trade builders, redeem, cancel and close-out builders
and trading logic, the price sources, the trading calendar, alert sinks, morning and settlement
jobs, the relay publisher, the ops scripts, and the web app (Landing, Markets, Trade, Portfolio and
History pages, Phantom and Solflare wallets, live book and prices, and unwinding a resting order or
a Yes+No position on the Trade page before settlement), and demo mode (an admin toggle that lets
markets use custom times; otherwise the program enforces the regular schedule). The web app trades,
unwinds and redeems through the SDK builders. The worker runs the morning job scheduler, the
settlement loop, the slot-1 relay (close records once a market's `close_ts` passes, and latest
prices every 30 s in the session) and a per-minute collateral and supply audit that alerts
`invariant_failure`. Each oracle slot settles through the provider its env names
(`ORACLE_SLOT_1` and `ORACLE_SLOT_2`: the relay, Pyth through the receiver program, or Data Streams
through the verifier), with no code change to switch. It ships both IDLs in `services/automation/idl` (`make ship-idls`), so a
deploy starts without `target/`. Lifecycle integration tests on a local validator cover create,
mint, the four trade paths, the relay close, settlement, the admin fallback, redeem and both jobs
against the real chain client; a validator test measures rent and compute and checks that a vault
donation can't change payouts. `make dev` runs the whole stack on its own ports, `make demo` replays the recorded AAPL close of
2026-10-12 and fills all four trade paths, and `make e2e` drives the web app in a browser. Close out orders and redeem
is one transaction unless the wallet has more resting orders than fit in one; then the wallet
approves each transaction in order.

Not finished yet:

- The admin CLI (config updates, propose and finalize admin price, pause).
- A devnet run of `make demo`, and the first Railway deploy.

## Risks and limitations

- **One oracle, one source, one signer.** The relay is trusted. A wrong close record would settle
  markets for good. Slot 2 is disabled, so there's no second source to cross-check, and if Yahoo is
  down at the close nothing settles until the admin fallback at +15 and +60 minutes.
- **Unofficial price API.** The Yahoo chart API is undocumented and can change, rate-limit or
  disappear without notice. It answered 429 to every scripted attempt to record real responses, so
  the price fixtures in `packages/price-providers/fixtures` are hand-written in its format rather than
  captured, and marked `hand-written` in `fixtures/provenance.json`. The one exception is the AAPL
  close of 2026-10-12 the demo replays, whose values were transcribed from a single live response. Run `npm run record-fixtures` in
  `packages/price-providers` to replace them with real captures when the API answers.
  Its terms don't clearly allow republishing prices; that is acceptable for a devnet project with no
  real money, but any use beyond devnet needs a licensed data source. It may also block cloud IP
  ranges, which would stop live prices on a hosted worker.
- **Interpolation is thin.** Yahoo's one-minute bars often have no price after the close, so the
  interpolation fallback is often unavailable when there's no official close. The admin fallback
  covers that.
- **Order book capacity.** Each book holds 32 orders per side and 32 trader seats. A busy strike
  can fill up; seats are released by `settle_funds`. A large order against a deep book can stop at
  the 16-fill cap and need a second transaction. A market order sweeping all 16 fills from 16
  makers used about 140,000 compute units on the local validator (136,033 and 139,033 in two runs) (87,811 for the instruction alone in
  LiteSVM), well under the 1.4M per-transaction limit.
- **Devnet costs and limits.** Rent is 1.74 SOL per trading day and isn't reclaimed. Devnet
  faucets and public RPCs are rate-limited; set `SOLANA_RPC_URL` to a dedicated RPC if needed.
- **Alerts go only to logs and an optional webhook.** Nobody is paged unless a webhook is
  configured and watched.
- **No fees, no database, no indexer.** History and P&L are rebuilt in the browser from program
  events, which gets slower as history grows.
- **Not audited.** The programs have unit, property and integration tests but no external review.
  Use devnet tokens only.
