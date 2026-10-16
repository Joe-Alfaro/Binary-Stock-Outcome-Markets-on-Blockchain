# Test results

One full local run of every suite and quality gate. Test names carry the requirement IDs (R1, R2,
...) they cover, so a failing test points at the rule it checks.

- **Date:** 2026-10-16
- **Commit:** `56f5149` (`feat/v5-polish`, on top of `main` at `22ceaf6`)
- **Machine:** macOS 26.6 on Apple silicon (arm64)
- **Toolchain:** Node 23.7.0, npm 10.9.2, TypeScript 5.9.3, Rust 1.89.0, Solana/Agave CLI 4.3.0,
  Anchor CLI 1.2.1, Mocha 11.8.0, Playwright 1.64.0 (Chromium)

## Summary

1,430 tests, 1,430 passed, 0 failed. One suite of 4 checks was skipped (the R64 names scan, see
below). Every quality gate passed (`make gates`, exit 0).

| Suite                            | Command                                | Pass  | Fail | Skip | Time     |
| -------------------------------- | -------------------------------------- | ----- | ---- | ---- | -------- |
| SDK                              | `npm test -w packages/sdk`             | 181   | 0    | 0    | 1 s      |
| Price providers                  | `npm test -w packages/price-providers` | 268   | 0    | 0    | 2 s      |
| Automation worker                | `npm test -w services/automation`      | 269   | 0    | 0    | 9 s      |
| Web app (unit, jsdom)            | `npm test -w app`                      | 167   | 0    | 0    | 15 s     |
| Ops scripts                      | `npm run test:scripts`                 | 173   | 0    | 0    | 19 s     |
| Docs checks                      | `npm run test:docs`                    | 30    | 0    | 4    | 1 s      |
| Rust (programs, math crate)      | `cargo test --workspace`               | 265   | 0    | 0    | 7 s      |
| Anchor integration and lifecycle | `./scripts/anchor-test.sh`             | 61    | 0    | 0    | 12 m     |
| Browser end to end               | `make e2e`                             | 16    | 0    | 0    | 4 m 46 s |
| **Total**                        |                                        | 1,430 | 0    | 4    |          |

Times are wall clock as the runners report them. The Rust time excludes compiling the test
binaries, and the end-to-end time includes starting the validator, deploying, bootstrapping and
starting the web app (the Playwright specs themselves took 2.7 m; `E2E_SKIP_BUILD=true` reused the
`anchor build` from `make gates`).

| Quality gate                             | Result |
| ---------------------------------------- | ------ |
| No tracked file over 1 MB                | Pass   |
| `prettier --check`                       | Pass   |
| `eslint .`                               | Pass   |
| `tsc --noEmit` (root and workspaces)     | Pass   |
| `cargo fmt --check`                      | Pass   |
| `cargo clippy --all-targets -D warnings` | Pass   |

## What each suite covers

