SHELL := /bin/bash
TSX := npx tsx

.PHONY: install build test check-sizes gates dev deploy-devnet demo ship-idls

install:
	npm install

build:
	anchor build

# Runs every suite: workspace unit tests, Rust unit tests and Anchor integration tests.
test: build
	npm test
	cargo test --workspace
	./scripts/check-validator-ports.sh
	anchor test --skip-build --validator legacy

check-sizes:
	./scripts/check-file-sizes.sh

# Every local quality gate. The pre-push hook and the MR pipeline run this.
gates: check-sizes build
	npm run format:check
	npm run lint
	npm run typecheck
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets -- -D warnings
	npm test
	cargo test --workspace
	./scripts/check-validator-ports.sh
	anchor test --skip-build --validator legacy

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

# Copies the built IDLs into the automation service, which ships them for deploys (no target/).
ship-idls: build
	@$(TSX) scripts/ship-idls.ts
