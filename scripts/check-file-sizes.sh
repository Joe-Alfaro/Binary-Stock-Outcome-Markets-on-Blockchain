#!/usr/bin/env bash
# Rejects any tracked file over 1 MB so build output, ledgers and large fixtures never reach
# the GitLab server.
set -euo pipefail

LIMIT_BYTES=$((1024 * 1024))
# BSD stat (macOS) first, GNU stat as the fallback.
sizes=$(git ls-files -z | xargs -0 stat -f '%z %N' 2>/dev/null || git ls-files -z | xargs -0 stat -c '%s %n')
oversized=$(echo "$sizes" | awk -v limit="$LIMIT_BYTES" '$1 > limit')

if [ -n "$oversized" ]; then
  echo 'Files over 1 MB are not allowed:' >&2
  echo "$oversized" >&2
  exit 1
fi
