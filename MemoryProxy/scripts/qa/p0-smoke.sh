#!/usr/bin/env bash
# p0-smoke.sh —— Handler Pipeline 重构 P0 验证（24 项，全自动）
#
# 对照 docs/design/2026-09-22-refactor-verification-prioritized.md §P0
#
# 必填环境变量:
#   PROXY     proxy 根地址, 如 http://127.0.0.1:8096
#   KEY       合法 user_key (sk-mem-* / ck_* from MemoryPanel)
#   SPACE     spaceId (必须与 KEY 同实例, 否则 auth 401)
#   MODEL     价目表内的模型 (如 deepseek-v4-pro)
#
# 用法:
#   PROXY=http://127.0.0.1:8096 KEY=sk-mem-xxx SPACE=mem-xxxxxxxx \
#     MODEL=deepseek-v4-pro bash p0-smoke.sh

set -uo pipefail

PROXY="${PROXY:?PROXY required, e.g. PROXY=http://127.0.0.1:8096}"
KEY="${KEY:?KEY required (sk-mem-* / ck_* user_key)}"
SPACE="${SPACE:?SPACE required (spaceId, must match KEY instance)}"
MODEL="${MODEL:?MODEL required (e.g. deepseek-v4-pro)}"

PASS=0; FAIL=0; SKIP=0
declare -a FAILED_ITEMS=()

