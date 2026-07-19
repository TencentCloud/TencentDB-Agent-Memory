#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_DIR/.." && pwd)"

GATEWAY_HOST="${TDAI_GATEWAY_HOST:-127.0.0.1}"
GATEWAY_PORT="${TDAI_GATEWAY_PORT:-8420}"
GATEWAY_URL="${TDAI_DIFY_GATEWAY_URL:-http://${GATEWAY_HOST}:${GATEWAY_PORT}}"
MOCK_HOST="${TDAI_DIFY_MOCK_HOST:-127.0.0.1}"
MOCK_PORT="${TDAI_DIFY_MOCK_PORT:-18420}"
MOCK_URL="http://${MOCK_HOST}:${MOCK_PORT}"
RUN_ID="${TDAI_DIFY_E2E_RUN_ID:-$(date +%Y%m%d%H%M%S)-$$}"
SESSION_KEY="${TDAI_DIFY_E2E_SESSION_KEY:-dify-quickstart-session-${RUN_ID}}"
READ_BACK_TOKEN="${TDAI_DIFY_E2E_TOKEN:-TDAI_DIFY_E2E_TOKEN_${RUN_ID}}"
TMP_DIR=""
GATEWAY_PID=""
MOCK_PID=""

cleanup() {
  if [ -n "$MOCK_PID" ] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill "$MOCK_PID" 2>/dev/null || true
  fi
  if [ -n "$GATEWAY_PID" ] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill "$GATEWAY_PID" 2>/dev/null || true
  fi
  if [ -z "${TMP_DIR:-}" ]; then
    return
  fi
  rm -f "$TMP_DIR/gateway-api-key"
  if [ "${TDAI_E2E_KEEP_LOGS:-0}" != "1" ]; then
    rm -rf "$TMP_DIR"
  else
    echo "Logs kept in $TMP_DIR"
  fi
}
trap cleanup EXIT INT TERM

TMP_DIR="$(mktemp -d)" || {
  echo "Failed to create temp directory" >&2
  exit 1
}

find_python() {
  if command -v python3 >/dev/null 2>&1; then
    command -v python3
    return
  fi
  if command -v python >/dev/null 2>&1; then
    command -v python
    return
  fi
  echo "python3 or python is required" >&2
  exit 1
}

find_curl() {
  if command -v curl >/dev/null 2>&1; then
    return
  fi
  echo "curl is required" >&2
  exit 1
}

PYTHON_BIN="${PYTHON_BIN:-$(find_python)}"
find_curl

