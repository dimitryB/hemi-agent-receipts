#!/usr/bin/env bash
# Serializes npm installs when several agents share this checkout:
#   scripts/with-npm-lock.sh npm install <pkg>@<exact-version> -w <workspace> --no-audit --no-fund
set -euo pipefail
cd "$(dirname "$0")/.."
LOCK=.npm-install.lock
for _ in $(seq 1 600); do
  if mkdir "$LOCK" 2>/dev/null; then
    trap 'rmdir "$LOCK"' EXIT
    "$@"
    exit $?
  fi
  sleep 1
done
echo "timed out waiting for $LOCK" >&2
exit 1
