# AI usage log

One entry per merged change: what AI tools did and what a human reviewed or changed. Newest first.

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

## 2026-10-12 — SDK trading logic (`feat/sdk-logic`)

- **Tool:** Claude Code (Claude Opus 5.5), running as the implementation worker of a TDD pair.
- **What the AI did:** implemented `packages/sdk/src/trading` against the test worker's red tests:
  the No view of the Yes book and executable quotes (R29), the Yes/No position constraint with a
  typed error that still allows cancel and close-out (R28), payoff copy and an ET countdown that
  handles early closes (R51), and an integer-cents P&L replay over program events. In that replay a
  No bought through mint-and-sell has its cost net of the mint, maker fills count, and a
  market-maker exposure view is built from the same replay (R52). Removed the stub lint
  suppressions and logged its implementation choices in the local decisions log.

## 2026-10-12 — Price providers (`feat/providers`)

- **Tool:** Claude Code (Claude Opus 5.5): one worker wrote the tests, another wrote the code.
- **What the AI did:** the test worker wrote red tests and hand-written fixtures for the Yahoo
  chart source, the `mock` source, `RELAY_<n>_SOURCE` selection, the relay confidence rule and
  the Pyth and Chainlink v11 normalizers. The implementation worker wrote the code to pass them
  without changing the tests, and added tests for the 429 fallback from query1 to query2 and
  the backoff across calls. Yahoo answered 429 to every capture attempt, so the fixtures are
  still hand-written.
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
