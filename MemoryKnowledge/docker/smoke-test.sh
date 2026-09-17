#!/usr/bin/env bash
# team-knowledge container smoke test — verify a running instance is healthy.
#
# From host (container already up):
#   ./docker/smoke-test.sh
#   ./docker/smoke-test.sh --base-url http://127.0.0.1:8421
#
# Inside container:
#   smoke-test.sh
#   smoke-test.sh --base-url http://127.0.0.1:8421
#
# Env: BASE_URL, SERVICE_ID, TEAM_ID, EXPECT_PUBLIC_URL, SMOKE_TIMEOUT

set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8421}"
SERVICE_ID="${SERVICE_ID:-smoke-test}"
TEAM_ID="${TEAM_ID:-team-smoke}"
API_PREFIX="${API_PREFIX:-/v3}"
TIMEOUT="${SMOKE_TIMEOUT:-15}"
EXPECT_PUBLIC_URL="${EXPECT_PUBLIC_URL:-}"

PASS=0
FAIL=0
WIKI_ID=""

usage() {
  cat <<EOF
Usage: smoke-test.sh [OPTIONS]

Options:
  --base-url URL           Default: http://127.0.0.1:8421
  --service-id ID          x-tdai-service-id header (default: smoke-test)
  --team-id ID             team_id in body (default: team-smoke)
  --expect-public-url URL  Assert wiki create returns this service_url
  --timeout SEC            curl timeout (default: 15)
  -h, --help

Exit code: 0 if all checks pass, 1 otherwise.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url) BASE_URL="${2%/}"; shift 2 ;;
    --base-url=*) BASE_URL="${1#*=}"; BASE_URL="${BASE_URL%/}"; shift ;;
    --service-id) SERVICE_ID="$2"; shift 2 ;;
    --service-id=*) SERVICE_ID="${1#*=}"; shift ;;
    --team-id) TEAM_ID="$2"; shift 2 ;;
    --team-id=*) TEAM_ID="${1#*=}"; shift ;;
    --expect-public-url) EXPECT_PUBLIC_URL="$2"; shift 2 ;;
    --expect-public-url=*) EXPECT_PUBLIC_URL="${1#*=}"; shift ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --timeout=*) TIMEOUT="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

BASE_URL="${BASE_URL%/}"
API_PREFIX="/${API_PREFIX#/}"
API_PREFIX="${API_PREFIX%/}"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

json_code() {
  local body="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -r '.code // empty' <<<"$body" 2>/dev/null || echo ""
  else
    grep -oE '"code"[[:space:]]*:[[:space:]]*[0-9]+' <<<"$body" | head -1 | grep -oE '[0-9]+$' || echo ""
  fi
}

json_field() {
  local body="$1" field="$2"
  if command -v jq >/dev/null 2>&1; then
    jq -r ".${field} // empty" <<<"$body" 2>/dev/null || echo ""
  elif [[ "$field" == *.* ]]; then
    local leaf="${field##*.}"
    grep -oE "\"${leaf}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" <<<"$body" | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/' || echo ""
  else
    grep -oE "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" <<<"$body" | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/' || echo ""
  fi
}

pass() {
  PASS=$((PASS + 1))
  green "  PASS: $*"
}

fail() {
  FAIL=$((FAIL + 1))
  red "  FAIL: $*"
}

check_http() {
  local name="$1" method="$2" url="$3" expected="${4:-200}" extra_args=("${@:5}")
  local code body
  if ! body=$(curl -sfS --max-time "$TIMEOUT" -X "$method" -w '\n%{http_code}' "${extra_args[@]}" "$url" 2>&1); then
    fail "$name — request failed: $body"
    return 1
  fi
  code=$(tail -n1 <<<"$body")
  body=$(sed '$d' <<<"$body")
  if [[ "$code" != "$expected" ]]; then
    fail "$name — HTTP $code (expected $expected) body=${body:0:200}"
    return 1
  fi
  pass "$name — HTTP $code"
  printf '%s' "$body"
}

check_api_envelope() {
  local name="$1" method="$2" path="$3" body_json="$4" expected_http="${5:-200}"
  local resp code
  resp=$(curl -sfS --max-time "$TIMEOUT" -X "$method" \
    -H "Content-Type: application/json" \
    -H "x-tdai-service-id: $SERVICE_ID" \
    -d "$body_json" \
    -w '\n%{http_code}' \
    "$BASE_URL$API_PREFIX$path" 2>&1) || {
    fail "$name — request failed: $resp"
    return 1
  }
  code=$(tail -n1 <<<"$resp")
  resp=$(sed '$d' <<<"$resp")
  if [[ "$code" != "$expected_http" ]]; then
    fail "$name — HTTP $code (expected $expected_http) body=${resp:0:200}"
    return 1
  fi
  local api_code
  api_code=$(json_code "$resp")
  if [[ "$api_code" != "0" ]]; then
    fail "$name — envelope code=$api_code body=${resp:0:200}"
    return 1
  fi
  pass "$name"
  printf '%s' "$resp"
}

