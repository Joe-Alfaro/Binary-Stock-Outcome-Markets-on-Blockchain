# Agent instructions

Read this before changing anything in the repo. `ARCHITECTURE.md` describes how the system is
built.

## Git workflow

- Branch off `main` for every change: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`.
- Merge through GitLab merge requests on the `gitlab` remote. `origin` (GitHub) is kept as a
  mirror; don't open pull requests there.
- Open MRs with `glab`, setting `GITLAB_HOST` to the host of the `gitlab` remote:

  ```sh
  git push gitlab <branch>
  GITLAB_HOST=<gitlab host> glab mr create --source-branch <branch> --target-branch main \
    --title "<title>" --description "<summary, tests, risks>"
  ```

  Without `glab`, push options also work:

  ```sh
  git push gitlab <branch> \
    -o merge_request.create \
    -o merge_request.target=main \
    -o merge_request.title="<title>"
  ```

- Use conventional commit messages (`feat:`, `fix:`, `chore:`, `test:`, `docs:`).
- Never force-push `main` or shared branches. Never push straight to `main`.

## Merge policy

1. Work on a feature branch off `main`.
2. Open an MR to `main` on the `gitlab` remote.
3. The MR pipeline (`.gitlab-ci.yml`) must pass. The project enforces "Pipelines must succeed".
4. The worker that owns the MR merges it and deletes the source branch:

   ```sh
   GITLAB_HOST=<gitlab host> glab mr merge <mr> --remove-source-branch --yes
   ```

Pipelines run only for merge requests, on a project runner with the shell executor on the
maintainer's Mac, using the toolchain installed there.

## GitLab server safety

The GitLab server is self-hosted and has been taken down before by runaway loops. These rules
are mandatory for every worker.

Polling and logs:

- Never poll GitLab in a tight loop. Check pipeline or MR status at most once every 2 minutes.
- Never stream job logs (`glab ci view --live`, `glab ci trace` in a loop). Fetch at most the
  last 200 lines of a failed job's log, once.

Pushes and API calls:

- One push per real fix. Never push in a loop.
- If a pipeline fails twice for the same reason, stop and report instead of retrying.
- Never retry pipelines automatically. Never script loops of API calls, pushes or MR creation.

CI config (`.gitlab-ci.yml`) must keep:

- `workflow: rules` that run pipelines only on `merge_request_event`: no branch or `main`
  pipelines, schedules, triggers or child pipelines.
- `interruptible: true` on every job. The project setting "Auto-cancel redundant pipelines" is
  on, so a new push cancels the old pipeline.
- No `artifacts:` and no remote or distributed cache. Caching stays local to the runner host.
- `retry: 0`, `timeout: 30m` and as few jobs as possible (currently one).
- Small logs: quiet flags (`npm ci --no-audit --no-fund --loglevel=error`, quiet cargo), no
  verbose test reporters, never print files or environment variables.

Runner (`~/.gitlab-runner/config.toml` on the maintainer's Mac):

- Global `concurrent = 1` and `check_interval = 30`.
- The project runner `local-mac-shell` has `limit = 1` and `output_limit = 4096`.
- Leave every other `[[runners]]` block alone. They belong to the maintainer.

## Quality gates

All local gates must pass before pushing. The Husky pre-push hook runs `make gates`:

- no tracked file over 1 MB (`scripts/check-file-sizes.sh`)
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
- Keys or keypair files, `.env` or any secret. `.env.example` lists every variable and holds no
  secrets.
- Build output or large files: `target/`, `node_modules/`, `test-ledger/`, `.anchor/`, `.next/`,
  ledger snapshots, or recorded fixtures over 200 KB. `make gates` (and so the pre-push hook)
  rejects any tracked file over 1 MB.

## AI usage log

Every merged change appends an entry to `AI_USAGE.md`: date, branch or MR, tool and model, what
the AI did and what a human reviewed or changed.
