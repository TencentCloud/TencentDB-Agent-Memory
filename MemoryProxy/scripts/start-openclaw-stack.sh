#!/usr/bin/env bash
set -euo pipefail

: "${MEMORY_PROXY_API_KEY:?Set MEMORY_PROXY_API_KEY to the Memory Proxy user key}"
command -v openclaw >/dev/null || { echo "openclaw CLI is required" >&2; exit 1; }

# Memory Proxy is managed independently. This helper only starts OpenClaw and
# keeps the API key in the current process environment for provider auth.
# Preserve an existing gateway mode. OpenClaw blocks an existing config that
# omits this field, so initialize only the missing value before startup.
if ! openclaw config get gateway.mode >/dev/null 2>&1; then
  openclaw config set gateway.mode "${OPENCLAW_GATEWAY_MODE:-local}"
fi
exec openclaw gateway
