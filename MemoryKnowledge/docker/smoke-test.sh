#!/bin/sh
set -e

# Smoke test for the Knowledge Service image: hit the /health endpoint.
# Usage: smoke-test.sh [health-url]
# Default URL matches the container's own health-check target.

url="${1:-http://127.0.0.1:8421/health}"

if curl -fsS "$url" >/dev/null 2>&1; then
  echo "smoke test OK: $url"
  exit 0
fi

echo "smoke test FAILED: $url" >&2
exit 1
