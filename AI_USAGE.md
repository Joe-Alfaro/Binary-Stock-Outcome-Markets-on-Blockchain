# AI usage log

One entry per merged change: what AI tools did and what a human reviewed or changed. Newest first.

## 2026-10-14 — Alpaca market-data source (`feat/alpaca-source`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** the test worker recorded small Alpaca fixtures (9 REST requests, 2 short
  websocket sessions, no credentials) and wrote red tests for R67 against them and a local fake
  websocket server. The implementation worker, without changing the tests, wrote the Alpaca
  source: REST bars, previous close and settlement inputs (SIP where the free plan allows it,
  IEX otherwise, never after-hours), a websocket stream client with auth, subscribe and bounded
  reconnect backoff, one batched snapshot while the stream is down, the env config
  (`ALPACA_DATA_URL` and `ALPACA_STREAM_URL`, never the trading endpoint), and the default-source
  rule (alpaca with keys, else mock). The worker closes the stream on stop. Updated the README,
  `ARCHITECTURE.md` and `.env.example`.
- **Human review:** pending MR review.

## 2026-10-13 — Intraday price chart on Markets cards (`feat/markets-chart`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** the test worker wrote 45 red tests for R66 (session selection with an
  injected clock in a non-ET zone, the worker's intraday route and its 60 s cache and 429
  handling, the Yahoo and mock series, the app client and the card chart). The implementation
  worker, without changing the tests, wrote `chartSession` on the trading calendar, the Yahoo
  1-minute `intraday` series and an offline synthetic series for the mock and demo-replay
  sources, the cached `createIntradayService` behind `GET /prices/intraday/<ticker>` on the health
  server (wired in `main.ts` with its own relay source), the app's `createIntradayClient` and a
  dependency-free SVG line chart on each Markets card with a session label, signed change,
  dashed open line, hover readout and a text alternative.
- **Human review:** pending MR review.

## 2026-10-13 — MVP integration branch (`integration/mvp`)

- **Tool:** Claude Code (Claude Opus 5.5), running as orchestrator and implementation workers.
- **What the AI did:** collected the MVP feature branches on one integration branch before they
  reached `main` (docs, web, devnet run, demo mode, redeem builder, lifecycle, oracle adapters,
  worker wiring, unwind, dev-demo, docs-measure, e2e, slot config, real close and time-of-day),
  resolved the merge conflicts, merged the two `[test]` tables in `Anchor.toml`, regenerated the
  shipped IDLs and updated the README status. Each feature branch has its own entry below; this
  entry was added afterwards because the branch's merge into `main` had none.
- **Human review:** pending MR review.

## 2026-10-13 — Close-out-and-redeem on a real chain and in the browser (`feat/closeout-chain`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** the test worker added `tests/closeout.test.ts` (close-out-and-redeem on the
  shared validator, one-transaction and split cases), a settled demo market in the e2e stack and
  the R52 Portfolio browser spec. The implementation worker, without changing those tests, made
  the header USDC balance follow the chain: `useUsdcBalance` re-reads it at `confirmed` after
  every transaction `useTransaction` confirms (trade, cancel, close-out, redeem), on an account
  subscription to the wallet's USDC token account, and every 15 s as a fallback. Added unit
  tests for the refresh and the subscription; `make e2e` passed 5/5 twice.
- **Human review:** pending MR review.

## 2026-10-13 — The demo replays the recorded AAPL close of 2026-10-12 (`feat/real-close`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** the test worker wrote red tests for R44's recorded demo close, a
  `recorded-transcribed` provenance shape and a docs check that nothing else is called recorded.
  The implementation worker, without changing the tests, added the transcribed fixture
  `AAPL-2026-10-12-close.json` ($340.97) with its provenance entry, wrote `createDemoReplaySource`
  (re-stamps the close to the demo `close_ts`, falls back to the hand-written fixtures for other
  tickers), had `createRelaySource` return it in `DEMO_MODE`, switched the demo chain client to it,
  made `make demo` print the replayed close and the $341.97 strike, and corrected both READMEs.
  Logged the choices as D72.
- **Human review:** pending MR review.

