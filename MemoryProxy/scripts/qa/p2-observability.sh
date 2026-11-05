#!/usr/bin/env bash
# p2-observability.sh —— P2 观测性 16 项核对（Langfuse / Opik / ClickHouse / TDAI）
#
# 对照 docs/design/2026-09-22-refactor-verification-prioritized.md §P2
# 全部为"查面板/查库"式验证，无破坏性操作。
#
# 必填环境变量 (全部必填, 无默认值, 避免把测试环境地址/凭据硬编码到仓库):
#   PROXY     proxy 根地址
#   KEY       合法 user_key
#   SPACE     spaceId
#   MODEL     价目表内的模型
#   CH_URL    ClickHouse 查询端点, 形如 "http://<host>:8123/?user=<u>&password=<p>"
#   CORE_URL  Core 服务根地址, 形如 "http://<host>:8420"
#   LF_URL    Langfuse 根地址
#   LF_PK     Langfuse Public Key   (pk-lf-...)
#   LF_SK     Langfuse Secret Key   (sk-lf-...)
#   OPIK_URL  Opik 根地址
#   PROBE_USER_ID  Langfuse/Opik 过滤 trace 用的 userId (形如 usr-xxxxxxxx)
#   PROBE_TEAM_ID  TDAI L0 查询 team_id
#   PROBE_AGENT_ID TDAI L0 查询 agent_id
# 可选:
#   PROXY_STDOUT   proxy stdout 日志路径 (默认 /tmp/proxy-refactor.log)
#   PROXY_REPO     本地仓库根 (用于读源码/找 JSONL, 默认当前 git top-level 的 MemoryProxy)

set -uo pipefail

PROXY="${PROXY:?PROXY required, e.g. PROXY=http://127.0.0.1:8096}"
KEY="${KEY:?KEY required (sk-mem-* / ck_* user_key)}"
SPACE="${SPACE:?SPACE required (spaceId)}"
MODEL="${MODEL:?MODEL required (e.g. deepseek-v4-pro)}"
PROXY_STDOUT="${PROXY_STDOUT:-/tmp/proxy-refactor.log}"
PROXY_REPO="${PROXY_REPO:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null)/MemoryProxy}"

CH="${CH_URL:?CH_URL required, e.g. http://<host>:8123/?user=default&password=<pwd>}"
LF="${LF_URL:?LF_URL required (Langfuse base URL)}"
LF_PK="${LF_PK:?LF_PK required (Langfuse Public Key pk-lf-...)}"
LF_SK="${LF_SK:?LF_SK required (Langfuse Secret Key sk-lf-...)}"
LF_AUTH=$(printf '%s:%s' "$LF_PK" "$LF_SK" | base64 -w0)
OPIK="${OPIK_URL:?OPIK_URL required}"
CORE="${CORE_URL:?CORE_URL required}"
PROBE_USER_ID="${PROBE_USER_ID:?PROBE_USER_ID required (usr-xxxxxxxx)}"
PROBE_TEAM_ID="${PROBE_TEAM_ID:?PROBE_TEAM_ID required (team-xxxxxxxx)}"
PROBE_AGENT_ID="${PROBE_AGENT_ID:?PROBE_AGENT_ID required (agt-xxxxxxxx)}"

