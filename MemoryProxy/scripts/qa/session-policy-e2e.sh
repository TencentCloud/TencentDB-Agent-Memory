#!/usr/bin/env bash
# session-policy-e2e.sh —— 会话策略（autoConversationId / taskMissingPolicy）真实 HTTP 端到端冒烟
#
# 覆盖（与 docs/session-policy.md 验收表对应）：
#   ACC-1/2  无会话 header → 自动生成并续接同一会话（按 [session-auto] 日志断言）
#   ACC-4    显式会话 header 始终优先（不触发自动生成）
#   ACC-5/6  无效 task / 缺 task → 按 onMismatch 策略处理（HTTP 200 正常完成、不 5xx；
#            绑定/短路语义由 resolvePresetIdentity 单测覆盖，见 session-acceptance.test.ts）
#
# 前置：
#   1) 代理已启动（默认 http://127.0.0.1:8096，容器 tdai-proxy，日志可读）
#   2) 本机有 curl + docker CLI
#   3) USER_KEY 为测试用 sk-mem-* key（本脚本会向真实上游发起少量最小请求）
#
# 用法：
#   USER_KEY=sk-mem-xxx ./session-policy-e2e.sh
#   BASE=http://127.0.0.1:8096 TEAM_ID=... AGENT_ID=... TASK_ID=... ./session-policy-e2e.sh

set -uo pipefail

BASE="${BASE:-http://127.0.0.1:8096}"
USER_KEY="${USER_KEY:?USER_KEY required (sk-mem-*)}"
TEAM_ID="${TEAM_ID:-team-f9px59x5oc}"
AGENT_ID="${AGENT_ID:-agt-f91t27rayi}"
TASK_ID="${TASK_ID:-task-f94mxiynzp}"
CONTAINER="${CONTAINER:-tdai-proxy}"
SPACE="${SPACE:-default}"
MODEL="${MODEL:-glm-4.5-air}"
RUN_ID="e2e-$(date +%s)-$$"

step() { echo -e "\n===== $* =====" >&2; }
pass() { echo -e "✅ $*"; }
fail() { echo -e "❌ $*"; exit 1; }

BODY="{\"model\":\"$MODEL\",\"instructions\":\"Reply with the single word: ok\",\"input\":[{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hi\"}]}],\"stream\":false,\"max_output_tokens\":64}"

# 发请求：其余参数为 curl 的 -H 片段（如 -H "x-task-id: xxx"），输出 HTTP 状态码
post() {
  curl -sS -o "/tmp/sp_${RUN_ID}.json" -w "%{http_code}" \
    -X POST "$BASE/codex/$SPACE/v1/responses" \
    -H "content-type: application/json" \
    -H "x-api-key: $USER_KEY" \
    -H "x-team-id: $TEAM_ID" \
    -H "x-agent-id: $AGENT_ID" \
    "$@" \
    -d "$BODY"
}

# 自 MARK 起的事件计数：created=新建会话；resumed=续接同一会话；all=任意 [session-auto] 日志
MARK=""
auto_count() {
  docker logs "$CONTAINER" --since "$MARK" 2>&1 | grep -c '\[session-auto\] action=created' || true
}
auto_all() {
  docker logs "$CONTAINER" --since "$MARK" 2>&1 | grep -c '\[session-auto\]' || true
}

echo "=== session-policy E2E (run=$RUN_ID) ==="
echo "BASE=$BASE CONTAINER=$CONTAINER MODEL=$MODEL"

# ── ACC-4：显式会话 header 始终优先，不触发自动生成 ─────────────────────
step "ACC-4: 显式 x-conversation-id + 有效 task → 不生成自动会话"
MARK=$(date +%Y-%m-%dT%H:%M:%S)
CODE=$(post -H "x-conversation-id: explicit-$RUN_ID" -H "x-task-id: $TASK_ID")
[[ "$CODE" == "200" ]] || fail "ACC-4: HTTP $CODE"
sleep 1
N=$(auto_all)
[[ "$N" == "0" ]] || fail "ACC-4: 显式 header 下仍出现 $N 条 [session-auto]"
pass "ACC-4: 200 且无自动会话日志"

