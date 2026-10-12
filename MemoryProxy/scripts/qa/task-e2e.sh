#!/usr/bin/env bash
# task-e2e.sh —— mem:create-task / mem:update-task 一步到位版的 HTTP 端点冒烟
#
# 前置：已有 initialized 且未绑 task_id 的 session（可用 scripts/qa/codex-init.sh 拿到）
# 用法：
#   BASE=http://127.0.0.1:8096 USER_KEY=sk-mem-xxx ./task-e2e.sh <session_id>
#
# 覆盖：
#   C1  未绑 + locked_title  → 落库成功
#   C3  已绑 + 再 create      → 409 alreadyBound
#   U3  已绑 + directDesc    → 落库成功
#   U1  未绑 + update         → 404 no task bound

set -uo pipefail

BASE="${BASE:?BASE required, e.g. BASE=http://127.0.0.1:8096}"
USER_KEY="${USER_KEY:?USER_KEY required (sk-mem-*)}"
SPACE="${SPACE:-default}"
SID="${1:?session_id required as first arg (must be initialized & not bound to task)}"
AGENT_SOURCE="${AGENT_SOURCE:-claude-code}"

step() { echo -e "\n===== $* =====" >&2; }

recent_messages_json='[{"role":"user","content":"我在开发一步到位的 create-task"},{"role":"assistant","content":"好，我记下了"}]'

# ── C1: create-task 有 locked_title ────────────────────────────────────
step "C1: create-task with locked_title=\"我的冒烟任务\""
RESP_C1=$(curl -sS -X POST "$BASE/v3/session/create-task" \
  -H "authorization: Bearer $USER_KEY" \
  -H 'content-type: application/json' \
  -d "$(cat <<EOF
{
  "session_key": "$SID",
  "agent_source": "$AGENT_SOURCE",
  "space_id": "$SPACE",
  "locked_title": "我的冒烟任务",
  "recent_messages": $recent_messages_json
}
EOF
)")
echo "$RESP_C1" | head -c 500
TASK_ID=$(echo "$RESP_C1" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("data",{}).get("task_id",""))' 2>/dev/null)
[[ -z "$TASK_ID" ]] && { echo -e "\nFAIL C1: no task_id in response"; exit 1; }
echo -e "\n✅ C1 pass, task_id=$TASK_ID"

# ── C3: 再 create → 应 409 ────────────────────────────────────────────
step "C3: create-task again → expect 409 alreadyBound"
CODE_C3=$(curl -sS -o /tmp/c3.json -w "%{http_code}" -X POST "$BASE/v3/session/create-task" \
  -H "authorization: Bearer $USER_KEY" \
  -H 'content-type: application/json' \
  -d "$(cat <<EOF
{"session_key":"$SID","agent_source":"$AGENT_SOURCE","space_id":"$SPACE","locked_title":"重复","recent_messages":$recent_messages_json}
EOF
)")
cat /tmp/c3.json | head -c 300
if [[ "$CODE_C3" != "409" ]]; then echo -e "\nFAIL C3: expected 409 got $CODE_C3"; exit 1; fi
echo -e "\n✅ C3 pass (409)"

# ── U3: update-task 有 direct_description ────────────────────────────
step "U3: update-task with direct_description"
RESP_U3=$(curl -sS -X POST "$BASE/v3/session/update-task" \
  -H "authorization: Bearer $USER_KEY" \
  -H 'content-type: application/json' \
  -d "$(cat <<EOF
{
  "session_key": "$SID",
  "agent_source": "$AGENT_SOURCE",
  "space_id": "$SPACE",
  "direct_description": "冒烟脚本 U3 附加：一步到位版落库",
  "recent_messages": $recent_messages_json
}
EOF
)")
echo "$RESP_U3" | head -c 500
CODE_U3=$(echo "$RESP_U3" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("code",-1))')
if [[ "$CODE_U3" != "0" ]]; then echo -e "\nFAIL U3: code=$CODE_U3"; exit 1; fi
echo -e "\n✅ U3 pass"

echo -e "\n─────────────────────────────────────────────"
echo "所有冒烟通过 ✅ (task_id=$TASK_ID)"
echo "U1 场景需要新 session，可再跑一次并对不同 SID 直接 update-task 观察 404"