| Suite                            | Covers                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK                              | Payout and closing-price math twin (R1, R2, R31, R33, R34), strike ladder (R11), the four trade-path builders and transaction size (R23-R27), position constraint and unwind (R28), No view of the book (R29), redeem, cancel and close-out builders (R5, R18, R52)                                                                                               |
| Price providers                  | Alpaca, Yahoo, mock and demo-replay sources (R39, R67, R44), Pyth and Chainlink normalizers (R32, R33), morning closes (R15), latest prices and chart data (R47, R50, R66)                                                                                                                                                                                        |
| Automation worker                | Morning job (R12, R15), settlement escalation and latency (R37, R38), admin fallback (R36), relay publisher (R40), alert sinks and the invariant audit (R46), latest prices (R47), chart and closed-state routes (R66-R68), Railway config (R65)                                                                                                                  |
| Web app                          | Wallet (R48), Landing, Markets, Trade, Portfolio and History pages (R49-R53), signing and errors (R54), finality (R55), live book and prices (R22, R47), both book views (R29), position constraint (R28), demo mode (R44), axe checks (R56), Markets cards (R66, R68, R69), the Admin link and page with button timing and close label (R70)                     |
| Ops scripts                      | `make dev`, `make deploy-devnet`, `make demo` and bootstrap (R59-R61), mainnet guard (R45), key separation (R43), `.env.example` including test-only variables (R62), the `make dev` worker port (R60), Railway config (R65), e2e harness (R22, R56)                                                                                                              |
| Docs checks                      | README claims that tests can check: no regulatory claims (R63), no company or program names in files, commits or branches (R64), rent and compute figures (R19), vault donations (R6), adding strikes (R13), demo mode (R44)                                                                                                                                      |
| Rust                             | Every instruction of both programs on an in-process SVM: config (R10, R41, R42), markets and strikes (R11-R13), trading calendar (R14), mint, merge and redeem (R3-R5), order book, matching, cancel and limits (R16-R21), the four trade paths (R23-R27), relay oracle (R30), settlement and price adapters (R31-R36), demo mode (R44), and the invariants below |
| Anchor integration and lifecycle | On a local validator: the full lifecycle create → mint → trade (all four paths) → settle → redeem with a multi-user scenario (R57), `make demo` on localnet (R61), vault donation (R6), compute and rent (R19), unwind and close-out through the SDK (R28, R52), the worker end to end with Pyth and the relay (R32, R40, R46, R47)                               |
| Browser end to end               | Markets card layout at 1280, 1024, 768 and 390 px (R69), axe checks on Trade and Portfolio with a wallet connected (R56), a new order shows in the book within 2 s (R22), Buy Yes in one signature (R23), close out and redeem in one signature (R52), the header at 320-768 px for a trader and the admin (R69, R70)                                             |

## Invariant and property tests

- **Yes + No = $1 (R2, INV-3):** a `proptest` in `crates/meridian-math/tests/properties.rs` checks,
  for 10,000 random valid closing-price inputs and strikes per run, that the Yes payout plus the No
  payout is exactly 1,000,000 base units. The same file runs 10,000 cases each for: the
  interpolated comparison matching an exact rational reference (R33), and Yes winning for every
  strike at or below the close and losing above it (R31, two shapes). 40,000 cases in total, all
  passed. The SDK's TypeScript twin runs the same three properties at 2,000 cases each.
- **Collateral (R6, INV-1, INV-2):** `mint_merge.rs` and `settlement_redeem.rs` check that the vault
  always covers the collateral counter and the counter covers every winning token. The Anchor
  vault-donation scenario checks that a direct USDC donation can't change any payout.
- **Supply control (R7, INV-4), no fees (R8, INV-6), immutable outcome (R9, INV-5):** covered in
  `markets.rs`, `mint_merge.rs`, `orderbook.rs`, `settlement_settle.rs` and `settlement_admin.rs`.
- **Live audit (R46):** the worker's per-minute collateral and supply audit runs against the local
  validator and raises no `invariant_failure` on a healthy chain.

## End-to-end and accessibility

`make e2e` ran all 16 Playwright specs in Chromium against a private stack (local validator, both
programs, a mock USDC mint, demo mode and `next dev`). All passed. The axe checks found no
violations on the Trade and Portfolio pages with a wallet connected, and the web app's unit suite
runs axe on the wallet picker and the other pages.

## Known skips and limits

- **R64 names scan skipped in the full run.** It reads the names from a file outside the repo named
  by `MERIDIAN_FORBIDDEN_NAMES_FILE` and skips its 4 checks when that's unset, as it is in CI.
  node:test counts a skipped suite as 0 skipped tests, so the summary line hides it. No names file
  was available for this run; the 4 checks last passed with one on `main` at `22ceaf6`.
- **Devnet not yet run.** Everything above ran locally. `make demo` on devnet and a devnet run of
  the lifecycle are still to do, as is the first Railway deploy.
- The Markets layout spec fakes the browser clock, so Next.js logs a hydration-mismatch warning for
  the Closed pill's reopen label. The spec still passes; it's a test artifact, not a failure.
- The validator suites ran on private port blocks (`anchor-test.sh` and the Pyth slot test were pinned
  with `VALIDATOR_*` and `PYTH_SLOT_TEST_*`, and `make e2e` with `E2E_GOSSIP_PORT` and
  `E2E_DYNAMIC_PORT_RANGE`, to stay clear of other local validators).
- Timings come from one run on a shared machine and vary between runs.