## 2026-10-13 — Env-switched oracle slots in the worker (`feat/slot-config`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** the test worker wrote 32 red tests for R32 (slot env parsing, the Hermes and
  Data Streams HTTP clients, settle dispatch by slot kind, env-disabled slots, `startWorker`
  validation, and a validator test that settles through a Pyth slot). The implementation worker,
  without changing the tests, added `loadOracleSlotSettings`, the Hermes provider (Bearer token)
  and Data Streams client (HMAC headers, User-Agent), made the chain client settle each slot by its
  on-chain kind, kept env-disabled slots out of the settlement job, posted Pyth updates through the
  receiver SDK in production, and documented the switching steps. Logged the choices as D75.
- **Human review:** pending MR review.

## 2026-10-13 — On-chain Pyth and Data Streams price adapters (`feat/oracle-adapters`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** the test worker wrote 20 LiteSVM tests for R32 (9 Pyth, 11 Data Streams)
  with byte-exact Pyth `PriceUpdateV2` accounts and a native mock Data Streams verifier. The
  implementation worker, without changing the tests, added a `price_adapter` module that turns
  relay close records, Pyth receiver accounts and CPI-verified v11 reports into
  `NormalizedPrice`, implemented `settle_market_with_reports`, and moved `settle_market` onto one
  shared oracle-agnostic closing-price, finalize and outcome path. Third-party slots need the
  automation authority or admin for the first settle. A two-report settle uses about 19k CU.
- **Human review:** pending MR review.

## 2026-10-13 — Worker relay wiring, invariant alerts and shipped IDLs (`feat/worker-wiring`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** without changing the tests, made `startWorker` require
  `RELAY_SIGNER_1_KEYPAIR` and run the slot-1 relay: a close publisher driven by open markets past
  `close_ts`, and the latest-price loop, which skips tickers the source can't price. Both record
  relay publishes in `/healthz`. Added `listMarketCollateral` to the chain client and a per-minute
  invariant audit that sends `invariant_failure` alerts. Shipped both IDLs in
  `services/automation/idl/` (`make ship-idls`) so a clean deploy starts without `target/`.
  Logged the choices as D69.
- **Human review:** pending MR review.

## 2026-10-13 — Unwind a resting Buy No before settlement (`feat/unwind`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** the test worker wrote red SDK, web and validator tests for cancelling a
  resting order and closing out a Yes+No position before settlement (R28 [G]). The
  implementation worker wrote `buildCancelOrder` (cancel, then `settle_funds`) and
  `buildCloseOutPosition` (cancel every resting order, `settle_funds`, then `merge_pair` for the
  whole pairs the wallet will hold), sharing the in-order packing with the redeem close-out. It
  wired both into the chain client and app services, and added an unwind panel on the Trade page
  with Cancel order, Close out position and the wallet USDC balance. It didn't change the tests.
- **Human review:** pending MR review.

## 2026-10-13 — `make dev` ports and config, and demo fills (`feat/dev-demo`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** the test worker wrote red tests for the validator's gossip and dynamic
  ports, the web app's program IDs and relay signer key, and the demo's four trade paths filling
  against a counterparty (unit tests and an on-chain test). The implementation worker, without
  changing the tests, pinned gossip and a 40-port dynamic range clear of CI's reserved block,
  passed the just-deployed program IDs to the worker and web app and relay signer 1's public key
  to the web app, and rewrote the demo client so a funded counterparty mints and quotes each path
  and the trader takes it with the SDK's Buy Yes, Sell Yes, Buy No and Sell No builders. The demo
  checks each fill and the redeem from both wallets' balances, and its market now settles No so
  the trader's kept No pays out.
- **Human review:** pending MR review.

## 2026-10-13 — README measurements, donation scenario and fixture provenance (`feat/docs-measure`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** the test worker wrote README checks (R6, R13, R19), a validator scenario
  that donates 5 USDC and then mints, merges, trades, settles and redeems, a max-sweep compute
  measurement and a rent check on the local validator, and a Yahoo fixture provenance check (R39).
  The implementation worker, without changing the tests, documented vault donations, direct
  burns, adding strikes and the measured rent (0.035 SOL per market, 1.74 SOL per trading day)
  and compute (about 140,000 units for a 16-fill sweep) in the README, and added
  `fixtures/provenance.json`. It tried to record real Yahoo responses (three requests, all HTTP
  429), so only the 429 body is marked recorded. After R39 was amended (D67) the test worker
  updated the provenance tests, and the implementation worker added `npm run record-fixtures` (a
  polite re-record script with offline tests); the JSON fixtures stay marked hand-written.
