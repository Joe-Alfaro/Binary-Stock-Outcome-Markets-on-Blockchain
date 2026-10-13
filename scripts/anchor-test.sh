#!/usr/bin/env bash
# Runs the Anchor integration tests (`make gates`, `make test`, the pre-push hook).
#
# In CI the validator keeps the reserved block pinned in Anchor.toml [test.validator] (8899-8900,
# faucet 9900, gossip 9600, dynamic 9601-9650), after waiting for any other holder to let go.
#
# Anywhere else it runs on a private block, so a local push never holds CI's ports: the
# VALIDATOR_RPC_PORT, VALIDATOR_FAUCET_PORT, VALIDATOR_GOSSIP_PORT and VALIDATOR_DYNAMIC_PORT_RANGE
# ones when set, otherwise the first free blocks in RPC 8920-8961 and gossip 9010-9254. Those clear
# CI's block, Agave's default gossip 8000, `make dev` (8913), `make e2e` (8975, 9350-9390) and the
# Pyth slot test's own validator (8965-8998, 9255-9590). Anchor.toml has no env substitution, so the
# [test.validator] ports are swapped in for the run and the file is restored on exit.
set -euo pipefail

cd "$(dirname "$0")/.."
anchor_test=(anchor test --skip-build --validator legacy)

if [ -n "${CI:-}" ]; then
  ./scripts/check-validator-ports.sh
  exec "${anchor_test[@]}"
fi

DYNAMIC_PORT_COUNT=40

# True when any process holds a TCP or UDP port in low-high.
ports_busy() {
  [ -n "$(lsof -nP -iTCP:"$1-$2" -iUDP:"$1-$2" 2>/dev/null || true)" ]
}

# The first start of `size` free ports from low, stepping by size, ending at or below high.
free_block() {
  local what=$1 low=$2 high=$3 size=$4 start
  for ((start = low; start + size - 1 <= high; start += size)); do
    if ! ports_busy "$start" $((start + size - 1)); then
      echo "$start"
      return
    fi
  done
  echo "No free $what ports in $low-$high; set the VALIDATOR_* ports." >&2
  return 1
}

# True when low-high overlaps CI's reserved ports.
reserved() {
  local low=$1 high=$2
  { [ "$low" -le 8900 ] && [ "$high" -ge 8899 ]; } ||
    { [ "$low" -le 9900 ] && [ "$high" -ge 9900 ]; } ||
    { [ "$low" -le 9650 ] && [ "$high" -ge 9600 ]; }
}

# The RPC WebSocket takes the RPC port + 1, so the faucet sits one further on.
rpc=${VALIDATOR_RPC_PORT:-$(free_block RPC 8920 8961 3)}
faucet=${VALIDATOR_FAUCET_PORT:-$((rpc + 2))}
gossip=${VALIDATOR_GOSSIP_PORT:-$(free_block gossip 9010 9254 $((DYNAMIC_PORT_COUNT + 1)))}
range=${VALIDATOR_DYNAMIC_PORT_RANGE:-$((gossip + 1))-$((gossip + DYNAMIC_PORT_COUNT))}

if reserved "$rpc" $((rpc + 1)) || reserved "$faucet" "$faucet" || reserved "$gossip" "$gossip" ||
  reserved "${range%-*}" "${range#*-}"; then
  echo "Local validator ports overlap CI's (8899-8900, 9900, 9600-9650); pick others." >&2
  exit 1
fi

original=$(mktemp)
cp Anchor.toml "$original"
trap 'cp "$original" Anchor.toml; rm -f "$original"' EXIT
sed -E \
  -e "s/^rpc_port = .*/rpc_port = $rpc/" \
  -e "s/^faucet_port = .*/faucet_port = $faucet/" \
  -e "s/^gossip_port = .*/gossip_port = $gossip/" \
  -e "s/^dynamic_port_range = .*/dynamic_port_range = \"$range\"/" \
  "$original" >Anchor.toml

echo "Local test validator: RPC $rpc, faucet $faucet, gossip $gossip, dynamic $range."
"${anchor_test[@]}"
