#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"$ROOT/runtime/node/bin/node" "$ROOT/scripts/verify.mjs" "$ROOT"
