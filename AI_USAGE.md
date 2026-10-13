# AI usage log

One entry per merged change: what AI tools did and what a human reviewed or changed. Newest first.

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
