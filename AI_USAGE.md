# AI usage log

One entry per merged change: what AI tools did and what a human reviewed or changed. Newest first.

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
