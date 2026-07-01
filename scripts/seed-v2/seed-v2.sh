#!/usr/bin/env bash
# ============================================================
# seed-v2.sh — 起 standalone gateway → 跑 seed-v2 → 验落盘 → 停
#
# 这是给"想完整自动化跑一次"的用户准备的便利 wrapper。
# 不想自动起停 gateway 的话，直接 `npm run seed-v2 -- --input <file>` 即可。
#
# 用法:
#   ./seed-v2.sh                       # 默认用 fixtures/minimal.json
#   ./seed-v2.sh path/to/fixture.json  # 用指定 fixture
#   ./seed-v2.sh --keep                # 跑完不停 gateway（调试）
#   ./seed-v2.sh --no-start            # 假设 gateway 已在跑（不 reset、不 start、不 stop）
#   ./seed-v2.sh --no-reset            # 不清空数据目录（增量灌）
#
# 透传给 seed-v2.ts 的环境变量:
#   SEED_ENDPOINT / SEED_API_KEY / SEED_SERVICE_ID
#   SEED_EVERY_N / SEED_POLL_MS / SEED_STABLE_ROUNDS / SEED_MAX_WAIT_MS
#   SEED_VERBOSE   1=详细 / 0=安静
#
# 退出码:
#   0  成功 + 落盘断言全部通过
#   1  seed 或断言失败
#   2  前置条件不满足
# ============================================================
set -euo pipefail

# Compute our own dir BEFORE sourcing env.sh (which overwrites SCRIPT_DIR).
SEED_V2_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SEED_V2_DIR/../.." && pwd)"
STANDALONE_HELPERS="$PLUGIN_ROOT/__tests__/standalone"

# 复用 standalone 测试套件里的 env / start / stop 工具（保持一份真理之源，
# 不在这里重复实现 gateway 起停）
if [ ! -f "$STANDALONE_HELPERS/env.sh" ]; then
  echo "✗ standalone helpers not found at: $STANDALONE_HELPERS" >&2
  echo "  this wrapper depends on env.sh / start.sh / stop.sh from there." >&2
  exit 2
fi
# shellcheck disable=SC1091
source "$STANDALONE_HELPERS/env.sh"

# ============================================================
# 参数
# ============================================================
KEEP_RUNNING=0
NO_START=0
DO_RESET=1
FIXTURE="$SEED_V2_DIR/fixtures/minimal.json"

while [ $# -gt 0 ]; do
  case "$1" in
    --keep)      KEEP_RUNNING=1 ;;
    --no-start)  NO_START=1; KEEP_RUNNING=1; DO_RESET=0 ;;
    --no-reset)  DO_RESET=0 ;;
    -h|--help)
      sed -n '2,25p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    -*)
      log_err "unknown flag: $1"
      exit 2
      ;;
    *)
      FIXTURE="$1"
      ;;
  esac
  shift
done

[ -f "$FIXTURE" ] || { log_err "fixture not found: $FIXTURE"; exit 2; }

# ============================================================
# Reset 数据目录（必须在 start.sh 之前）
# ============================================================
if [ "$DO_RESET" -eq 1 ]; then
  if echo "$STANDALONE_DATA_DIR" | grep -q "/\.codebuddy/"; then
    log_info "resetting data dir: $STANDALONE_DATA_DIR"
    rm -rf "$STANDALONE_DATA_DIR"
  else
    log_err "refuse to reset $STANDALONE_DATA_DIR (must be under .codebuddy/)"
    exit 2
  fi
fi

# ============================================================
# 起 gateway
# ============================================================
if [ "$NO_START" -eq 0 ]; then
  log_info "starting gateway..."
  if ! "$STANDALONE_HELPERS/start.sh"; then
    log_err "start.sh failed"
    exit 2
  fi
fi

if ! gateway_alive; then
  log_err "gateway not reachable at $STANDALONE_BASE"
  exit 2
fi

# ============================================================
# trap：保证不论结果如何，都按 KEEP_RUNNING 决定要不要停
# ============================================================
cleanup() {
  local rc=$?
  if [ "$KEEP_RUNNING" -eq 0 ]; then
    log_info "stopping gateway"
    "$STANDALONE_HELPERS/stop.sh" >/dev/null 2>&1 || true
  else
    log_info "gateway kept at $STANDALONE_BASE (use $STANDALONE_HELPERS/stop.sh to stop)"
  fi
  exit $rc
}
trap cleanup EXIT INT TERM

# ============================================================
# 跑 seed-v2（通过 npm bin）
# ============================================================
log_info "running seed-v2 with fixture: $FIXTURE"
echo

