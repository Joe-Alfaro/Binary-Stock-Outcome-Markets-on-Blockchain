# Test results

One full local run of every suite and quality gate. Test names carry the requirement IDs (R1, R2,
...) they cover, so a failing test points at the rule it checks.

- **Date:** 2026-10-15
- **Commit:** `33839a4932842f7d3e4837688766d61c42643eab` (`main`)
- **Machine:** macOS 26.6 on Apple silicon (arm64)
- **Toolchain:** Node 23.7.0, npm 10.9.2, TypeScript 5.9.3, Rust 1.89.0, Solana/Agave CLI 4.3.0,
  Anchor CLI 1.2.1, Mocha 11.8.0, Playwright 1.64.0 (Chromium)

## Summary

1,340 tests, 1,340 passed, 0 failed, 0 skipped. Every quality gate passed.

| Suite                            | Command                                | Pass  | Fail | Skip | Time    |
| -------------------------------- | -------------------------------------- | ----- | ---- | ---- | ------- |
| SDK                              | `npm test -w packages/sdk`             | 176   | 0    | 0    | 6 s     |
| Price providers                  | `npm test -w packages/price-providers` | 268   | 0    | 0    | 5 s     |
| Automation worker                | `npm test -w services/automation`      | 261   | 0    | 0    | 10 s    |
| Web app (unit, jsdom)            | `npm test -w app`                      | 132   | 0    | 0    | 39 s    |
| Ops scripts                      | `npm run test:scripts`                 | 141   | 0    | 0    | 49 s    |
| Docs checks                      | `npm run test:docs`                    | 30    | 0    | 0    | 1 s     |
| Rust (programs, math crate)      | `cargo test --workspace`               | 263   | 0    | 0    | 3 m 9 s |
| Anchor integration and lifecycle | `./scripts/anchor-test.sh`             | 60    | 0    | 0    | 12 m 7s |
| Browser end to end               | `make e2e`                             | 9     | 0    | 0    | 2 m 33s |
| **Total**                        |                                        | 1,340 | 0    | 0    |         |

Times are wall clock. The Rust time includes compiling the test binaries, and the end-to-end time
includes starting the validator, deploying, bootstrapping and starting the web app (the Playwright
specs themselves took 41 s).

| Quality gate                             | Result | Time |
| ---------------------------------------- | ------ | ---- |
| No tracked file over 1 MB                | Pass   | 0 s  |
| `prettier --check`                       | Pass   | 21 s |
| `eslint .`                               | Pass   | 17 s |
| `tsc --noEmit` (root and workspaces)     | Pass   | 38 s |
| `cargo fmt --check`                      | Pass   | 1 s  |
| `cargo clippy --all-targets -D warnings` | Pass   | 45 s |

## What each suite covers

| Suite                            | Covers                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK                              | Payout and closing-price math twin (R1, R2, R31, R33, R34), strike ladder (R11), the four trade-path builders and transaction size (R23-R27), position constraint and unwind (R28), No view of the book (R29), redeem, cancel and close-out builders (R5, R18, R52)                                                                                               |
| Price providers                  | Alpaca, Yahoo, mock and demo-replay sources (R39, R67, R44), Pyth and Chainlink normalizers (R32, R33), morning closes (R15), latest prices and chart data (R47, R50, R66)                                                                                                                                                                                        |
| Automation worker                | Morning job (R12, R15), settlement escalation and latency (R37, R38), admin fallback (R36), relay publisher (R40), alert sinks and the invariant audit (R46), latest prices (R47), chart and closed-state routes (R66-R68), Railway config (R65)                                                                                                                  |
| Web app                          | Wallet (R48), Landing, Markets, Trade, Portfolio and History pages (R49-R53), signing and errors (R54), finality (R55), live book and prices (R22, R47), both book views (R29), position constraint (R28), demo mode (R44), axe checks (R56), Markets cards (R66, R68, R69)                                                                                       |
| Ops scripts                      | `make dev`, `make deploy-devnet`, `make demo` and bootstrap (R59-R61), mainnet guard (R45), key separation (R43), `.env.example` (R62), Railway config (R65), e2e harness (R22, R56)                                                                                                                                                                              |
| Docs checks                      | README claims that tests can check: no regulatory claims and no company names (R63, R64), rent and compute figures (R19), vault donations (R6), adding strikes (R13), demo mode (R44)                                                                                                                                                                             |
| Rust                             | Every instruction of both programs on an in-process SVM: config (R10, R41, R42), markets and strikes (R11-R13), trading calendar (R14), mint, merge and redeem (R3-R5), order book, matching, cancel and limits (R16-R21), the four trade paths (R23-R27), relay oracle (R30), settlement and price adapters (R31-R36), demo mode (R44), and the invariants below |
| Anchor integration and lifecycle | On a local validator: the full lifecycle create → mint → trade (all four paths) → settle → redeem with a multi-user scenario (R57), `make demo` on localnet (R61), vault donation (R6), compute and rent (R19), unwind and close-out through the SDK (R28, R52), the worker end to end with Pyth and the relay (R32, R40, R46, R47)                               |
| Browser end to end               | Markets card layout at 1280, 1024, 768 and 390 px (R69), axe checks on Trade and Portfolio with a wallet connected (R56), a new order shows in the book within 2 s (R22), Buy Yes in one signature (R23), close out and redeem in one signature (R52)                                                                                                             |

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

`make e2e` ran all 9 Playwright specs in Chromium against a private stack (local validator, both
programs, a mock USDC mint, demo mode and `next dev`). All passed. The axe checks found no
violations on the Trade and Portfolio pages with a wallet connected, and the web app's unit suite
runs axe on the wallet picker and the other pages.

## Known skips and limits

- No test was skipped.
- **Devnet not yet run.** Everything above ran locally. `make demo` on devnet and a devnet run of
  the lifecycle are still to do, as is the first Railway deploy.
- The admin role in the web app (R70, added 2026-10-15) has no tests yet.
- The Markets layout spec fakes the browser clock, so Next.js logs a hydration-mismatch warning for
  the Closed pill's reopen label. The spec still passes; it's a test artifact, not a failure.
- The validator suites ran on private port blocks (`anchor-test.sh` picks one; `make e2e` was pinned
  with the `E2E_*_PORT` variables because another local validator held its default gossip port).
- Timings come from one run on a shared machine and vary between runs.
