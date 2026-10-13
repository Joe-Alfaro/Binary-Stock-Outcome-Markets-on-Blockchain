#!/usr/bin/env bash
# Fails fast when another process holds a port reserved for the Anchor test validator
# (Anchor.toml [test.validator]), instead of letting `anchor test` time out on startup.
set -euo pipefail

busy=$(lsof -nP -iTCP:8899-8900 -iUDP:8899-8900 -iTCP:9900 -iUDP:9900 -iTCP:9600-9650 -iUDP:9600-9650 2>/dev/null || true)

if [ -n "$busy" ]; then
  echo 'The test validator ports (8899-8900, 9900, 9600-9650) are in use. Stop these processes:' >&2
  echo "$busy" | awk 'NR > 1 { print "  " $1 " pid " $2 " " $9 }' | sort -u >&2
  exit 1
fi