cleanup() {
  if [[ -n "$WIKI_ID" ]]; then
    curl -sfS --max-time "$TIMEOUT" -X POST \
      -H "Content-Type: application/json" \
      -H "x-tdai-service-id: $SERVICE_ID" \
      -d "{\"wiki_ids\":[\"$WIKI_ID\"]}" \
      "$BASE_URL$API_PREFIX/wiki/delete" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "team-knowledge smoke test"
echo "  base:       $BASE_URL"
echo "  service_id: $SERVICE_ID"
echo "  team_id:    $TEAM_ID"
echo ""

# 1. Liveness
health=$(check_http "GET /health" GET "$BASE_URL/health" 200) || true
if [[ -n "${health:-}" ]] && grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' <<<"$health"; then
  pass "health payload status=ok"
else
  [[ -n "${health:-}" ]] && fail "health payload missing status=ok"
fi

# 2. OpenAPI / docs mount (non-fatal if missing in slim builds)
if curl -sfS --max-time "$TIMEOUT" -o /dev/null -w '%{http_code}' "$BASE_URL/docs" | grep -qE '^(200|301|302)$'; then
  pass "GET /docs reachable"
else
  red "  WARN: GET /docs not reachable (optional)"
fi

# 3. Wiki list (empty OK)
check_api_envelope "POST /wiki/list" POST "/wiki/list" "{\"team_id\":\"$TEAM_ID\"}" 200 >/dev/null || true

# 4. Code-graph list (empty OK)
check_api_envelope "POST /code-graph/list" POST "/code-graph/list" "{\"team_id\":\"$TEAM_ID\"}" 200 >/dev/null || true

# 5. Wiki create → get → delete (SQLite + routes)
SMOKE_NAME="smoke-$(date +%s)"
create_resp=$(check_api_envelope "POST /wiki/create" POST "/wiki/create" \
  "{\"team_id\":\"$TEAM_ID\",\"name\":\"$SMOKE_NAME\",\"user_id\":\"smoke-user\"}" 200) || \
create_resp=$(check_api_envelope "POST /wiki/create" POST "/wiki/create" \
  "{\"team_id\":\"$TEAM_ID\",\"name\":\"$SMOKE_NAME\",\"user_id\":\"smoke-user\"}" 201) || create_resp=""

if [[ -n "$create_resp" ]]; then
  WIKI_ID=$(json_field "$create_resp" "data.wiki_id")
  if [[ -z "$WIKI_ID" ]] && command -v jq >/dev/null 2>&1; then
    WIKI_ID=$(jq -r '.data.wiki_id // empty' <<<"$create_resp")
  fi
  if [[ -n "$WIKI_ID" ]]; then
    pass "wiki create returned wiki_id=$WIKI_ID"
  else
    fail "wiki create missing wiki_id in response"
  fi

  if [[ -n "$EXPECT_PUBLIC_URL" ]]; then
    svc_url=$(json_field "$create_resp" "data.service_url")
    if [[ -z "$svc_url" ]] && command -v jq >/dev/null 2>&1; then
      svc_url=$(jq -r '.data.service_url // empty' <<<"$create_resp")
    fi
    if [[ "$svc_url" == "$EXPECT_PUBLIC_URL" ]]; then
      pass "service_url matches EXPECT_PUBLIC_URL"
    else
      fail "service_url=$svc_url expected $EXPECT_PUBLIC_URL"
    fi
  fi

  get_resp=$(check_api_envelope "POST /wiki/get" POST "/wiki/get" "{\"wiki_id\":\"$WIKI_ID\"}" 200) || true
  if [[ -n "${get_resp:-}" ]]; then
    got_name=$(json_field "$get_resp" "data.name")
    if [[ -z "$got_name" ]] && command -v jq >/dev/null 2>&1; then
      got_name=$(jq -r '.data.name // empty' <<<"$get_resp")
    fi
    if [[ "$got_name" == "$SMOKE_NAME" ]]; then
      pass "wiki get name matches"
    else
      fail "wiki get name=$got_name expected $SMOKE_NAME"
    fi
  fi

  del_resp=$(check_api_envelope "POST /wiki/delete" POST "/wiki/delete" "{\"wiki_ids\":[\"$WIKI_ID\"]}" 200) || true
  if [[ -n "$del_resp" ]]; then
    WIKI_ID="" # cleanup trap skip — already deleted
    pass "wiki delete completed"
  fi
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
green "All smoke checks passed."
