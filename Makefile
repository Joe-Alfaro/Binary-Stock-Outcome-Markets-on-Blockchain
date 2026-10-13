SHELL := /bin/bash
TSX := npx tsx

.PHONY: install build test gates dev deploy-devnet demo

install:
	npm install

build:
	anchor build

# Runs every suite: workspace unit tests, Rust unit tests and Anchor integration tests.
test: build
	npm test
	cargo test --workspace
	anchor test --skip-build --validator legacy

# Every local quality gate. The pre-push hook runs this.
gates: build
	npm run format:check
	npm run lint
	npm run typecheck
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets -- -D warnings
	npm test
	cargo test --workspace
	anchor test --skip-build --validator legacy

dev:
	@$(TSX) scripts/todo.ts 'make dev (local validator, deploy, bootstrap, sample markets, worker, web)'

deploy-devnet:
	@$(TSX) scripts/todo.ts 'make deploy-devnet'

demo:
	@$(TSX) scripts/todo.ts 'make demo (full lifecycle on devnet)'
