#!/usr/bin/env bash
# Codex SessionStart hook: verify the TdaiGateway is reachable.
# Fails silently (no output, exit 0) so session start is never blocked.
set -uo pipefail

GATEWAY="${TDAI_GATEWAY_URL:-http://127.0.0.1:8420}"

curl -s --max-time 5 -o /dev/null "$GATEWAY/health" || true
exit 0
