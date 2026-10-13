#!/usr/bin/env bash
# CI's pre-check before `anchor test`: waits for the ports reserved for its test validator
# (Anchor.toml [test.validator]) to be free, naming whoever holds them, instead of letting
# `anchor test` time out on startup. Checks every VALIDATOR_PORT_POLL_SECONDS (30) and gives up
# after VALIDATOR_PORT_WAIT_SECONDS (900).
set -euo pipefail

poll=${VALIDATOR_PORT_POLL_SECONDS:-30}
limit=${VALIDATOR_PORT_WAIT_SECONDS:-900}
waited=0

holders() {
  lsof -nP -iTCP:8899-8900 -iUDP:8899-8900 -iTCP:9900 -iUDP:9900 -iTCP:9600-9650 -iUDP:9600-9650 \
    2>/dev/null | awk 'NR > 1 { print "  " $1 " pid " $2 " " $9 }' | sort -u || true
}

for (( ; ; )); do
  busy=$(holders)
  [ -z "$busy" ] && exit 0
  if [ "$waited" -ge "$limit" ]; then
    echo "The test validator ports (8899-8900, 9900, 9600-9650) are still in use after ${limit} s:" >&2
    echo "$busy" >&2
    exit 1
  fi
  echo "The test validator ports (8899-8900, 9900, 9600-9650) are in use; waiting ${poll} s (${waited}/${limit} s):" >&2
  echo "$busy" | awk '{ print "  " $1 " pid " $3 }' | sort -u >&2
  sleep "$poll"
  waited=$((waited + poll))
done