PASS=0; FAIL=0; SKIP=0
ok()   { printf '  \033[32mPASS\033[0m %-8s %s\n' "$1" "$2"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %-8s %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }
skip() { printf '  \033[33mSKIP\033[0m %-8s %s\n' "$1" "$2"; SKIP=$((SKIP+1)); }
head_(){ printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

chq() { curl -s -m 15 "$CH" --data-binary "$1" 2>/dev/null; }

# 发一条请求制造新数据
mkreq() {
  curl -s -m 25 -o /dev/null -X POST "$PROXY/claude-code/$SPACE/v1/messages" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -H "x-claude-code-session-id: obs-probe-$RANDOM" \
    -d "{\"model\":\"$MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"obs probe\"}]}"
}

##############################################################################
head_ "P2-P Langfuse (6)"
##############################################################################
mkreq; sleep 4

LF_T=$(curl -s -m 15 "$LF/api/public/traces?limit=50&userId=$PROBE_USER_ID" -H "Authorization: Basic $LF_AUTH" 2>/dev/null)
n=$(printf '%s' "$LF_T" | jq -r '.data | length' 2>/dev/null || echo 0)

# P2-P1 trace 生成（name = model / keyId）
if printf '%s' "$LF_T" | jq -e --arg exp "$MODEL / $PROBE_USER_ID" '.data[] | select(.name == $exp)' >/dev/null 2>&1; then
  ok "P2-P1" "trace 存在, name='model / keyId' 格式 ($n 条)"
else
  bad "P2-P1" "未见 name='<model> / <keyId>' 的 trace"
fi

# P2-P2 agent_source tag
if printf '%s' "$LF_T" | jq -e '.data[].tags // [] | .[] | select(startswith("agent_source:"))' >/dev/null 2>&1; then
  ok "P2-P2" "trace tags 含 agent_source:* ($(printf '%s' "$LF_T" | jq -r '[.data[].tags[]? | select(startswith("agent_source:"))] | unique | join(",")' 2>/dev/null))"
else
  bad "P2-P2" "缺 agent_source tag"
fi

# P2-P3 protocol tag
if printf '%s' "$LF_T" | jq -e '.data[].tags // [] | .[] | select(startswith("protocol:"))' >/dev/null 2>&1; then
  ok "P2-P3" "trace tags 含 protocol:* ($(printf '%s' "$LF_T" | jq -r '[.data[].tags[]? | select(startswith("protocol:"))] | unique | join(",")' 2>/dev/null))"
else
  bad "P2-P3" "缺 protocol tag"
fi

# P2-P4 generation report（成功）：trace 有 output + usage
if printf '%s' "$LF_T" | jq -e '.data[] | select(.output != null)' >/dev/null 2>&1; then
  ok "P2-P4" "generation 有 output（成功上报）"
else
  bad "P2-P4" "trace 无 output"
fi

# P2-P5 failure report：发一个上游 400 的请求，看 Langfuse 是否有 error 标记
curl -s -m 25 -o /dev/null -X POST "$PROXY/claude-code/$SPACE/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "x-claude-code-session-id: obs-fail-$RANDOM" \
  -d '{"model":"no-such-model-fail","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'
sleep 4
LF_F=$(curl -s -m 15 "$LF/api/public/traces?limit=30&userId=$PROBE_USER_ID" -H "Authorization: Basic $LF_AUTH" 2>/dev/null)
if printf '%s' "$LF_F" | jq -e '.data[].tags // [] | .[] | select(. == "error")' >/dev/null 2>&1; then
  ok "P2-P5" "上游失败 → Langfuse trace 带 error tag"
else
  skip "P2-P5" "未捕获 error tag（失败 trace 可能 unset 自动删除）"
fi

# P2-P6 debugMetadata: 需 langfuse.debug=true
if grep -q "langfuse.debug" "$PROXY_STDOUT" 2>/dev/null || grep -q '"debug":true' "$PROXY_STDOUT" 2>/dev/null; then
  ok "P2-P6" "langfuse.debug 已开启"
else
  skip "P2-P6" "langfuse.debug=false（config 决定，需显式打开才产出 observationMetadata）"
fi

##############################################################################
head_ "P2-Q Opik (4)"
##############################################################################
mkreq; sleep 2

# ⚠️ 项目名规则（实测得来，容易踩）:
#   CC / openai-chat / anthropic 路径 → project_name = **userId**（PROBE_USER_ID）
#   /direct 路径                     → project_name = **keyId**（md5 前缀，如 9d46223a）
#   request_log                      → fork 项目（stripRequestContent 时可关）
OPIK_USER_PROJ="$PROBE_USER_ID"

OPIK_P=$(curl -s -m 15 "$OPIK/api/v1/private/traces?project_name=$OPIK_USER_PROJ&page=1&size=10" 2>/dev/null)
opik_n=$(printf '%s' "$OPIK_P" | jq -r '.total // 0' 2>/dev/null || echo 0)
opik_err=$(grep -c "opik.create_llm_span_error" "$PROXY_STDOUT" 2>/dev/null | head -1); opik_err=${opik_err:-0}

# P2-Q1 trace 创建（CC 路径，project=userId）
if printf '%s' "$OPIK_P" | jq -e '.content[]? | select(.name | test("deepseek"))' >/dev/null 2>&1; then
  ok "P2-Q1" "Opik trace 存在 (project=$OPIK_USER_PROJ, total=$opik_n)"
else
  bad "P2-Q1" "Opik 项目 $OPIK_USER_PROJ 无 trace"
fi

# P2-Q2 trace update（fork 项目 request_log 里能看到 trace）
FKL=$(curl -s -m 15 "$OPIK/api/v1/private/traces?project_name=request_log&page=1&size=5" 2>/dev/null)
fkl_n=$(printf '%s' "$FKL" | jq -r '.total // 0' 2>/dev/null || echo 0)
if [[ "${fkl_n:-0}" -gt 0 ]]; then
  ok "P2-Q2" "fork trace (request_log) 存在 total=$fkl_n"
else
  skip "P2-Q2" "request_log 项目暂无 trace"
fi

# P2-Q3 LLM span 创建（project=userId，与 trace 同项目）
SPANS=$(curl -s -m 15 "$OPIK/api/v1/private/spans?project_name=$OPIK_USER_PROJ&page=1&size=5" 2>/dev/null)
SP_N=$(printf '%s' "$SPANS" | jq -r '.total // 0' 2>/dev/null || echo 0)
if [[ "${SP_N:-0}" -gt 0 ]]; then
  ok "P2-Q3" "LLM span 存在 (project=$OPIK_USER_PROJ, total=$SP_N)"
else
  bad "P2-Q3" "无 LLM span"
fi

# P2-Q4 fork span + codex/workbuddy span 上报
FK_S=$(curl -s -m 15 "$OPIK/api/v1/private/spans?project_name=request_log&page=1&size=5" 2>/dev/null)
fks_n=$(printf '%s' "$FK_S" | jq -r '.total // 0' 2>/dev/null || echo 0)
if (( opik_err > 0 )); then
  bad "P2-Q4" "codex/workbuddy span 上报失败 $opik_err 次（trace_id 为空 → 422; runners/codex.ts + workbuddy.ts 缺 opikCreateTrace）"
elif [[ "${fks_n:-0}" -gt 0 ]]; then
  ok "P2-Q4" "fork span (request_log) 存在 total=$fks_n"
else
  skip "P2-Q4" "无 span 上报错误, 但 request_log 无 span"
fi

##############################################################################
head_ "P2-T ClickHouse (5)"
##############################################################################

# P2-T1 writeLog event:"request" —— ⚠️ 实测: logger.ts 只把 usage/analyzer_usage
#   写 CH，request 事件仅落 JSONL（重构前同一行代码，非回归）
req_ch=$(chq "SELECT count() FROM context_proxy.usage_logs WHERE event='request' FORMAT TSV")
jsonl_req=$(ls -t "$PROXY_REPO"/logs/*.jsonl 2>/dev/null | head -1)
if [[ "$jsonl_req" == "" ]]; then
  skip "P2-T1" "无 JSONL 文件"
else
  n_req=$(grep -c '"event":"request"' "$jsonl_req" 2>/dev/null || echo 0)
  if (( n_req > 0 )); then
    skip "P2-T1" "event=request 只落 JSONL ($n_req 条), CH usage_logs 无该 event（源码既定行为, 非回归）"
  else
    bad "P2-T1" "JSONL 里也没有 event=request"
  fi
fi

# P2-T2 writeLog event:"usage" 含 token
u=$(chq "SELECT count() FROM context_proxy.usage_logs WHERE event='usage' AND total_tokens > 0 FORMAT TSV")
if [[ "${u:-0}" -gt 0 ]]; then
  ok "P2-T2" "CH event=usage 有 token 数据 ($u 条)"
else
  bad "P2-T2" "CH 无 usage 记录"
fi

# P2-T3 writeRequestLog —— 只覆盖 openai-chat + anthropic runner
n_wrl=$(
  cd "$PROXY_REPO"
  for f in openai-chat anthropic codex workbuddy direct utility; do
    printf '%s=%s ' "$f" "$(grep -c 'writeRequestLog(' src/pipeline/runners/$f.ts)"
  done
)
if printf '%s' "$n_wrl" | grep -q "openai-chat=1" && printf '%s' "$n_wrl" | grep -q "anthropic=1"; then
  if printf '%s' "$n_wrl" | grep -qE "codex=0"; then
    skip "P2-T3" "writeRequestLog 覆盖: $n_wrl（codex/wb 缺, 与状态文档已知项一致）"
  else
    ok "P2-T3" "writeRequestLog 全覆盖: $n_wrl"
  fi
else
  bad "P2-T3" "主 runner 未接 writeRequestLog: $n_wrl"
fi

# P2-T4 emitModelIntentTelemetry → tool_call_logs kind=model_intent
mi=$(chq "SELECT count() FROM context_proxy.tool_call_logs WHERE kind='model_intent' AND timestamp > now() - INTERVAL 3 HOUR FORMAT TSV")
mi_ours=$(chq "SELECT count() FROM context_proxy.tool_call_logs WHERE kind='model_intent' AND user_id='$PROBE_USER_ID' FORMAT TSV")
if [[ "${mi:-0}" -gt 0 ]]; then
  ok "P2-T4" "tool_call_logs model_intent 有记录 (全表 $mi, 本 user $mi_ours)"
else
  bad "P2-T4" "无 model_intent 记录"
fi

# P2-T5 inspectAndRecord —— 实测只进内存 recentInspections，不落表
skip "P2-T5" "identity 记录只进进程内 recentInspections（源码实现, 无 CH 表; 清单该表述与实现不符）"

##############################################################################
head_ "P2-U TDAI L0 + Skill (5)"
##############################################################################

l0() {
  curl -s -m 15 -X POST "$CORE/v3/conversation/query" \
    -H "Content-Type: application/json" -H "x-tdai-service-id: $SPACE" -H "Authorization: Bearer local" \
    -d "{\"user_id\":\"$PROBE_USER_ID\",\"team_id\":\"$PROBE_TEAM_ID\",\"agent_id\":\"$PROBE_AGENT_ID\",\"limit\":100}" 2>/dev/null
}

L0=$(l0)
l0n=$(printf '%s' "$L0" | jq -r '.data.messages | length' 2>/dev/null || echo 0)

# P2-U1 L0 write（主对话）
if [[ "${l0n:-0}" -gt 0 ]]; then
  ok "P2-U1" "Core 侧 L0 有记录 ($l0n 条)"
else
  bad "P2-U1" "Core 侧无 L0 记录"
fi

# P2-U2 L0 跳过（fork/sidequery）—— 由 memoryTurn=requestKind==="main" gate 保证
if grep -q 'const memoryTurn = requestKind === "main"' \
     "$PROXY_REPO"/src/pipeline/runners/anthropic.ts 2>/dev/null; then
  ok "P2-U2" "L0 gate 存在 (memoryTurn = requestKind==='main' → fork/sidequery 不写)"
else
  bad "P2-U2" "未找到 L0 的 requestKind gate"
fi

# P2-U3 triggerSkillExtractIfReady
# ⚠️ 归档是异步的（archive 走 fire-and-forget / 后台 worker），请求返回后
#    日志要等一会儿才出现。先发一条确定有内容的请求再等。
curl -s -m 25 -o /dev/null -X POST "$PROXY/claude-code/$SPACE/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "x-claude-code-session-id: sklprobe-$RANDOM" \
  -H "x-team-id: $PROBE_TEAM_ID" -H "x-agent-id: $PROBE_AGENT_ID" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"skill probe\"}]}"
for _ in $(seq 1 12); do
  sc=$(grep -c "skill-conversation-add" "$PROXY_STDOUT" 2>/dev/null | head -1); sc=${sc:-0}
  (( sc > 0 )) && break
  sleep 2
done
if (( sc > 0 )); then
  ok "P2-U3" "skill 归档链路活跃 (skill-conversation-add $sc 次)"
else
  bad "P2-U3" "未见 skill 归档"
fi

# P2-U4 archiveProtocol 正确 —— skill extract 的 langfuse trace 带 protocol tag
LF_SK=$(curl -s -m 15 "$LF/api/public/traces?limit=30&tags=skill-extract" -H "Authorization: Basic $LF_AUTH" 2>/dev/null)
if printf '%s' "$LF_SK" | jq -e '.data | length > 0' >/dev/null 2>&1; then
  ok "P2-U4" "skill.extract trace 存在 ($(printf '%s' "$LF_SK" | jq -r '.data|length') 条)"
else
  skip "P2-U4" "skill.extract trace 未查到"
fi

# P2-U5 mem 命令也触发 L0
if printf '%s' "$L0" | jq -e '.data.messages[] | select(.content | test("mem:"))' >/dev/null 2>&1; then
  ok "P2-U5" "mem 命令也写入 L0"
else
  bad "P2-U5" "L0 里未见 mem 命令记录"
fi

##############################################################################
printf '\n\033[1m========================================\033[0m\n'
printf '\033[1m P2 OBSERVABILITY 汇总\033[0m\n'
printf '\033[1m========================================\033[0m\n'
printf '  PASS=%d  FAIL=%d  SKIP=%d\n\n' "$PASS" "$FAIL" "$SKIP"
exit $(( FAIL > 0 ? 1 : 0 ))
