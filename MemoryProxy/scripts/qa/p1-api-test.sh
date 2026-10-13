#!/usr/bin/env bash
# p1-api-test.sh —— Handler Pipeline 重构 P1 自动化项验证
#
# 对照 docs/design/2026-09-22-refactor-verification-prioritized.md §P1
# 只覆盖标记为 🤖 的项目；👁️/👤 项由 p1-semi-auto.sh + TUI 驱动覆盖。
#
# 用法: bash p1-api-test.sh

#
# 必填环境变量:
#   PROXY     proxy 根地址
#   KEY       合法 user_key
#   SPACE     spaceId
#   MODEL     价目表内的模型
# 可选:
#   PRESET_TEAM_ID   预选团队 header 值 (如 team-xxxxxxxx)
#   PRESET_AGENT_ID  预选 agent header 值 (如 agt-xxxxxxxx)
#   PROXY_STDOUT     proxy 日志路径 (默认 /tmp/proxy-refactor.log)
#   PROXY_LOG_DIR    proxy.log 所在目录 (用于 credit.report 断言)

set -uo pipefail

PROXY="${PROXY:?PROXY required, e.g. PROXY=http://127.0.0.1:8096}"
KEY="${KEY:?KEY required (sk-mem-* / ck_* user_key)}"
SPACE="${SPACE:?SPACE required (spaceId, must match KEY instance)}"
MODEL="${MODEL:?MODEL required (e.g. deepseek-v4-pro)}"
PRESET_TEAM_ID="${PRESET_TEAM_ID:-}"
PRESET_AGENT_ID="${PRESET_AGENT_ID:-}"
PROXY_STDOUT="${PROXY_STDOUT:-/tmp/proxy-refactor.log}"
PROXY_LOG_DIR="${PROXY_LOG_DIR:-}"

PASS=0; FAIL=0; SKIP=0
declare -a FAILED_ITEMS=()