- **Human review:** pending MR review.

## 2026-10-13 — make e2e and the E2E test wallet (`feat/e2e`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** the test worker wrote the Playwright specs (axe on Trade and Portfolio, a
  maker's order in the book within 2 s, a UI Buy Yes with one signature) and the node tests for
  the harness plan and the test wallet. The implementation worker wrote `scripts/e2e.ts`
  without changing the tests: a private validator with both programs at genesis, a deploy check,
  bootstrap with a mock USDC mint and demo mode, one demo market with a funded maker and trader,
  then `next dev` on port 3105 and Playwright, with background processes always stopped. It also
  added the flag-gated "E2E test wallet" adapter that signs through a Playwright bridge, and a
  production-build check that fails if that wallet is ever bundled.
- **Human review:** pending MR review.

## 2026-10-12 — Lifecycle integration tests and the automation chain client (`feat/lifecycle`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** the test worker wrote the R57 lifecycle tests against a local validator
  (full lifecycle, the four trade paths, multi-user, admin fallback timing, and the morning and
  settlement jobs on a real chain client). The implementation worker merged demo mode in and,
  without changing the tests, wrote `createAnchorChainClient`: open markets listed with
  `getProgramAccounts` and memcmp filters on status, ticker and day, one `create_strike_market`
  per transaction, `settle_market` with the canonical close record, admin price propose and
  finalize, and pending-price reads, all at `confirmed` with bounded retries. It also wired the
  client into the worker entry point with a daily morning-job scheduler and the settlement loop.
- **Human review:** pending MR review.

## 2026-10-12 — Demo mode (`feat/demo-mode`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** the test worker wrote red LiteSVM tests for `set_demo_mode`, the
  regular-schedule check on market times, admin-only custom times in demo mode and the immutable
  `Market.demo` flag, plus bootstrap and `make dev` tests for `DEMO_MODE`. The implementation
  worker wrote the code to pass them without changing the tests: `set_demo_mode` behind a
  default-on `devnet` feature, an on-chain ET schedule check with the US daylight-saving rule,
  bootstrap's `DEMO_MODE` handling and the chain client call.
- **Human review:** pending MR review.