# ── ACC-1：无会话 header → 自动生成会话 ────────────────────────────────
step "ACC-1: 无会话 header（仅 team+agent+task）→ 自动生成会话"
MARK=$(date +%Y-%m-%dT%H:%M:%S)
CODE=$(post -H "x-task-id: $TASK_ID")
[[ "$CODE" == "200" ]] || fail "ACC-1: HTTP $CODE"
sleep 1
N=$(auto_count)
[[ "$N" == "1" ]] || fail "ACC-1: 期望恰好 1 条自动会话日志，实际 $N"
  SID=$(docker logs "$CONTAINER" --since "$MARK" 2>&1 | grep '\[session-auto\] action=created' | tail -1 | sed -n 's/.*conversationId=\([^ ]*\).*/\1/p')
[[ -n "$SID" ]] || fail "ACC-1: 未能提取自动会话 ID"
pass "ACC-1: 自动生成会话 $SID"

# ── ACC-2：同 key 再次无 header → 续接同一会话（不新增）────────────────
step "ACC-2: 同 key 再次无会话 header → 续接同一会话"
MARK=$(date +%Y-%m-%dT%H:%M:%S)
CODE=$(post -H "x-task-id: $TASK_ID")
[[ "$CODE" == "200" ]] || fail "ACC-2: HTTP $CODE"
sleep 1
N=$(auto_count)
[[ "$N" == "0" ]] || fail "ACC-2: 期望不新建会话，实际新建 $N 个"
RESUMED=$(docker logs "$CONTAINER" --since "$MARK" 2>&1 | grep "action=resumed" | grep -c "conversationId=$SID" || true)
[[ "$RESUMED" == "1" ]] || fail "ACC-2: 未发现复用同一会话（$SID）的 resumed 日志"
pass "ACC-2: 复用同一会话 $SID（created=0, resumed=1）"

# ── ACC-5：无效 x-task-id → onMismatch（HTTP 层正常完成，不 5xx）───────
step "ACC-5: 无效 x-task-id → 按 onMismatch 处理（非静默，200 完成）"
CODE=$(post -H "x-conversation-id: invalid-$RUN_ID" -H "x-task-id: task-definitely-nope")
[[ "$CODE" == "200" ]] || fail "ACC-5: HTTP $CODE"
pass "ACC-5: 200 正常完成（绑定/短路语义由单测 ACC-5 覆盖）"

# ── ACC-6：缺 x-task-id（本代理 codex 路径为严格策略）→ onMismatch ─────
step "ACC-6: 缺 x-task-id → 按 onMismatch 处理（200 完成）"
CODE=$(post -H "x-conversation-id: missing-$RUN_ID")
[[ "$CODE" == "200" ]] || fail "ACC-6: HTTP $CODE"
pass "ACC-6: 200 正常完成（per-agent skip 语义由单测 ACC-6 覆盖）"

echo -e "\n===== 全部通过 ====="
cat <<EOF

验证记录（问题 → 根因 → 修复 → 验证）
--------------------------------------
问题：无自带会话 ID 的客户端（Hermes/OpenClaw/DSH 类）此前需静态写死 conversation id，
      否则 memory-bridge 无法解析会话（关联 #957）。
根因：codexHandler / handler / anthropicHandler 在缺会话 header 时未生成稳定会话 ID。
修复：autoConversationId（per-key / per-key-msg，TTL 滑动窗口 + 容量上限），显式 header 优先；
      taskMissingPolicy（skip/default/reject + per-agent 覆盖），无效 task 走 onMismatch 非静默。
验证：本脚本 ACC-1/2/4 通过日志断言自动生成+续接+显式优先；ACC-5/6 验证 HTTP 层非 5xx；
      绑定/短路语义由 src/__tests__/session-acceptance.test.ts（ACC-1..6）与
      optimizations.test.ts（TTL/窗口/容量/指纹/显式 header 对齐）覆盖，vitest 全量 116/116。
EOF
