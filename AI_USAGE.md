# AI usage log

One entry per merged change: what AI tools did and what a human reviewed or changed. Newest first.

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