## 2026-10-12 — SDK redeem and close-out builders (`feat/redeem-builder`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** the test worker wrote red `node:test` tests for `buildRedeem` and
  `buildCloseOutAndRedeem` and LiteSVM tests showing a Yes-only wallet can redeem when the same
  transaction creates its No account. The implementation worker wrote both builders (greedy
  in-order packing when close-out doesn't fit one transaction), moved the shared instruction
  helpers into one module, and wired the builders into the web app: the chain client reads the
  outcome, seat and resting orders, and the Portfolio signs and confirms each close-out
  transaction in order. It didn't change the tests.
- **Human review:** pending MR review.

## 2026-10-12 — README and doc checks (`feat/docs`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the checks, another wrote the docs.
- **What the AI did:** the test worker wrote `node:test` doc checks for the README sections, the
  dependency table (computed from every manifest), regulatory-claim phrases, forbidden names read
  from a file outside the repo, and this log. The implementation worker wrote `README.md` from the
  code on every feature branch, merged or not: setup, devnet funding, deploy, the demo, the chain
  and oracle rationale, the settlement schedule, finality, the `merge_pair` deviation, a
  dependency table that also covers unmerged branches, current status and limitations. It didn't
  change the checks.
- **Human review:** pending MR review.

## 2026-10-12 — Ops scripts and deploy config (`feat/ops`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** the test worker wrote red tests for the mainnet guard, key loading and
  separation, the `.env.example` scan, the deploy, bootstrap, dev and demo scripts, their entry
  points and Makefile targets, the Railway config and the worker health endpoint. The
  implementation worker wrote the code to pass them without changing the tests: the guard
  (cluster name, RPC URL and genesis hash), key loading, the `make dev`, `make deploy-devnet`
  and `make demo` scripts with dry runs, an Anchor-backed chain client for real runs, the
  `/healthz` server, and Railway configs for `web` and `automation`. It validated both services
  locally by building and starting them and hitting their health checks. No devnet run yet:
  the chain client waits on the program packages.
- **Human review:** pending MR review.

## 2026-10-12 — Trade paths (`feat/trade-paths`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** the test worker wrote 22 red LiteSVM tests for the four trade paths and
  `merge_pair_up_to`, and 24 red `node:test` tests pinning the SDK builders. The implementation
  worker wrote `merge_pair_up_to` (merges `min(new Yes, No, max_n)` and shares the burn and
  payout code with `merge_pair`) and the four builders in `packages/sdk/src/tx`: one v0
  transaction signed only by the wallet, a compute unit limit, idempotent token-account creation,
  then `mint_pair` / `place_order` / `settle_funds` / `merge_pair_up_to` as each path needs,
  optional lookup tables, R28 position errors and `RangeError` for invalid orders. It didn't
  change the tests.
- **Human review:** pending MR review.

## 2026-10-12 — Order book (`feat/orderbook`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** the test worker wrote 31 red LiteSVM tests and the zero-copy book, seat,
  order and event stubs for `place_order`, `cancel_order` and `settle_funds`. The implementation
  worker wrote the matching engine to pass them without changing the tests: escrow on placement,
  price-time priority at the maker's price, limit, market and post-only orders, self-trade
  cancels, the 16-match cap, seat claiming and release, owner-only cancel, withdrawals signed by
  the book and one `OrderFilled` event per fill through `emit_cpi!`. It added unit tests for a
  limit order stopped by the fill cap. The maximum sweep uses about 80k compute units.
- **Human review:** pending MR review.

## 2026-10-12 — Settlement (`feat/settlement`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** the test worker wrote 65 red LiteSVM tests and the instruction stubs for
  `settle_market`, `propose_admin_price`, `finalize_admin_settle` and `redeem`. The
  implementation worker wrote the handlers: close-record validation (owner, type, canonical PDA
  for the slot signer, ticker and day, `close_ts`), the closing-price rule and exact outcome
  through `meridian-math`, one final price per ticker and day stored as an exact rational on the
  `TickerDay`, the delayed admin fallback, the `AdminPriceMismatch` event, and redeem paid from
  the collateral counter. Tests were not changed by the implementation.
- **Human review:** pending MR review.

## 2026-10-13 — Settlement math (`feat/math`)

- **Tool:** Claude Code (Claude Opus 5.5), as a TDD pair: one session wrote the red tests and
  shared fixtures, a second implemented them.
- **What the AI did:** implemented the closing-price rule (validation, official close, exact
  timestamp and exact-rational interpolation), the payout rule and the strike ladder in the
  `no_std` crate `crates/meridian-math`, and the bigint TypeScript twin in
  `packages/sdk/src/math`. Both pass the shared fixtures and the property tests (10,000 proptest
  cases in Rust, 2,000 seeded cases in TS). Tests were not changed by the implementation.
- **Human review:** pending MR review.

## 2026-10-12 — Core program (`feat/core`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** the test worker wrote 47 red LiteSVM tests and the account and state
  stubs for config, pause, market creation, `add_strike`, `mint_pair` and `merge_pair`. The
  implementation worker wrote the handlers to pass them without changing the tests: the
  upgrade-authority check, admin-only config updates, one-strike market creation with a shared
  `TickerDay`, and mint and merge backed by a collateral counter. It also added the
  `PairMinted` and `PairMerged` events, reserved space in `Market` for settlement fields and a
  program README.
- **Human review:** pending MR review.

## 2026-10-12 — Web app (`feat/web`)

- **Tool:** Claude Code (Claude Opus 5.5), running as the implementation worker of a TDD pair.
- **What the AI did:** implemented the Next.js app against the test worker's red tests: the
  Landing, Markets, Trade, Portfolio and History pages; the wallet button over the Phantom and
  Solflare adapters; live oracle prices with publish times in ET and a stale marker; contract
  cards with the demo badge and settled outcomes; Yes and No book views from one book, kept live
  by an account subscription with a 1 s polling fallback; the trade panel with the payoff line,
  the position-constraint block and one signature per trade at `confirmed`; plain-language error
  messages; and the portfolio, market-maker and history views over the SDK P&L replay. Added a
  real `ChainClient` over `@solana/web3.js` (account and event decoders without an IDL, with
  their own tests) that takes the SDK transaction builders by interface until they merge.
  Logged its design calls as D48 in the local decisions log.
- **Human review:** pending MR review.

## 2026-10-12 — SDK trading logic (`feat/sdk-logic`)

- **Tool:** Claude Code (Claude Opus 5.5), running as the implementation worker of a TDD pair.
- **What the AI did:** implemented `packages/sdk/src/trading` against the test worker's red tests:
  the No view of the Yes book and executable quotes (R29), the Yes/No position constraint with a
  typed error that still allows cancel and close-out (R28), payoff copy and an ET countdown that
  handles early closes (R51), and an integer-cents P&L replay over program events. In that replay a
  No bought through mint-and-sell has its cost net of the mint, maker fills count, and a
  market-maker exposure view is built from the same replay (R52). Removed the stub lint
  suppressions and logged its implementation choices in the local decisions log.

## 2026-10-12 — Automation jobs (`feat/automation-jobs`)

- **Tool:** Claude Code (Claude Opus 5.5), as a test worker and a separate implementation worker.
- **What the AI did:** the test worker wrote 41 red `node:test` tests for the morning
  market-creation job and the settlement job on a virtual-time clock and an in-memory chain fake,
  with the `ChainClient` interface. The implementation worker wrote `nextMorningRun`,
  `runMorningJob` (6:00 to 8:00 AM ET window, capped exponential backoff, 7:30 alert, stale
  previous close refused), `runSettlementJob` (on-chain discovery, 30 s then staggered 3-minute
  polling per slot, +15 and +50 alerts, admin finalization from +60, AdminPriceMismatch alert)
  and the real clock, without changing the tests.
- **Human review:** pending MR review.

## 2026-10-12 — Trading calendar and alert sinks (`feat/calendar-alerts`)

- **Tool:** Claude Code (Claude Opus 5.5), as a test worker and a separate implementation worker.
- **What the AI did:** the test worker wrote red `node:test` suites for the NYSE calendar (holidays,
  early closes, DST, previous trading day, input validation) and the alert sinks, with interface
  stubs. The implementation worker filled in `services/automation/src/calendar` (checked-in 2026
  and 2027 holiday and early-close data, `America/New_York` session times) and
  `services/automation/src/alerts` (log sink, JSON webhook sink with a timeout, env-based sink
  selection, an alerter that contains sink failures) without changing the tests.
- **Human review:** pending MR review.

## 2026-10-12 — Relay publisher (`feat/relay`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** the test worker wrote 37 red `node:test` tests for the relay close
  sequence, live prices and the demo replay, with a fake oracle, source and clock. The
  implementation worker wrote the publisher without changing those tests: close records after
  `close_ts` (official close first, the interpolation pair from +180 s, 30 s polling, crash
  recovery), the calendar-gated live-price loop with backoff, demo labeling, and an Anchor-backed
  `OracleClient` for `meridian_oracle`. It also added `latest()` to the Yahoo and mock sources,
  writing its own tests for that method and for the client's PDA and argument encoding.
- **Human review:** pending MR review.

## 2026-10-12 — Price providers (`feat/providers`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** the test worker wrote red tests and hand-written fixtures for the Yahoo
  chart source, the `mock` source, `RELAY_<n>_SOURCE` selection, the relay confidence rule and
  the Pyth and Chainlink v11 normalizers. The implementation worker wrote the code to pass them
  without changing the tests, and added tests for the 429 fallback from query1 to query2 and
  the backoff across calls. Yahoo answered 429 to every capture attempt, so the fixtures are
  still hand-written.
- **Human review:** pending MR review.

## 2026-10-12 — Relay oracle program (`feat/oracle`)

- **Tool:** Claude Code (Claude Opus 5.5): one test worker and one implementation worker.
- **What the AI did:** the test worker wrote 41 LiteSVM tests for the signer registry,
  `publish_price`, `publish_close` and `publish_latest`, plus the interface stubs. The
  implementation worker wrote the `meridian_oracle` handlers and the account constraints (PDA
  seeds, `init` for the write-once records, `init_if_needed` for the latest-price account, the
  upgrade-authority check, the registry checks) without changing the tests.
- **Human review:** pending MR review.

- **Human review:** pending MR review.

- **Human review:** pending MR review.

## 2026-10-13 — Architecture update (`docs/architecture-update`)

- **Tool:** Claude Code (Claude Opus 5.5), running as an implementation worker.
- **What the AI did:** rewrote `ARCHITECTURE.md` against the requirements and decisions: why a
  custom relay oracle is used and how to switch a slot to Pyth or Chainlink, the Yahoo chart API
  and `mock` relay sources, the +15 min escalation, designs for each gotcha requirement
  (canonical close record, one price per ticker and day, collateral counter, in-book trader
  seats, merge-up-to, live oracle prices, mainnet guard, rent sizing), a table mapping every
  requirement to its components and a gotchas table. Logged its design calls as decisions
  D15–D21 in the local decisions log.
- **Human review:** pending MR review.

## 2026-10-12 — Repo setup (`feat/repo-setup`)

- **Tool:** Claude Code (Claude Opus 5.5), running as an implementation worker.
- **What the AI did:** installed the Rust, Solana and Anchor toolchain; added the `gitlab` remote;
  scaffolded the npm workspaces (`packages/sdk`, `packages/price-providers`,
  `services/automation`, `app`), the Anchor workspace (`programs/meridian`,
  `programs/meridian_oracle`) with placeholder `ping` instructions, Mocha integration tests,
  smoke tests per workspace, the Makefile, Prettier, ESLint, TypeScript and Rust lint settings,
  the Husky pre-push hook, `.env.example`, `AGENTS.md` and this log. Added `.gitlab-ci.yml`
  running the same gates, registered a project shell runner and turned on "Pipelines must
  succeed".
- **Human review:** pending MR review.

## 2026-10-13 — MVP integration branch (`integration/mvp`)

- **Tool:** Claude Code (Claude Opus 5.5), running as the orchestrator and integration workers.
- **What the AI did:** merged the MVP feature branches (redeem builder, lifecycle, oracle adapters,
  worker wiring, unwind, dev demo, docs measurement, e2e, slot config, real close, time of day)
  into one integration branch, resolved their conflicts, regenerated the shipped IDLs and updated
  the README status before merging it into `main`. Each feature has its own entry.
- **Human review:** pending MR review.

## 2026-10-14 — Mock source covers all 7 tickers (`feat/mock-tickers`)

- **Tool:** Claude Code (Claude Opus 5.5), running as an implementation worker.
- **What the AI did:** generated hand-written 1-minute and daily chart fixtures for GOOGL, AMZN,
  NVDA, META and TSLA, plus MSFT's missing daily file, from the existing hand-written ones rescaled
  to plausible levels, with provenance entries and a README note; added the mock source's
  synthetic intraday series (the same code as `feat/markets-chart`).
- **Human review:** pending MR review.

## 2026-10-14 — Closed tag with reopen time on Markets cards (`feat/closed-tag`)

- **Tool:** Claude Code (Claude Opus 5.5), running as the test and implementation workers.
- **What the AI did:** wrote the R68 tests, then the next-open and reopen-label functions on the
  NYSE calendar (always in ET), exported them to the app as a package subpath, and added the
  Markets cards' Closed tag, which replaces the stale marker while the market is closed.
- **Human review:** pending MR review.

## 2026-10-14 — Markets card closed layout and last close (`feat/card-layout`)

- **Tool:** Claude Code (Claude Opus 5.5), running as the test and implementation workers.
- **What the AI did:** wrote the R69 layout (Playwright) and last-close tests, then cut the Closed
  pill down to the word "Closed", moved the reopen time to the status line under the chart, and
  showed the last close (the on-chain price, else the worker's session close) labelled "Last
  close" while the market is closed.
- **Human review:** pending MR review.

## 2026-10-15 — ARCHITECTURE refresh for current main (`docs/architecture-refresh`)

- **Tool:** Claude Code (Claude Opus 5.5), running as a documentation worker.
- **What the AI did:** read the code on `main` and updated `ARCHITECTURE.md` to match it: the
  Alpaca source (stream and REST, SIP and IEX feeds, config variables, key-based default with
  `mock` as the fallback, Yahoo opt-in), the cached intraday chart route, the Markets card states,
  the calendar shared with the app, the private-port test tooling, the admin-only finalize and
  Admin page decision (marked in progress where `main` doesn't have it yet), the requirement table
  for R66-R70 and the risks.
- **Human review:** pending MR review.

## 2026-10-15 — Test results (`docs/test-results`)

- **Tool:** Claude Code (Claude Opus 5.5), running as a docs worker.
- **What the AI did:** ran every suite (the workspace unit tests, `cargo test`, the Anchor
  integration and lifecycle tests and `make e2e`) and the quality gates on `main`, and wrote
  `TEST_RESULTS.md` with the counts, durations, requirement coverage, property tests and known
  limits, linked from the README.
- **Human review:** pending MR review.