cd "$PLUGIN_ROOT"
SEED_ENDPOINT="${SEED_ENDPOINT:-$STANDALONE_BASE}" \
SEED_API_KEY="${SEED_API_KEY:-standalone-e2e}" \
SEED_SERVICE_ID="${SEED_SERVICE_ID:-default}" \
SEED_EVERY_N="${SEED_EVERY_N:-5}" \
SEED_POLL_MS="${SEED_POLL_MS:-500}" \
SEED_STABLE_ROUNDS="${SEED_STABLE_ROUNDS:-2}" \
SEED_MAX_WAIT_MS="${SEED_MAX_WAIT_MS:-600000}" \
SEED_VERBOSE="${SEED_VERBOSE:-1}" \
node "$PLUGIN_ROOT/bin/seed-v2.mjs" --input "$FIXTURE"

SEED_RC=$?

# ============================================================
# 落盘断言
# ============================================================
echo
log_info "=== Post-seed assertions ==="

ASSERT_PASS=0
ASSERT_FAIL=0
assert() {
  local name="$1"
  local cond="$2"
  if eval "$cond" >/dev/null 2>&1; then
    log_ok "$name"
    ASSERT_PASS=$((ASSERT_PASS+1))
  else
    log_err "$name"
    ASSERT_FAIL=$((ASSERT_FAIL+1))
  fi
}

# 1. L0: JSONL 镜像（standalone 特有）
TODAY="$(date +%Y-%m-%d)"
JSONL_PATH="$STANDALONE_DATA_DIR/conversations/$TODAY.jsonl"
assert "L0: JSONL mirror exists" "[ -f \"$JSONL_PATH\" ]"
if [ -f "$JSONL_PATH" ]; then
  JSONL_LINES=$(wc -l < "$JSONL_PATH")
  log_info "  JSONL line count: $JSONL_LINES"
fi

# 2. L0: SQLite (vectors.db)
DB_PATH="$STANDALONE_DATA_DIR/vectors.db"
assert "L0: SQLite vectors.db exists" "[ -f \"$DB_PATH\" ]"
SQLITE_BIN="$(command -v sqlite3 || true)"
if [ -z "$SQLITE_BIN" ] && [ -x "$HOME/miniconda3/bin/sqlite3" ]; then
  SQLITE_BIN="$HOME/miniconda3/bin/sqlite3"
fi
if [ -f "$DB_PATH" ] && [ -n "$SQLITE_BIN" ]; then
  L0_COUNT="$("$SQLITE_BIN" "$DB_PATH" "SELECT COUNT(*) FROM l0_conversations" 2>/dev/null || echo 0)"
  log_info "  SQLite l0_conversations count: $L0_COUNT"
  assert "L0: SQLite has records" "[ \"$L0_COUNT\" -gt 0 ]"
else
  log_info "L0: sqlite3 binary not found, skipping SQLite assertion"
fi

# 3. L1: records JSONL — 仅当 LLM key 配置时会有产出
RECORDS_DIR="$STANDALONE_DATA_DIR/records"
if [ -d "$RECORDS_DIR" ]; then
  RECORD_FILES="$(find "$RECORDS_DIR" -name "*.jsonl" -size +0 2>/dev/null | wc -l)"
  if [ "$RECORD_FILES" -gt 0 ]; then
    log_ok "L1: records/ has $RECORD_FILES non-empty jsonl file(s)  [LLM key configured]"
    ASSERT_PASS=$((ASSERT_PASS+1))
  else
    log_info "L1: records/ exists but empty (LLM key likely not configured — skipped, not a failure)"
  fi
else
  log_info "L1: records/ not created (LLM key likely not configured — skipped, not a failure)"
fi

# 4. Pipeline status: busy=false at the end
STATUS_RESP="$(curl -sS -X POST "$STANDALONE_BASE/v2/pipeline/status" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer standalone-e2e' \
  -H 'x-tdai-service-id: default' \
  -d '{}')"
assert "Pipeline status: busy=false at completion" \
  "echo '$STATUS_RESP' | python3 -c 'import sys,json; assert json.loads(sys.stdin.read())[\"data\"][\"busy\"] is False'"

# 汇总
echo
if [ "$ASSERT_FAIL" -gt 0 ]; then
  log_err "Post-seed assertions: $ASSERT_PASS passed, $ASSERT_FAIL failed"
  exit 1
fi
log_ok "Post-seed assertions: $ASSERT_PASS/$ASSERT_PASS passed"

exit $SEED_RC