# 输出 helpers —— 单行结果，方便 grep
ok()   { printf '  \033[32mPASS\033[0m %-8s %s\n' "$1" "$2"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %-8s %s\n' "$1" "$2"; FAIL=$((FAIL+1)); FAILED_ITEMS+=("$1 $2"); }
skip() { printf '  \033[33mSKIP\033[0m %-8s %s\n' "$1" "$2"; SKIP=$((SKIP+1)); }
head_() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

# 发请求: $1=path $2=body $3=extra-header(可选) → 全局 HTTP_CODE / BODY
req() {
  local path="$1" body="$2" extra="${3:-}"
  local out
  if [[ -n "$extra" ]]; then
    out=$(curl -s -m 30 -w $'\n%{http_code}' -X POST "$PROXY$path" \
      -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -H "$extra" -d "$body" 2>/dev/null)
  else
    out=$(curl -s -m 30 -w $'\n%{http_code}' -X POST "$PROXY$path" \
      -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d "$body" 2>/dev/null)
  fi
  HTTP_CODE=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
}

# 发请求但不带 Authorization
req_noauth() {
  local path="$1" body="$2"
  local out
  out=$(curl -s -m 30 -w $'\n%{http_code}' -X POST "$PROXY$path" \
    -H "Content-Type: application/json" -d "$body" 2>/dev/null)
  HTTP_CODE=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
}

# 发非 JSON body
req_badjson() {
  local path="$1"
  local out
  out=$(curl -s -m 30 -w $'\n%{http_code}' -X POST "$PROXY$path" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    --data-raw 'this is not json{{{' 2>/dev/null)
  HTTP_CODE=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
}

##############################################################################
head_ "P0-A 转发基本可用 (6)"
##############################################################################

# P0-A1 合法 key + 非 stream → 200
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if [[ "$HTTP_CODE" == "200" && -n "$BODY" ]]; then
  ok "P0-A1" "非 stream 转发 200 (body $(printf '%s' "$BODY" | wc -c) bytes)"
else
  bad "P0-A1" "期望 200，实际 $HTTP_CODE｜$(printf '%s' "$BODY" | head -c 150)"
fi

# P0-A2 合法 key + stream → 200 + SSE
out=$(curl -s -m 30 -X POST "$PROXY/claude-code/$SPACE/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":32,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" 2>/dev/null)
if printf '%s' "$out" | grep -q "^event:\|^data:"; then
  ok "P0-A2" "stream 返回 SSE (含 data:/event:)"
else
  bad "P0-A2" "stream 未返回 SSE｜$(printf '%s' "$out" | head -c 150)"
fi

# P0-A3 非法 key → 401
out=$(curl -s -m 20 -w $'\n%{http_code}' -X POST "$PROXY/claude-code/$SPACE/v1/messages" \
  -H "Authorization: Bearer sk-invalid-key-does-not-exist" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" 2>/dev/null)
code=$(printf '%s' "$out" | tail -1); body=$(printf '%s' "$out" | sed '$d')
if [[ "$code" == "401" ]]; then
  ok "P0-A3" "非法 key → 401"
else
  bad "P0-A3" "期望 401，实际 $code｜$(printf '%s' "$body" | head -c 150)"
fi

# P0-A4 空 Authorization → 401
req_noauth "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if [[ "$HTTP_CODE" == "401" ]]; then
  ok "P0-A4" "空 Authorization → 401"
else
  bad "P0-A4" "期望 401，实际 $HTTP_CODE｜$(printf '%s' "$BODY" | head -c 150)"
fi

# P0-A5 非 JSON body → 400
req_badjson "/claude-code/$SPACE/v1/messages"
if [[ "$HTTP_CODE" == "400" ]] && printf '%s' "$BODY" | grep -qi "invalid json\|parse\|JSON"; then
  ok "P0-A5" "非 JSON → 400 + Invalid JSON"
else
  bad "P0-A5" "期望 400+Invalid JSON，实际 $HTTP_CODE｜$(printf '%s' "$BODY" | head -c 150)"
fi

# P0-A6 上游不可达 → 502
# 用一个独立实例验证（upstream.url 指向死端口）。默认实例上游可达，测不到。
# 若 DEAD_PROXY 未启动则 SKIP。
DEAD_PROXY="${DEAD_PROXY:-http://127.0.0.1:18197}"
out=$(curl -s -m 30 -w $'\n%{http_code}' -X POST "$DEAD_PROXY/direct/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" 2>/dev/null)
code=$(printf '%s' "$out" | tail -1); body=$(printf '%s' "$out" | sed '$d')
if [[ "$code" == "502" ]]; then
  ok "P0-A6" "上游不可达 → 502 ($(printf '%s' "$body" | jq -r '.detail // ""' 2>/dev/null))"
elif [[ -z "$code" || "$code" == "000" ]]; then
  skip "P0-A6" "死上游实例 (18197) 未启动"
else
  bad "P0-A6" "期望 502, 实际 $code"
fi

##############################################################################
head_ "P0-B 路由表完整性 (14)"
##############################################################################

# 路由命中判定: 期望"路由存在"。
# ⚠️ 不能只看 status != 404 —— proxy 会先把请求转发到上游，上游返 404 同样
#    是 404。必须用 proxy 自己的日志确认"该路径被 handler 处理过"。
#
# 判定方式: 打标前记录 proxy.log 行数 → 发请求 → 看新增日志里是否有该路径
PROXY_STDOUT="${PROXY_STDOUT:-/tmp/proxy-refactor.log}"

# 代理 stdout 日志增量工具（route_probe / D 组断言用）
log_lines() { wc -l < "$PROXY_STDOUT" 2>/dev/null || echo 0; }
log_delta() {
  local before="$1"
  tail -n +$((before+1)) "$PROXY_STDOUT" 2>/dev/null || true
}

route_probe() {
  local id="$1" path="$2" body="$3" expect="$4"
  local before_hit=""
  # proxy 主日志里搜 "-> REQ" / "FORWARD" / 该 path
  local before_lines=0
  [[ -f "$PROXY_STDOUT" ]] && before_lines=$(wc -l < "$PROXY_STDOUT")
  req "$path" "$body"
  local after_hit=""
  if [[ -f "$PROXY_STDOUT" ]] && (( before_lines > 0 )); then
    after_hit=$(tail -n +$((before_lines+1)) "$PROXY_STDOUT" 2>/dev/null | grep -cE "REQ |FORWARD|CODEX_AUX|DIRECT|pipeline" || true)
  fi

  if [[ "$expect" == "not404" ]]; then
    # 命中判据: 状态非 404，或日志里出现了被处理的痕迹
    if [[ "$HTTP_CODE" != "404" ]] || [[ "${after_hit:-0}" -gt 0 ]]; then
      ok "$id" "$path → $HTTP_CODE (路由命中, 日志 ${after_hit:-0} 行)"
    else
      bad "$id" "$path → 404 且代理日志无记录 (路由缺失)"
    fi
  elif [[ "$expect" == "404" ]]; then
    if [[ "$HTTP_CODE" == "404" ]]; then
      ok "$id" "$path → 404 (marker 未开启, 符合预期)"
    else
      bad "$id" "$path → $HTTP_CODE (期望 404)"
    fi
  fi
}

# P0-B1 CC 路径
route_probe "P0-B1" "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" not404
# P0-B2 CB 路径
route_probe "P0-B2" "/codebuddy/$SPACE/v1/chat/completions" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" not404
# P0-B3 codex 带 v1
route_probe "P0-B3" "/codex/$SPACE/v1/responses" \
  "{\"model\":\"$MODEL\",\"input\":[{\"role\":\"user\",\"content\":\"hi\"}]}" not404
# P0-B4 codex 不带 v1
route_probe "P0-B4" "/codex/$SPACE/responses" \
  "{\"model\":\"$MODEL\",\"input\":[{\"role\":\"user\",\"content\":\"hi\"}]}" not404
# P0-B5 workbuddy 带 v1
route_probe "P0-B5" "/workbuddy/$SPACE/v1/responses" \
  "{\"model\":\"$MODEL\",\"input\":[{\"role\":\"user\",\"content\":\"hi\"}]}" not404
# P0-B6 workbuddy 不带 v1
route_probe "P0-B6" "/workbuddy/$SPACE/responses" \
  "{\"model\":\"$MODEL\",\"input\":[{\"role\":\"user\",\"content\":\"hi\"}]}" not404
# P0-B7 codex aux 三个路径 (+ 不带 v1 的变体)
# ⚠️ 上游 tokenhub 没有 compact / trace_summarize / realtime 端点，会返 404。
#    所以判定必须靠代理日志 (CODEX_AUX 记录)，不能只看 status。
B7_BAD=0
for aux in "v1/responses/compact" "v1/memories/trace_summarize" "v1/realtime/calls"; do
  bl=$(wc -l < "$PROXY_STDOUT" 2>/dev/null || echo 0)
  req "/codex/$SPACE/$aux" "{\"model\":\"$MODEL\",\"input\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
  hits=$(tail -n +$((bl+1)) "$PROXY_STDOUT" 2>/dev/null | grep -c "CODEX_AUX" || true)
  if (( hits > 0 )); then
    printf '  \033[36m··\033[0m %-8s /codex/%s/%s → %s (CODEX_AUX ✓)\n' "B7-sub" "$SPACE" "$aux" "$HTTP_CODE"
  else
    printf '  \033[31m··\033[0m %-8s /codex/%s/%s → %s (无 CODEX_AUX)\n' "B7-sub" "$SPACE" "$aux" "$HTTP_CODE"
    B7_BAD=$((B7_BAD+1))
  fi
done
if (( B7_BAD == 0 )); then
  ok "P0-B7" "codex aux 3 条路径全部命中 handler (上游 404 属预期)"
else
  bad "P0-B7" "codex aux 有 $B7_BAD 条未命中 handler"
fi
# P0-B8 /direct/* —— stripDirectPrefix 会把 /direct 之后的内容原样拼到
# config.upstream.url 后面。所以正确形态是 /direct/v1/messages（→ 上游 /v1/messages），
# 而不是 /direct/<spaceId>/v1/messages（会拼成上游不存在的路径）。
req "/direct/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if [[ "$HTTP_CODE" != "404" ]]; then
  ok "P0-B8" "/direct/v1/messages 命中 → $HTTP_CODE"
else
  bad "P0-B8" "/direct/v1/messages → 404｜$(printf '%s' "$BODY" | head -c 120)"
fi
# P0-B9 utility 端点
req "/claude-code/$SPACE/v1/messages/count_tokens" \
  "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if [[ "$HTTP_CODE" != "404" ]]; then ok "P0-B9" "count_tokens 命中 → $HTTP_CODE"; else bad "P0-B9" "count_tokens 404"; fi
# P0-B10 catch-all 不 404
req "/some/random/path/v1/chat/completions" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if [[ "$HTTP_CODE" != "404" ]]; then ok "P0-B10" "catch-all 不 404 → $HTTP_CODE"; else bad "P0-B10" "catch-all 404"; fi
# P0-B11 /models
out=$(curl -s -m 20 -w $'\n%{http_code}' "$PROXY/claude-code/$SPACE/v1/models" -H "Authorization: Bearer $KEY" 2>/dev/null)
code=$(printf '%s' "$out" | tail -1); body=$(printf '%s' "$out" | sed '$d')
if [[ "$code" == "200" ]] && printf '%s' "$body" | jq -e '.data' >/dev/null 2>&1; then
  ok "P0-B11" "/v1/models → 200 + .data ($(printf '%s' "$body" | jq '.data|length' 2>/dev/null) models)"
else
  bad "P0-B11" "期望 200+.data，实际 $code"
fi
# P0-B12 cost-guard marker（markerOptIn=false → 预期 404；true → 不 404）
MOPT=$(curl -s -m 5 "$PROXY/health" | jq -r '.costGuard' 2>/dev/null)
route_probe "P0-B12" "/claude-code/$SPACE/cost-guard/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
  "$([[ "$MOPT" == "enabled" ]] && echo not404 || echo 404)"
# P0-B13 analyse marker
route_probe "P0-B13" "/claude-code/$SPACE/analyse/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" not404
# P0-B14 codex cost-guard marker
route_probe "P0-B14" "/codex/$SPACE/cost-guard/v1/responses" \
  "{\"model\":\"$MODEL\",\"input\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
  "$([[ "$MOPT" == "enabled" ]] && echo not404 || echo 404)"

##############################################################################
head_ "P0-C 协议格式正确 (4)"
##############################################################################

# P0-C1 CB/openai 错误格式 {error:{message,type}}
req "/codebuddy/$SPACE/v1/chat/completions" \
  "{\"model\":\"no-such-model-xyz\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if printf '%s' "$BODY" | jq -e '.error.message' >/dev/null 2>&1; then
  ok "P0-C1" "CB 错误格式 .error.message 存在 ($HTTP_CODE)"
else
  bad "P0-C1" "CB 错误体缺 .error.message｜$(printf '%s' "$BODY" | head -c 200)"
fi
# P0-C2 CC/anthropic 错误格式 {type:error,error:{type,message}}
# ⚠️ 必须走 /proxy/ 路径 —— /claude-code/ 在本实例被 instance-upstream 覆盖，
#     model gate 按设计跳过（isCustomUpstream=true），错误体会直接透传上游。
req "/proxy/$SPACE/v1/messages" \
  "{\"model\":\"no-such-model-xyz\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if printf '%s' "$BODY" | jq -e '.type=="error" and .error.message' >/dev/null 2>&1; then
  ok "P0-C2" "CC 错误格式 type=error + .error.message ($HTTP_CODE)"
else
  bad "P0-C2" "CC 错误体格式不符｜$(printf '%s' "$BODY" | head -c 200)"
fi
# P0-C3 codex/wb 错误格式（Responses 风格）
req "/codex/$SPACE/v1/responses" \
  "{\"model\":\"no-such-model-xyz\",\"input\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if printf '%s' "$BODY" | jq -e '.error' >/dev/null 2>&1; then
  ok "P0-C3" "codex 错误格式含 .error ($HTTP_CODE)"
else
  bad "P0-C3" "codex 错误体不符｜$(printf '%s' "$BODY" | head -c 200)"
fi
# P0-C4 stream Content-Type
ct=$(curl -s -m 25 -D - -o /dev/null -X POST "$PROXY/claude-code/$SPACE/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":8,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" 2>/dev/null \
  | grep -i "^content-type:" | head -1)
if printf '%s' "$ct" | grep -qi "text/event-stream"; then
  ok "P0-C4" "stream Content-Type=text/event-stream"
else
  bad "P0-C4" "Content-Type 不是 SSE｜$ct"
fi

##############################################################################
head_ "P0-D 实例上游配置 (4)"
##############################################################################

# P0-D1 未配模型组(official) → 200
# 本实例 default 组(official) 覆盖 workbuddy/dsh/opencode/hermes/openclaw/pi，
# 用 dsh 验证 official 路径落到全局 upstream.url。
before=$(log_lines)
req "/dsh/$SPACE/v1/chat/completions" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
delta=$(log_delta "$before")
fwd=$(printf '%s' "$delta" | grep -oE "FORWARD upstream=\S+" | head -1)
if [[ "$HTTP_CODE" == "200" ]]; then
  ok "P0-D1" "official 组(dsh) → 200｜$fwd"
else
  bad "P0-D1" "期望 200, 实际 $HTTP_CODE"
fi

# P0-D2/D3 blocked / unmanaged：本实例配置里没有 blocked 组，也没有未纳管 agent
# (8 个 agent 全被 default official 或 custom 组覆盖)，构造不出来 → SKIP 并说明。
skip "P0-D2" "blocked → 400 UPSTREAM_DISABLED｜实例配置里无 blocked 组"
skip "P0-D3" "unmanaged → 400 AGENT_NOT_CONFIGURED｜8 个 agent 全被 default/custom 覆盖"

# P0-D4 custom_unified → 替换上游 URL + apiKey
# 本实例有两个 custom_unified 组: codebuddy → api.deepseek.com,
# claude-code → api.deepseek.com/anthropic。验证各自的 FORWARD 目标。
before=$(log_lines)
req "/codebuddy/$SPACE/v1/chat/completions" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
cb_fwd=$(printf '%s' "$(log_delta "$before")" | grep -oE "FORWARD upstream=\S+" | head -1)
before=$(log_lines)
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
cc_fwd=$(printf '%s' "$(log_delta "$before")" | grep -oE "FORWARD upstream=\S+" | head -1)
if printf '%s' "$cb_fwd" | grep -q "api.deepseek.com" && printf '%s' "$cc_fwd" | grep -q "api.deepseek.com"; then
  ok "P0-D4" "custom_unified 生效: cb→$(printf '%s' "$cb_fwd" | sed 's/.*upstream=//'), cc→$(printf '%s' "$cc_fwd" | sed 's/.*upstream=//')"
else
  bad "P0-D4" "custom 覆盖未生效｜cb=$cb_fwd cc=$cc_fwd"
fi

##############################################################################
printf '\n\033[1m========================================\033[0m\n'
printf '\033[1m P0 SMOKE 汇总\033[0m\n'
printf '\033[1m========================================\033[0m\n'
printf '  PASS=%d  FAIL=%d  SKIP=%d\n' "$PASS" "$FAIL" "$SKIP"
if (( ${#FAILED_ITEMS[@]} > 0 )); then
  printf '\n  失败项:\n'
  for it in "${FAILED_ITEMS[@]}"; do printf '    ✗ %s\n' "$it"; done
fi
printf '\n'
exit $(( FAIL > 0 ? 1 : 0 ))