wait_for_url() {
  local url="$1"
  local label="$2"
  local attempts="${3:-60}"
  for ((i = 0; i < attempts; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for $label at $url" >&2
  return 1
}

post_json() {
  local url="$1"
  local body="$2"
  curl -fsS -X POST "$url" \
    -H "Content-Type: application/json" \
    --data "$body"
}

assert_ok_json() {
  "$PYTHON_BIN" -c '
import json
import sys

payload = json.load(sys.stdin)
if payload.get("ok") is not True:
    raise SystemExit(f"tool invocation failed: {payload}")
print(json.dumps(payload, ensure_ascii=False, sort_keys=True), file=sys.stderr)
'
}

assert_l0_read_back_json() {
  READ_BACK_TOKEN="$READ_BACK_TOKEN" "$PYTHON_BIN" -c '
import json
import os
import sys

payload = json.load(sys.stdin)
if payload.get("ok") is not True:
    raise SystemExit(f"tool invocation failed: {payload}")
results = str(payload.get("results") or "")
total = int(payload.get("total") or 0)
token = os.environ["READ_BACK_TOKEN"]
if total < 1 or token not in results:
    raise SystemExit(f"L0 read-back missing token {token!r}: {payload}")
print(json.dumps(payload, ensure_ascii=False, sort_keys=True), file=sys.stderr)
'
}

make_capture_body() {
  SESSION_KEY="$SESSION_KEY" READ_BACK_TOKEN="$READ_BACK_TOKEN" "$PYTHON_BIN" <<'PY'
import json
import os

print(json.dumps({
    "user_content": (
        "Please remember that the user prefers Go for backend services and deploys them on Kubernetes. "
        f"Read-back token: {os.environ['READ_BACK_TOKEN']}."
    ),
    "assistant_content": (
        "Stored. Preferred stack: Go with Kubernetes. "
        f"Token confirmed: {os.environ['READ_BACK_TOKEN']}."
    ),
    "session_key": os.environ["SESSION_KEY"],
}))
PY
}

make_conversation_search_body() {
  SESSION_KEY="$SESSION_KEY" READ_BACK_TOKEN="$READ_BACK_TOKEN" "$PYTHON_BIN" <<'PY'
import json
import os

print(json.dumps({
    "query": os.environ["READ_BACK_TOKEN"],
    "session_key": os.environ["SESSION_KEY"],
    "limit": 5,
    "max_chars": 2000,
}))
PY
}

make_recall_body() {
  SESSION_KEY="$SESSION_KEY" "$PYTHON_BIN" <<'PY'
import json
import os

print(json.dumps({
    "query": "The user prefers Go and Kubernetes.",
    "session_key": os.environ["SESSION_KEY"],
    "max_chars": 2000,
}))
PY
}

make_session_end_body() {
  SESSION_KEY="$SESSION_KEY" "$PYTHON_BIN" <<'PY'
import json
import os

print(json.dumps({
    "session_key": os.environ["SESSION_KEY"],
}))
PY
}

echo "[1/6] Starting or reusing TencentDB Agent Memory Gateway at $GATEWAY_URL"
if curl -fsS "$GATEWAY_URL/health" >/dev/null 2>&1; then
  echo "Gateway already healthy"
else
  if ! command -v npx >/dev/null 2>&1; then
    echo "npx is required to start the Gateway. Install Node.js, which includes npx." >&2
    exit 1
  fi
  if [ ! -d "$REPO_ROOT/node_modules" ]; then
    echo "node_modules not found. Run 'npm install' from $REPO_ROOT before starting a new Gateway." >&2
    echo "If a Gateway is already running elsewhere, set TDAI_DIFY_GATEWAY_URL to reuse it." >&2
    exit 1
  fi
  export TDAI_GATEWAY_HOST="$GATEWAY_HOST"
  export TDAI_GATEWAY_PORT="$GATEWAY_PORT"
  export TDAI_DATA_DIR="${TDAI_DATA_DIR:-$TMP_DIR/memory-tdai}"
  (
    cd "$REPO_ROOT"
    exec npx tsx src/gateway/server.ts
  ) >"$TMP_DIR/gateway.log" 2>&1 &
  GATEWAY_PID="$!"
  wait_for_url "$GATEWAY_URL/health" "Gateway" 90 || {
    echo "--- Gateway log ---" >&2
    cat "$TMP_DIR/gateway.log" >&2 || true
    exit 1
  }
fi

echo "[2/6] Starting mock Dify plugin server at $MOCK_URL"
API_KEY="${TDAI_DIFY_GATEWAY_API_KEY:-${TDAI_GATEWAY_API_KEY:-}}"
API_KEY_FILE=""
if [ -n "$API_KEY" ]; then
  API_KEY_FILE="$TMP_DIR/gateway-api-key"
  (umask 077 && printf '%s' "$API_KEY" >"$API_KEY_FILE") || {
    echo "Failed to write API key to $API_KEY_FILE" >&2
    exit 1
  }
fi
unset TDAI_DIFY_GATEWAY_API_KEY TDAI_GATEWAY_API_KEY
TDAI_DIFY_GATEWAY_URL="$GATEWAY_URL" \
TDAI_DIFY_GATEWAY_API_KEY_FILE="$API_KEY_FILE" \
"$PYTHON_BIN" "$PLUGIN_DIR/scripts/mock_dify_plugin_server.py" \
  --host "$MOCK_HOST" \
  --port "$MOCK_PORT" >"$TMP_DIR/mock-dify.log" 2>&1 &
MOCK_PID="$!"
wait_for_url "$MOCK_URL/health" "mock Dify server" 30 || {
  echo "--- Mock Dify server log ---" >&2
  cat "$TMP_DIR/mock-dify.log" >&2 || true
  exit 1
}

echo "[3/6] Capturing a completed Dify turn through tdai_capture"
CAPTURE_BODY="$(make_capture_body)"
CAPTURE_RESPONSE="$(post_json "$MOCK_URL/invoke/tdai_capture" "$CAPTURE_BODY")" || {
  echo "Failed to invoke tdai_capture" >&2
  exit 1
}
printf '%s' "$CAPTURE_RESPONSE" | assert_ok_json

echo "[4/6] Validating immediate L0 read-back through tdai_conversation_search"
SEARCH_BODY="$(make_conversation_search_body)"
SEARCH_RESPONSE="$(post_json "$MOCK_URL/invoke/tdai_conversation_search" "$SEARCH_BODY")" || {
  echo "Failed to invoke tdai_conversation_search" >&2
  exit 1
}
printf '%s' "$SEARCH_RESPONSE" | assert_l0_read_back_json

echo "[5/6] Flushing the session through tdai_session_end"
SESSION_END_BODY="$(make_session_end_body)"
SESSION_END_RESPONSE="$(post_json "$MOCK_URL/invoke/tdai_session_end" "$SESSION_END_BODY")" || {
  echo "Failed to invoke tdai_session_end" >&2
  exit 1
}
printf '%s' "$SESSION_END_RESPONSE" | assert_ok_json

echo "[6/6] Validating the Gateway recall path through tdai_recall"
RECALL_BODY="$(make_recall_body)"
RECALL_RESPONSE="$(post_json "$MOCK_URL/invoke/tdai_recall" "$RECALL_BODY")" || {
  echo "Failed to invoke tdai_recall" >&2
  exit 1
}
printf '%s' "$RECALL_RESPONSE" | assert_ok_json

echo "Quickstart e2e succeeded: Gateway -> mock Dify server -> capture -> conversation_search (L0 read-back) -> session_end flush -> recall call"
