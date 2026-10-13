#!/usr/bin/env bash
# A production build must never ship the "E2E test wallet", even with its flag set (make e2e runs
# this before it starts the stack). Solflare is the control: the bundle does contain the wallets.
set -euo pipefail
cd "$(dirname "$0")/../app"

NEXT_PUBLIC_E2E_TEST_WALLET=true npx next build --webpack

if grep -rlE 'E2E test wallet|meridianE2eWallet' .next/static .next/server; then
  echo 'The production build includes the E2E test wallet (files above).' >&2
  exit 1
fi
if ! grep -rlq 'Solflare' .next/static; then
  echo 'No wallet adapters found in the production bundle; this check is looking in the wrong place.' >&2
  exit 1
fi
echo 'The production build has no E2E test wallet.'