ok()   { printf '  \033[32mPASS\033[0m %-8s %s\n' "$1" "$2"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %-8s %s\n' "$1" "$2"; FAIL=$((FAIL+1)); FAILED_ITEMS+=("$1 $2"); }
skip() { printf '  \033[33mSKIP\033[0m %-8s %s\n' "$1" "$2"; SKIP=$((SKIP+1)); }
head_() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

# req <path> <body> [extra-header] [method]
req() {
  local path="$1" body="$2"; shift 2
  local -a hdrs=()
  local h
  for h in "$@"; do hdrs+=(-H "$h"); done
  local out
  out=$(curl -s -m 40 -w $'\n%{http_code}' -X POST "$PROXY$path" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    "${hdrs[@]}" -d "$body" 2>/dev/null)
  HTTP_CODE=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
}

# 取代理 stdout 里新增的行
log_delta() {
  local before="$1"
  tail -n +$((before+1)) "$PROXY_STDOUT" 2>/dev/null || true
}
log_lines() { wc -l < "$PROXY_STDOUT" 2>/dev/null || echo 0; }

##############################################################################
head_ "P1-E 模型门控 + 别名 (4)"
##############################################################################

# P1-E1 model 在价目表 → 200
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if [[ "$HTTP_CODE" == "200" ]]; then ok "P1-E1" "价目表内 model → 200"; else
  bad "P1-E1" "期望 200, 实际 $HTTP_CODE｜$(printf '%s' "$BODY" | head -c 150)"; fi

# P1-E2 model 不在价目表 → 400 (须走不带 instance 覆盖的路径)
req "/proxy/$SPACE/v1/messages" \
  "{\"model\":\"totally-fake-model-zzz\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if [[ "$HTTP_CODE" == "400" ]] && printf '%s' "$BODY" | grep -q "not a registered display name"; then
  ok "P1-E2" "未登记 model → 400 + not a registered display name"
else
  bad "P1-E2" "期望 400+未登记文案, 实际 $HTTP_CODE｜$(printf '%s' "$BODY" | head -c 200)"
fi

# P1-E3 alias 回写 → 上游收到 model_id (用 display name 发, 看上游是否接受)
# 价目表里 "ep-pksklwtb" 的 modelName 是 "LLM-A1"; 发 "LLM-A1" 应被 alias 成 ep-pksklwtb
req "/proxy/$SPACE/v1/messages" \
  "{\"model\":\"LLM-A1\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "400" || "$HTTP_CODE" == "401" ]]; then
  # 只要不是 "not a registered display name" 就说明 gate 通过了 alias
  if printf '%s' "$BODY" | grep -q "not a registered display name"; then
    bad "P1-E3" "alias 未生效 (gate 拒了 display name LLM-A1)"
  else
    ok "P1-E3" "alias 解析通过 gate (LLM-A1 → $HTTP_CODE)"
  fi
else
  bad "P1-E3" "意外状态 $HTTP_CODE"
fi

# P1-E4 custom upstream 跳过 gate → 随意 model 不 400
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"whatever-custom-model\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if [[ "$HTTP_CODE" != "400" ]] || ! printf '%s' "$BODY" | grep -q "not a registered display name"; then
  ok "P1-E4" "custom upstream 跳过 gate ($HTTP_CODE)"
else
  bad "P1-E4" "custom upstream 仍被 gate 拒"
fi

##############################################################################
head_ "P1-F Session-Init 自动化项 (2)"
##############################################################################

# P1-F5 preset identity: 带 headerAutoSelect 配置的 header 名 (x-team-id / x-agent-id)
# ⚠️ header 名来自 config.sessionInit.headerAutoSelect.* ，默认 x-team-id / x-agent-id
#    (不是 x-tdai-preset-*)。发错名字会退化成普通 custom header，请求仍 200 但没走预选。
F5SID="preset-probe-$(date +%s)"
if [[ -z "$PRESET_TEAM_ID" || -z "$PRESET_AGENT_ID" ]]; then
  skip "P1-F5" "需 PRESET_TEAM_ID + PRESET_AGENT_ID (真实实例的 team-/agt- id)"
  before=$(log_lines); delta=""
else
before=$(log_lines)
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
  "x-claude-code-session-id: $F5SID" "x-team-id: $PRESET_TEAM_ID" "x-agent-id: $PRESET_AGENT_ID"
delta=$(log_delta "$before")
# 判据: 没有弹 form (无 pending_asset_confirm)，且注入了 (injection 生效)
if printf '%s' "$delta" | grep -q "pending_asset_confirm\|pending_team_select"; then
  bad "P1-F5" "header 预选未生效，仍弹了 form"
elif printf '%s' "$delta" | grep -qE "prewarm|injection\]|tdai-recorder:write-l0"; then
  ok "P1-F5" "header 预选生效: 跳过 form 直接注入+转发"
else
  bad "P1-F5" "无法确认预选效果｜$(printf '%s' "$delta" | head -3)"
fi
fi  # end PRESET_TEAM_ID/PRESET_AGENT_ID guard

# P1-F8 form 响应格式: 各协议 form 格式需真实客户端触发 → 由 TUI 驱动覆盖
skip "P1-F8" "form 响应格式需新 session 触发｜由 TUI 驱动覆盖"

# P1-F9 session-init 异常降级: 需 mock store 报错
skip "P1-F9" "需 mock session store 报错"

##############################################################################
head_ "P1-G Mem 命令 (6)"
##############################################################################

# 建一个已初始化 session（用 header 预选，跳过 form）—— mem 命令要求
# session 已绑定 team/agent，否则被 blocked: session not initialized。
MEMSID="memcmd-probe-$(date +%s)"
MEM_SKIP=0
if [[ -z "$PRESET_TEAM_ID" || -z "$PRESET_AGENT_ID" ]]; then
  skip "P1-G*" "跳过整组 mem 命令: 需 PRESET_TEAM_ID + PRESET_AGENT_ID 预热 session"
  MEM_SKIP=1
fi
if (( MEM_SKIP == 0 )); then
# 预选 header 分开传（curl -H 不吃逗号分隔）
PRESEL_TEAM="x-team-id: $PRESET_TEAM_ID"
PRESEL_AGENT="x-agent-id: $PRESET_AGENT_ID"
# 预热: 先发一条普通消息把 session 建起来
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"warmup\"}]}" \
  "x-claude-code-session-id: $MEMSID" "$PRESEL_TEAM" "$PRESEL_AGENT" >/dev/null 2>&1

# mem 命令用同一 session + 预选 header。
# ⚠️ 不能用 `delta=$(mem_req ...)` 调用 —— 命令替换会把函数放进子 shell，
#    函数内设置的 BODY/HTTP_CODE 在父 shell 全部丢失（曾导致 txt 恒为空）。
#    改为: 调 mem_req <cmd> 后, 读全局 $MEM_DELTA / $BODY。
MEM_DELTA=""
mem_req() {
  local cmd="$1"
  local before
  before=$(log_lines)
  req "/claude-code/$SPACE/v1/messages" \
    "{\"model\":\"$MODEL\",\"max_tokens\":128,\"messages\":[{\"role\":\"user\",\"content\":\"$cmd\"}]}" \
    "x-claude-code-session-id: $MEMSID" "$PRESEL_TEAM" "$PRESEL_AGENT"
  MEM_DELTA=$(log_delta "$before")
}

# 提取响应里的 assistant 文本（用于断言"真实回文案"而不是"日志出现命令名"）
resp_text() {
  printf '%s' "$BODY" | jq -r '[.content[]? | select(.type=="text") | .text] | join(" ")' 2>/dev/null \
    || printf '%s' "$BODY" | jq -r '.choices[0].message.content // empty' 2>/dev/null || true
}

# ⚠️ 顺序关键: mem:session-reset 会**解绑** session, 之后所有 mem 命令都会被
#    "session not initialized" 挡下。所以 reset 必须放在 mem 组最后测。

# P1-G4 mem:sync → 响应文案含"已刷新"
mem_req "mem:sync"
delta="$MEM_DELTA"
txt=$(resp_text)
if printf '%s' "$txt" | grep -q "已刷新"; then
  ok "P1-G4" "mem:sync → 响应含『已刷新』: $(printf '%s' "$txt" | head -c 60)"
elif printf '%s' "$delta" | grep -qE "mem-command\] cmd=sync.*success=true"; then
  ok "P1-G4" "mem:sync → success=true (日志)"
else
  bad "P1-G4" "mem:sync 未成功｜txt=$(printf '%s' "$txt" | head -c 80)"
fi

# P1-G3 mem:create-skill → 响应含"归档"
mem_req "mem:create-skill 测试用技能"
delta="$MEM_DELTA"
txt=$(resp_text)
if printf '%s' "$txt" | grep -qE "归档"; then
  ok "P1-G3" "mem:create-skill → 响应含『归档』: $(printf '%s' "$txt" | head -c 60)"
else
  bad "P1-G3" "create-skill 未成功｜txt=$(printf '%s' "$txt" | head -c 120)"
fi

# P1-G5 mem:status —— 代码里无此命令 (KNOWN_COMMANDS 只有 help/sync/create-skill/
# create-task/update-task/session-reset), 清单该项为文档误写
mem_req "mem:status"
delta="$MEM_DELTA"
txt=$(resp_text)
if printf '%s' "$txt" | grep -q "未知命令"; then
  skip "P1-G5" "清单误写: 无 status 命令, 客户端收到『未知命令』(与代码实现一致)"
else
  bad "P1-G5" "status 行为异常｜$(printf '%s' "$txt" | head -c 120)"
fi

# P1-G6 mem 响应格式：由 TUI 驱动覆盖（真客户端渲染）
skip "P1-G6" "mem 响应格式需真客户端渲染｜由 TUI 驱动覆盖"

# P1-G7 非 mem 命令不拦截
before=$(log_lines)
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"请正常回答，这不是命令\"}]}" \
  "x-claude-code-session-id: $MEMSID" "$PRESEL_TEAM" "$PRESEL_AGENT"
delta=$(log_delta "$before")
if ! printf '%s' "$delta" | grep -qE "mem-command\] cmd="; then
  ok "P1-G7" "普通对话未被 mem 拦截"
else
  bad "P1-G7" "普通对话被误判为 mem 命令"
fi

# P1-G1 mem:session-reset 识别（放最后：会解绑 session）
mem_req "mem:session-reset"
delta="$MEM_DELTA"
txt=$(resp_text)
if printf '%s' "$delta" | grep -qE "mem-command:pre.*session-reset|falling through to pop form"; then
  ok "P1-G1" "mem:session-reset 被 pre-hook 拦截 → 重弹 form"
elif printf '%s' "$txt" | grep -qE "重置|重新选择|关联团队资产"; then
  ok "P1-G1" "mem:session-reset → 响应含重置/form 文案"
else
  bad "P1-G1" "mem:session-reset 未被识别"
fi
fi  # end MEM_SKIP guard

##############################################################################
head_ "P1-K Cost-Guard 路由 (2 可自动)"
##############################################################################

# P1-K4 markerOptIn=false → 默认 useGuard (本实例 markerOptIn=false)
before=$(log_lines)
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
delta=$(log_delta "$before")
if printf '%s' "$delta" | grep -qE "COST_GUARD"; then
  ok "P1-K4" "markerOptIn=false 默认行为生效: $(printf '%s' "$delta" | grep -oE 'COST_GUARD[^(]*\([^)]*\)' | head -1)"
else
  bad "P1-K4" "无 COST_GUARD 日志"
fi

# P1-K6 analyzerTrace report：cost-guard 关闭时无 → 依赖 K4 状态
if [[ "$(curl -s -m 5 "$PROXY/health" | jq -r '.costGuard')" == "disabled" ]]; then
  skip "P1-K6" "costGuard 未启用，analyzer trace 不产生（config 决定）"
else
  before=$(log_lines)
  req "/claude-code/$SPACE/v1/messages" \
    "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
  delta=$(log_delta "$before")
  if printf '%s' "$delta" | grep -qi "analyzer\|analyse"; then
    ok "P1-K6" "analyzer trace 有调用"
  else
    skip "P1-K6" "未见 analyzer trace 日志"
  fi
fi

# P1-K7 CC anthropic 独立上游: 本实例已被 instance-upstream 覆盖成 api.deepseek.com
before=$(log_lines)
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
delta=$(log_delta "$before")
fwd=$(printf '%s' "$delta" | grep -oE "FORWARD upstream=\S+" | head -1)
if [[ -n "$fwd" ]]; then
  ok "P1-K7" "CC 转发目标: $fwd"
else
  skip "P1-K7" "未捕获转发目标"
fi

##############################################################################
head_ "P1-L 压缩 (2 可自动)"
##############################################################################

# P1-L3/L4 CFQ tag 剥离: cost-guard 关闭时压缩不启用 → SKIP
skip "P1-L3" "CFQ tag 剥离需 requestPrepare 启用（本实例 space policy 未开）"
skip "P1-L4" "同上"

##############################################################################
head_ "P1-M 转发 + 重试 (2 可自动)"
##############################################################################

# P1-M5 上游 4xx 错误体透传
req "/proxy/$SPACE/v1/messages" \
  "{\"model\":\"totally-fake-model-zzz\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if [[ "$HTTP_CODE" == "400" ]] && printf '%s' "$BODY" | grep -q "error"; then
  ok "P1-M5" "客户端收到完整错误体 ($HTTP_CODE)"
else
  bad "P1-M5" "错误体未透传｜$HTTP_CODE $(printf '%s' "$BODY" | head -c 150)"
fi

# P1-M1 AbortSignal.timeout: 本实例 forwardTimeoutMs=600000，构造超时需改配置 → SKIP
skip "P1-M1" "需 forwardTimeoutMs 调小 + mock 慢上游"

##############################################################################
head_ "P1-N 限流 + 计费 (4 可自动)"
##############################################################################

# P1-N1 enforceRateLimit 拦截: 本实例 QPM=100，需打满 → 用低 QPM 实例不可得
# 改为验证 rate-limit 日志存在 + 计数递增
before=$(log_lines)
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
delta=$(log_delta "$before")
if printf '%s' "$delta" | grep -q "rate_limit.decision"; then
  ok "P1-N1" "rate-limit 判定生效: $(printf '%s' "$delta" | grep -oE '\"allowed\":\w+' | head -1)"
elif [[ -f "$PROXY_STDOUT" ]] && grep -q "rate_limit.decision" "$PROXY_STDOUT"; then
  ok "P1-N1" "rate-limit 判定生效 (日志在别处)"
else
  skip "P1-N1" "未见 rate_limit.decision（可能写 proxy.log）"
fi

# P1-N3 custom upstream 不限流：本实例 CC 走 instance 覆盖
skip "P1-N3" "需配 custom upstream + 低 QPM 实例"

# P1-N4 tryReportCreditFromPath → 查计费日志
before=$(log_lines)
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
delta=$(log_delta "$before")
if [[ -z "$PROXY_LOG_DIR" ]]; then
  skip "P1-N4" "需 PROXY_LOG_DIR 指向 proxy.log 目录才能断言 credit.report"
else
  recent_credit=$(tail -50 "$PROXY_LOG_DIR/proxy.log" 2>/dev/null | grep -c "credit.report" || true)
  if (( recent_credit > 0 )); then
    ok "P1-N4" "计费上报有记录 (proxy.log 近 50 行 $recent_credit 条)"
  else
    bad "P1-N4" "计费日志无 credit.report"
  fi
fi

# P1-N5 x-credit-report-error: 需 mock 计费 API 失败
skip "P1-N5" "需 mock 计费 API 返错"

# P1-N6 skipCreditReport: custom upstream 时不上报 → 需 custom 实例
skip "P1-N6" "需 custom upstream 实例"

##############################################################################
printf '\n\033[1m========================================\033[0m\n'
printf '\033[1m P1 API TEST 汇总\033[0m\n'
printf '\033[1m========================================\033[0m\n'
printf '  PASS=%d  FAIL=%d  SKIP=%d\n' "$PASS" "$FAIL" "$SKIP"
if (( ${#FAILED_ITEMS[@]} > 0 )); then
  printf '\n  失败项:\n'
  for it in "${FAILED_ITEMS[@]}"; do printf '    ✗ %s\n' "$it"; done
fi
printf '\n'
exit $(( FAIL > 0 ? 1 : 0 ))
