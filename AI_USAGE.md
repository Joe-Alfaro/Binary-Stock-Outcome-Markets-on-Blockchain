# AI usage log

One entry per merged change: what AI tools did and what a human reviewed or changed. Newest first.

## 2026-10-13 — Settlement math (`feat/math`)

- **Tool:** Claude Code (Claude Opus 5.5), as a TDD pair: one session wrote the red tests and
  shared fixtures, a second implemented them.
- **What the AI did:** implemented the closing-price rule (validation, official close, exact
  timestamp and exact-rational interpolation), the payout rule and the strike ladder in the
  `no_std` crate `crates/meridian-math`, and the bigint TypeScript twin in
  `packages/sdk/src/math`. Both pass the shared fixtures and the property tests (10,000 proptest
  cases in Rust, 2,000 seeded cases in TS). Tests were not changed by the implementation.
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
