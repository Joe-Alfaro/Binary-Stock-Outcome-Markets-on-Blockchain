# Agent instructions

Read this before changing anything in the repo. `ARCHITECTURE.md` describes how the system is
built.

## Git workflow

- Branch off `main` for every change: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`.
- Merge through GitLab merge requests on the `gitlab` remote. `origin` (GitHub) is kept as a
  mirror; don't open pull requests there.
- `glab` isn't authenticated for the GitLab host, so open MRs with push options:

  ```sh
  git push gitlab <branch> \
    -o merge_request.create \
    -o merge_request.target=main \
    -o merge_request.title="<title>"
  ```

- Use conventional commit messages (`feat:`, `fix:`, `chore:`, `test:`, `docs:`).
- Don't force-push shared branches.

## Quality gates

All local gates must pass before pushing. The Husky pre-push hook runs `make gates`:

- `prettier --check` (no semicolons, single quotes)
- `eslint .`
- `tsc --noEmit` for the root and every workspace
- `cargo fmt --check`
- `cargo clippy -D warnings`
- every test suite: workspace unit tests (`node:test`), `cargo test` and the Anchor integration
  tests in `tests/` (Mocha on a local `solana-test-validator`)

`make test` runs only the test suites. Add a test with every change; work test-first where
practical.

## Toolchain

- Rust is pinned in `rust-toolchain.toml`; Anchor and the Solana CLI are pinned in `Anchor.toml`.
- Node: `.nvmrc` pins 24; `engines` accepts `>=22.12.0`.
- Program keypairs live in `target/deploy/` and are never committed. On a fresh checkout run
  `anchor keys sync` to generate them and update the program IDs, or copy in the shared devnet
  keypairs out of band.

## Local-only documents

These are never committed. Read them when useful; don't copy them into the repo.

- Project docs (source spec, decisions): `Docs/` in the main checkout at
  `/Users/joealfaro/Documents/Binary Stock Outcome Markets on Blockchain/Docs/`
- Requirements:
  `/Users/joealfaro/.ao/data/artifacts/binary-stock-outcome-markets-on-blockchain-1/requirements.md`

## Never commit

- Company, client or program names, in code, docs, tests, commits, branch names or service names.
- Keys or keypair files, `.env` or any secret. `.env.example` lists every variable and holds no secrets.

## AI usage log

Every merged change appends an entry to `AI_USAGE.md`: date, branch or MR, tool and model, what
the AI did and what a human reviewed or changed.
