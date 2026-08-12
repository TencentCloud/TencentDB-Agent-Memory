#!/usr/bin/env bash
set -euo pipefail

BUNDLE="${EVALUATION_BUNDLE_PATH:-/app/evaluation/bundle/evaluation-view-bundle.json}"
PIN="${EVALUATION_BUNDLE_PIN_PATH:-/app/evaluation/pin/evaluation-view-bundle.sha256}"
EXPECTED_SHA256="${EVALUATION_BUNDLE_EXPECTED_SHA256:-}"
MAX_BYTES="${EVALUATION_BUNDLE_MAX_BYTES:-10485760}"

fail() { echo "[evaluation-assets] $*" >&2; exit 1; }
[[ -f "$BUNDLE" && ! -L "$BUNDLE" ]] || fail "bundle missing or not a regular file"
[[ -f "$PIN" && ! -L "$PIN" ]] || fail "pin missing or not a regular file"
SIZE=$(wc -c < "$BUNDLE" | tr -d ' ')
[[ "$SIZE" =~ ^[0-9]+$ && "$SIZE" -le "$MAX_BYTES" ]] || fail "bundle exceeds size gate"
if [[ -n "$EXPECTED_SHA256" ]]; then
  EXPECTED="$EXPECTED_SHA256"
else
  EXPECTED=$(tr -d '\r\n' < "$PIN")
fi
[[ "$EXPECTED" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "external expected digest format invalid"
if command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$BUNDLE" | awk '{print $1}'); else ACTUAL=$(shasum -a 256 "$BUNDLE" | awk '{print $1}'); fi
[[ "sha256:$ACTUAL" == "$EXPECTED" ]] || fail "digest mismatch"
echo "[evaluation-assets] verified sha256:${ACTUAL:0:12}…"
