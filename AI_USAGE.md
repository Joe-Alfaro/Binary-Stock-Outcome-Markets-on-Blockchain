# AI usage log

One entry per merged change: what AI tools did and what a human reviewed or changed. Newest first.

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
