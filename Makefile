SHELL := /bin/bash
TSX := npx tsx

.PHONY: install build test check-sizes gates dev deploy-devnet demo ship-idls e2e

# npm test checks the shipped IDLs against the build under test (R65), whose program addresses
# follow this checkout's keypairs (`anchor keys sync`). So the copies are regenerated from that
# build first, and the committed devnet copies are written back afterwards, pass or fail.
NPM_TEST := $(TSX) scripts/ship-idls.ts && { npm test; status=$$?; $(TSX) scripts/ship-idls.ts --devnet; exit $$status; }

install:
	npm install

build:
	anchor build

# Runs every suite: workspace unit tests, Rust unit tests and Anchor integration tests. Outside CI
# the Anchor validator runs on a free private port block (scripts/anchor-test.sh).
test: build
	$(NPM_TEST)
	cargo test --workspace
	./scripts/anchor-test.sh

check-sizes:
	./scripts/check-file-sizes.sh

# Every local quality gate. The pre-push hook and the MR pipeline run this.
gates: check-sizes build
	npm run format:check
	npm run lint
	npm run typecheck
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets -- -D warnings
	$(NPM_TEST)
	cargo test --workspace
	./scripts/anchor-test.sh

# Local validator (LOCAL_VALIDATOR_RPC_PORT), deploy, bootstrap with a mock USDC mint, sample
# markets, then the worker and the web app. Pass ARGS=--dry-run to print the plan.
dev:
	@$(TSX) scripts/dev.ts $(ARGS)

# Builds and deploys both programs to devnet, records their IDs and bootstraps config.
deploy-devnet:
	@$(TSX) scripts/deploy-devnet.ts $(ARGS)

# Full lifecycle in demo mode: create, mint, the four trade paths, settle via the relay, redeem.
demo:
	@$(TSX) scripts/demo.ts $(ARGS)

# Writes the IDLs the automation service ships for deploys (no target/), with the devnet program
# IDs throughout, so the committed copies are the same on every machine. Commit the result.
ship-idls: build
	@$(TSX) scripts/ship-idls.ts --devnet

# Playwright specs (R22, R56) on a private stack: validator on E2E_RPC_PORT (default 8975),
# programs at genesis, bootstrap with a mock USDC mint and demo mode, one demo market, then
# `next dev` on E2E_WEB_PORT (default 3105) with the test wallet. Local only, not in the MR pipeline.
e2e:
	@$(TSX) scripts/e2e.ts $(ARGS)
