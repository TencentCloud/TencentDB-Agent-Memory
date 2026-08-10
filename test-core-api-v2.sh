#!/bin/bash
# ============================================================
# TencentDB-Agent-Memory Core API 功能测试脚本 v2 (修正版)
# 测试目标: http://127.0.0.1:8420
# 修正: 路由路径、schema 字段、隔离语义、pipeline 触发机制
# ============================================================

BASE_URL="http://127.0.0.1:8420"
AUTH_HEADER="Authorization: Bearer test-key"
SVC_HEADER="x-tdai-service-id: test-svc"
CT_HEADER="Content-Type: application/json"

TEAM_ID="test-team-qa"
USER_ID="test-user-qa"
AGENT_ID="test-agent-qa"
SESSION_ID="test-session-$(date +%s)"

PASS=0; FAIL=0; SKIP=0; TOTAL=0
RESULTS=""

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'

log_result() {
  local tc_id="$1" tc_name="$2" status="$3" detail="$4"
  TOTAL=$((TOTAL + 1))
  if [ "$status" = "PASS" ]; then PASS=$((PASS+1)); echo -e "  ${GREEN}[PASS]${NC} ${tc_id} ${tc_name}"
  elif [ "$status" = "FAIL" ]; then FAIL=$((FAIL+1)); echo -e "  ${RED}[FAIL]${NC} ${tc_id} ${tc_name} — ${detail}"
  else SKIP=$((SKIP+1)); echo -e "  ${YELLOW}[SKIP]${NC} ${tc_id} ${tc_name} — ${detail}"; fi
  RESULTS="${RESULTS}\n| ${tc_id} | ${tc_name} | ${status} | ${detail} |"
}

api_post() {
  local path="$1" body="$2"
  curl -s --max-time 30 -w "\n%{http_code}" -X POST "${BASE_URL}${path}" \
    -H "$CT_HEADER" -H "$AUTH_HEADER" -H "$SVC_HEADER" -d "$body" 2>/dev/null
}

api_get() {
  curl -s --max-time 10 -w "\n%{http_code}" "${BASE_URL}$1" -H "$AUTH_HEADER" -H "$SVC_HEADER" 2>/dev/null
}

parse_response() { HTTP_CODE=$(echo "$1" | tail -1); BODY=$(echo "$1" | sed '$d'); }

json_get() {
  echo "$1" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for k in '$2'.split('.'):
        d = d[int(k)] if isinstance(d, list) else d[k]
    print(d)
except: print('__ERROR__')
" 2>/dev/null
}

json_len() {
  echo "$1" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for k in '$2'.split('.'):
        d = d[int(k)] if isinstance(d, list) else d[k]
    print(len(d))
except: print('__ERROR__')
" 2>/dev/null
}

echo "============================================================"
echo " TencentDB-Agent-Memory Core API 功能测试 v2"
echo " 目标: ${BASE_URL}  时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================================"
echo ""

# ============================================================
# Phase 1: 基础连通性
# ============================================================
echo "▶ Phase 1: 基础连通性与健康检查"

parse_response "$(api_get /health)"
if [ "$HTTP_CODE" = "200" ]; then
  STATUS=$(json_get "$BODY" "status")
  EMBED=$(json_get "$BODY" "stores.embeddingService")
  VEC=$(json_get "$BODY" "stores.vectorStore")
  WORKER_CONSUMED=$(json_get "$BODY" "services.pipelineWorker.tasksConsumed")
  WORKER_FAILED=$(json_get "$BODY" "services.pipelineWorker.tasksFailed")
  log_result "TC-1.1" "Health 端点" "PASS" "status=${STATUS}, vector=${VEC}, embed=${EMBED}, worker=${WORKER_CONSUMED}consumed/${WORKER_FAILED}failed"
else
  log_result "TC-1.1" "Health 端点" "FAIL" "HTTP ${HTTP_CODE}"
fi

# Pipeline worker 无失败任务
if [ "$WORKER_FAILED" = "0" ]; then
  log_result "TC-1.2" "Pipeline Worker 无失败任务" "PASS" "failed=0"
else
  log_result "TC-1.2" "Pipeline Worker 无失败任务" "FAIL" "failed=${WORKER_FAILED}"
fi
echo ""

# ============================================================
# Phase 2: L0 对话管理
# ============================================================
echo "▶ Phase 2: L0 对话管理 (Conversation)"

# TC-2.1: 添加对话
ADD_BODY="{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\",\"session_id\":\"${SESSION_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"我喜欢用 Python 写代码，常用 VS Code 编辑器\"},{\"role\":\"assistant\",\"content\":\"好的，我记住了您偏好 Python 和 VS Code\"},{\"role\":\"user\",\"content\":\"我们团队的项目截止日期是 2026 年 9 月 15 日\"},{\"role\":\"assistant\",\"content\":\"收到，项目截止日期 2026-09-15\"}]}"
parse_response "$(api_post /v2/conversation/add "$ADD_BODY")"
if [ "$HTTP_CODE" = "200" ]; then
  ACC=$(json_len "$BODY" "data.accepted_ids")
  log_result "TC-2.1" "添加 4 条对话消息" "PASS" "accepted=${ACC}"
else
  log_result "TC-2.1" "添加 4 条对话消息" "FAIL" "HTTP ${HTTP_CODE}, ${BODY:0:200}"
fi

# TC-2.2: 查询对话 (conversation/query 替代 list+history)
parse_response "$(api_post /v2/conversation/query "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\",\"session_id\":\"${SESSION_ID}\",\"limit\":20}")"
if [ "$HTTP_CODE" = "200" ]; then
  Q_TOTAL=$(json_get "$BODY" "data.total")
  Q_LEN=$(json_len "$BODY" "data.messages")
  if [ "$Q_TOTAL" = "4" ]; then
    log_result "TC-2.2" "查询对话返回 4 条" "PASS" "total=${Q_TOTAL}"
  else
    log_result "TC-2.2" "查询对话返回 4 条" "FAIL" "total=${Q_TOTAL}, msgs=${Q_LEN}"
  fi
else
  log_result "TC-2.2" "查询对话返回 4 条" "FAIL" "HTTP ${HTTP_CODE}"
fi

# TC-2.3: 对话搜索 (FTS/BM25)
parse_response "$(api_post /v2/conversation/search "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\",\"query\":\"Python\",\"limit\":5}")"
if [ "$HTTP_CODE" = "200" ]; then
  S_STRATEGY=$(json_get "$BODY" "data.strategy")
  S_HITS=$(json_len "$BODY" "data.messages")
  log_result "TC-2.3" "对话搜索 'Python'" "PASS" "strategy=${S_STRATEGY}, hits=${S_HITS}"
else
  log_result "TC-2.3" "对话搜索 'Python'" "FAIL" "HTTP ${HTTP_CODE}, ${BODY:0:200}"
fi

# TC-2.4: 对话计数
parse_response "$(api_post /v3/conversation/count "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\"}")"
if [ "$HTTP_CODE" = "200" ]; then
  CNT=$(json_get "$BODY" "data.total_count")
  log_result "TC-2.4" "对话计数" "PASS" "count=${CNT}"
else
  log_result "TC-2.4" "对话计数" "FAIL" "HTTP ${HTTP_CODE}"
fi
echo ""

# ============================================================
# Phase 3: L3 核心记忆 (Core)
# ============================================================
echo "▶ Phase 3: L3 核心记忆 (Core)"

parse_response "$(api_post /v2/core/write "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\",\"content\":\"用户是高级软件工程师，偏好 Python 和 TypeScript。注重代码质量和测试覆盖率。\"}")"
if [ "$HTTP_CODE" = "200" ]; then
  CV=$(json_get "$BODY" "data.version")
  log_result "TC-3.1" "写入核心记忆" "PASS" "version=${CV}"
else
  log_result "TC-3.1" "写入核心记忆" "FAIL" "HTTP ${HTTP_CODE}, ${BODY:0:200}"
fi

parse_response "$(api_post /v2/core/read "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\"}")"
if [ "$HTTP_CODE" = "200" ]; then
  CC=$(json_get "$BODY" "data.content")
  if echo "$CC" | grep -q "Python"; then
    log_result "TC-3.2" "读取核心记忆" "PASS" ""
  else
    log_result "TC-3.2" "读取核心记忆" "FAIL" "内容不匹配"
  fi
else
  log_result "TC-3.2" "读取核心记忆" "FAIL" "HTTP ${HTTP_CODE}"
fi

parse_response "$(api_post /v3/core/count "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\"}")"
if [ "$HTTP_CODE" = "200" ]; then
  log_result "TC-3.3" "核心记忆计数" "PASS" ""
else
  log_result "TC-3.3" "核心记忆计数" "FAIL" "HTTP ${HTTP_CODE}"
fi
echo ""

# ============================================================
# Phase 4: L2 场景记忆 (Scenario)
# ============================================================
echo "▶ Phase 4: L2 场景记忆 (Scenario)"
# 注意: scenario/write 不是 upsert，文件须已存在(由 L2 pipeline 生成)
# 测试策略: 先 ls 查看已有文件，再对已有文件 read/write/rm

parse_response "$(api_post /v2/scenario/ls "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\"}")"
if [ "$HTTP_CODE" = "200" ]; then
  LS_TOTAL=$(json_get "$BODY" "data.total")
  log_result "TC-4.1" "列举场景文件" "PASS" "total=${LS_TOTAL}"
else
  log_result "TC-4.1" "列举场景文件" "FAIL" "HTTP ${HTTP_CODE}"
fi

# 如果有文件，测试 read + write(update) + rm
if [ "$LS_TOTAL" != "__ERROR__" ] && [ "$LS_TOTAL" -ge 1 ] 2>/dev/null; then
  FIRST_PATH=$(echo "$BODY" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    entries=d.get('data',{}).get('entries',[])
    files=[e['path'] for e in entries if not e['path'].endswith('/')]
    print(files[0] if files else '')
except: print('')
" 2>/dev/null)

  if [ -n "$FIRST_PATH" ]; then
    parse_response "$(api_post /v2/scenario/read "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\",\"path\":\"${FIRST_PATH}\"}")"
    if [ "$HTTP_CODE" = "200" ]; then
      log_result "TC-4.2" "读取场景文件" "PASS" "path=${FIRST_PATH}"
    else
      log_result "TC-4.2" "读取场景文件" "FAIL" "HTTP ${HTTP_CODE}"
    fi

    parse_response "$(api_post /v2/scenario/write "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\",\"path\":\"${FIRST_PATH}\",\"content\":\"更新后的场景内容\",\"summary\":\"测试更新\"}")"
    if [ "$HTTP_CODE" = "200" ]; then
      WV=$(json_get "$BODY" "data.version")
      log_result "TC-4.3" "更新场景文件" "PASS" "version=${WV}"
    else
      log_result "TC-4.3" "更新场景文件" "FAIL" "HTTP ${HTTP_CODE}"
    fi
  else
    log_result "TC-4.2" "读取场景文件" "SKIP" "无文件可读"
    log_result "TC-4.3" "更新场景文件" "SKIP" "无文件可更新"
  fi
else
  log_result "TC-4.2" "读取场景文件" "SKIP" "无场景文件(L2 pipeline 未生成)"
  log_result "TC-4.3" "更新场景文件" "SKIP" "无场景文件"
fi

# TC-4.4: 对不存在的文件 write 应返回 404 (设计行为)
parse_response "$(api_post /v2/scenario/write "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\",\"path\":\"nonexistent/file.md\",\"content\":\"test\"}")"
if [ "$HTTP_CODE" = "404" ]; then
  log_result "TC-4.4" "write 不存在文件返回 404" "PASS" "设计行为: 非 upsert"
else
  log_result "TC-4.4" "write 不存在文件返回 404" "FAIL" "HTTP ${HTTP_CODE} (期望 404)"
fi

parse_response "$(api_post /v3/scenario/count "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\"}")"
if [ "$HTTP_CODE" = "200" ]; then
  log_result "TC-4.5" "场景计数" "PASS" ""
else
  log_result "TC-4.5" "场景计数" "FAIL" "HTTP ${HTTP_CODE}"
fi
echo ""

# ============================================================
# Phase 5: Pipeline 与 L1 原子记忆
# ============================================================
echo "▶ Phase 5: Pipeline 与 L1 原子记忆"

# TC-5.1: Pipeline 状态
parse_response "$(api_post /v2/pipeline/status "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\"}")"
if [ "$HTTP_CODE" = "200" ]; then
  L1_IDLE=$(json_get "$BODY" "data.l1.idle")
  L2_IDLE=$(json_get "$BODY" "data.l2.idle")
  L3_IDLE=$(json_get "$BODY" "data.l3.idle")
  log_result "TC-5.1" "Pipeline 状态查询" "PASS" "l1_idle=${L1_IDLE}, l2_idle=${L2_IDLE}, l3_idle=${L3_IDLE}"
else
  log_result "TC-5.1" "Pipeline 状态查询" "FAIL" "HTTP ${HTTP_CODE}"
fi

# TC-5.2: Pipeline pause/resume
parse_response "$(api_post /v2/pipeline/pause "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\"}")"
if [ "$HTTP_CODE" = "200" ]; then
  log_result "TC-5.2" "Pipeline 暂停" "PASS" ""
else
  log_result "TC-5.2" "Pipeline 暂停" "FAIL" "HTTP ${HTTP_CODE}"
fi

parse_response "$(api_post /v2/pipeline/resume "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\"}")"
if [ "$HTTP_CODE" = "200" ]; then
  log_result "TC-5.3" "Pipeline 恢复" "PASS" ""
else
  log_result "TC-5.3" "Pipeline 恢复" "FAIL" "HTTP ${HTTP_CODE}"
fi

# TC-5.4: 等待 L1 提取 (pipeline 由 conversation/add 自动触发)
echo "  ⏳ 等待 L1 Pipeline 提取 (60s)..."
sleep 60

parse_response "$(api_post /v2/atomic/query "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\",\"limit\":20}")"
if [ "$HTTP_CODE" = "200" ]; then
  L1_TOTAL=$(json_get "$BODY" "data.total")
  if [ "$L1_TOTAL" != "__ERROR__" ] && [ "$L1_TOTAL" -ge 1 ] 2>/dev/null; then
    log_result "TC-5.4" "Pipeline 生成 L1 记忆" "PASS" "total=${L1_TOTAL}"
  else
    log_result "TC-5.4" "Pipeline 生成 L1 记忆" "FAIL" "total=${L1_TOTAL}"
  fi
else
  log_result "TC-5.4" "Pipeline 生成 L1 记忆" "FAIL" "HTTP ${HTTP_CODE}"
fi

# TC-5.5: L1 搜索
parse_response "$(api_post /v2/atomic/search "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\",\"query\":\"Python\",\"limit\":5}")"
if [ "$HTTP_CODE" = "200" ]; then
  L1_STRAT=$(json_get "$BODY" "data.strategy")
  L1_HITS=$(json_len "$BODY" "data.items")
  log_result "TC-5.5" "L1 搜索 'Python'" "PASS" "strategy=${L1_STRAT}, hits=${L1_HITS}"
else
  log_result "TC-5.5" "L1 搜索 'Python'" "FAIL" "HTTP ${HTTP_CODE}, ${BODY:0:200}"
fi

# TC-5.6: L1 更新
if [ "$L1_TOTAL" != "__ERROR__" ] && [ "$L1_TOTAL" -ge 1 ] 2>/dev/null; then
  QUERY_RESP=$(api_post /v2/atomic/query "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\",\"limit\":1}")
  L1_ID=$(echo "$QUERY_RESP" | sed '$d' | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    items=d.get('data',{}).get('items',[])
    print(items[0]['id'] if items else '')
except: print('')
" 2>/dev/null)

  if [ -n "$L1_ID" ]; then
    parse_response "$(api_post /v2/atomic/update "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\",\"id\":\"${L1_ID}\",\"content\":\"更新后：用户偏好 Python 和 Go\"}")"
    if [ "$HTTP_CODE" = "200" ]; then
      UV=$(json_get "$BODY" "data.version")
      log_result "TC-5.6" "L1 更新" "PASS" "id=${L1_ID:0:16}..., ver=${UV}"
    else
      log_result "TC-5.6" "L1 更新" "FAIL" "HTTP ${HTTP_CODE}, ${BODY:0:200}"
    fi
  else
    log_result "TC-5.6" "L1 更新" "SKIP" "无 L1 数据"
  fi
else
  log_result "TC-5.6" "L1 更新" "SKIP" "无 L1 数据"
fi

# TC-5.7: L1 计数
parse_response "$(api_post /v3/atomic/count "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\"}")"
if [ "$HTTP_CODE" = "200" ]; then
  L1C=$(json_get "$BODY" "data.total")
  log_result "TC-5.7" "L1 计数" "PASS" "count=${L1C}"
else
  log_result "TC-5.7" "L1 计数" "FAIL" "HTTP ${HTTP_CODE}"
fi
echo ""

# ============================================================
# Phase 6: 鉴权与参数校验
# ============================================================
echo "▶ Phase 6: 鉴权与参数校验"

# TC-6.1: 缺少 Authorization → 401
RESP=$(curl -s --max-time 10 -w "\n%{http_code}" -X POST "${BASE_URL}/v2/conversation/query" \
  -H "$CT_HEADER" -H "$SVC_HEADER" \
  -d "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\"}" 2>/dev/null)
HTTP_CODE=$(echo "$RESP" | tail -1)
if [ "$HTTP_CODE" = "401" ]; then
  log_result "TC-6.1" "缺少 Authorization → 401" "PASS" ""
else
  log_result "TC-6.1" "缺少 Authorization → 401" "FAIL" "HTTP ${HTTP_CODE}"
fi

# TC-6.2: 缺少 service-id → 401
RESP=$(curl -s --max-time 10 -w "\n%{http_code}" -X POST "${BASE_URL}/v2/conversation/query" \
  -H "$CT_HEADER" -H "$AUTH_HEADER" \
  -d "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\"}" 2>/dev/null)
HTTP_CODE=$(echo "$RESP" | tail -1)
if [ "$HTTP_CODE" = "401" ]; then
  log_result "TC-6.2" "缺少 service-id → 401" "PASS" ""
else
  log_result "TC-6.2" "缺少 service-id → 401" "FAIL" "HTTP ${HTTP_CODE}"
fi

# TC-6.3: 无效 JSON → 400
parse_response "$(api_post /v2/conversation/add "not-json")"
if [ "$HTTP_CODE" = "400" ]; then
  log_result "TC-6.3" "无效 JSON → 400" "PASS" ""
else
  log_result "TC-6.3" "无效 JSON → 400" "FAIL" "HTTP ${HTTP_CODE}"
fi

# TC-6.4: 空 messages → 400
parse_response "$(api_post /v2/conversation/add "{\"team_id\":\"${TEAM_ID}\",\"session_id\":\"s1\",\"messages\":[]}")"
if [ "$HTTP_CODE" = "400" ]; then
  log_result "TC-6.4" "空 messages → 400" "PASS" ""
else
  log_result "TC-6.4" "空 messages → 400" "FAIL" "HTTP ${HTTP_CODE}"
fi

# TC-6.5: 不存在路径 → 404
parse_response "$(api_post /v2/nonexistent "{}")"
if [ "$HTTP_CODE" = "404" ]; then
  log_result "TC-6.5" "不存在路径 → 404" "PASS" ""
else
  log_result "TC-6.5" "不存在路径 → 404" "FAIL" "HTTP ${HTTP_CODE}"
fi
echo ""

# ============================================================
# Phase 7: 数据隔离
# ============================================================
echo "▶ Phase 7: 数据隔离"

# TC-7.1: 跨 team 隔离 (L0)
parse_response "$(api_post /v2/conversation/query "{\"team_id\":\"other-team\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\",\"session_id\":\"${SESSION_ID}\",\"limit\":10}")"
if [ "$HTTP_CODE" = "200" ]; then
  ISO_T=$(json_get "$BODY" "data.total")
  if [ "$ISO_T" = "0" ]; then
    log_result "TC-7.1" "跨 team 隔离 (L0)" "PASS" ""
  else
    log_result "TC-7.1" "跨 team 隔离 (L0)" "FAIL" "total=${ISO_T} (应为 0)"
  fi
else
  log_result "TC-7.1" "跨 team 隔离 (L0)" "FAIL" "HTTP ${HTTP_CODE}"
fi

# TC-7.2: 跨 team 隔离 (L3 core)
parse_response "$(api_post /v2/core/read "{\"team_id\":\"other-team\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\"}")"
if [ "$HTTP_CODE" = "200" ]; then
  ISO_C=$(json_get "$BODY" "data.content")
  if [ "$ISO_C" = "__ERROR__" ] || [ "$ISO_C" = "None" ] || [ -z "$ISO_C" ]; then
    log_result "TC-7.2" "跨 team 隔离 (L3)" "PASS" ""
  else
    log_result "TC-7.2" "跨 team 隔离 (L3)" "FAIL" "返回了其他 team 数据"
  fi
elif [ "$HTTP_CODE" = "404" ]; then
  log_result "TC-7.2" "跨 team 隔离 (L3)" "PASS" "404=无数据"
else
  log_result "TC-7.2" "跨 team 隔离 (L3)" "FAIL" "HTTP ${HTTP_CODE}"
fi

# TC-7.3: 跨 agent 隔离 (L1)
parse_response "$(api_post /v2/atomic/query "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"other-agent\",\"limit\":10}")"
if [ "$HTTP_CODE" = "200" ]; then
  ISO_A=$(json_get "$BODY" "data.total")
  if [ "$ISO_A" = "0" ]; then
    log_result "TC-7.3" "跨 agent 隔离 (L1)" "PASS" ""
  else
    log_result "TC-7.3" "跨 agent 隔离 (L1)" "FAIL" "total=${ISO_A} (应为 0)"
  fi
else
  log_result "TC-7.3" "跨 agent 隔离 (L1)" "FAIL" "HTTP ${HTTP_CODE}"
fi

# TC-7.4: L3 跨 user 不隔离 (设计行为: L2/L3 按 team+agent 隔离，忽略 user_id)
parse_response "$(api_post /v2/core/read "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"other-user\",\"agent_id\":\"${AGENT_ID}\"}")"
if [ "$HTTP_CODE" = "200" ]; then
  ISO_U=$(json_get "$BODY" "data.content")
  if [ "$ISO_U" != "__ERROR__" ] && [ "$ISO_U" != "None" ] && [ -n "$ISO_U" ]; then
    log_result "TC-7.4" "L3 跨 user 共享 (设计行为)" "PASS" "team+agent 级隔离"
  else
    log_result "TC-7.4" "L3 跨 user 共享 (设计行为)" "FAIL" "未返回数据"
  fi
else
  log_result "TC-7.4" "L3 跨 user 共享 (设计行为)" "FAIL" "HTTP ${HTTP_CODE}"
fi
echo ""

# ============================================================
# Phase 8: 清理
# ============================================================
echo "▶ Phase 8: 清理测试数据"

# 删除 L1
if [ "$L1_TOTAL" != "__ERROR__" ] && [ "$L1_TOTAL" -ge 1 ] 2>/dev/null; then
  ALL_IDS=$(echo "$QUERY_RESP" | sed '$d' | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    items=d.get('data',{}).get('items',[])
    print(json.dumps([i['id'] for i in items]))
except: print('[]')
" 2>/dev/null)
  # 重新获取所有 ids
  ALL_RESP=$(api_post /v2/atomic/query "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\",\"limit\":50}")
  ALL_IDS=$(echo "$ALL_RESP" | sed '$d' | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    items=d.get('data',{}).get('items',[])
    print(json.dumps([i['id'] for i in items]))
except: print('[]')
" 2>/dev/null)
  if [ "$ALL_IDS" != "[]" ]; then
    parse_response "$(api_post /v2/atomic/delete "{\"ids\":${ALL_IDS}}")"
    if [ "$HTTP_CODE" = "200" ]; then
      DC=$(json_get "$BODY" "data.deleted_count")
      log_result "TC-8.1" "删除 L1 记忆" "PASS" "deleted=${DC}"
    else
      log_result "TC-8.1" "删除 L1 记忆" "FAIL" "HTTP ${HTTP_CODE}"
    fi
  else
    log_result "TC-8.1" "删除 L1 记忆" "SKIP" "无数据"
  fi
else
  log_result "TC-8.1" "删除 L1 记忆" "SKIP" "无数据"
fi

# 删除对话
HIST_RESP=$(api_post /v2/conversation/query "{\"team_id\":\"${TEAM_ID}\",\"user_id\":\"${USER_ID}\",\"agent_id\":\"${AGENT_ID}\",\"session_id\":\"${SESSION_ID}\",\"limit\":50}")
MSG_IDS=$(echo "$HIST_RESP" | sed '$d' | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    msgs=d.get('data',{}).get('messages',[])
    print(json.dumps([m['id'] for m in msgs if m.get('id')]))
except: print('[]')
" 2>/dev/null)
if [ "$MSG_IDS" != "[]" ] && [ -n "$MSG_IDS" ]; then
  parse_response "$(api_post /v2/conversation/delete "{\"message_ids\":${MSG_IDS}}")"
  if [ "$HTTP_CODE" = "200" ]; then
    DC2=$(json_get "$BODY" "data.deleted_count")
    log_result "TC-8.2" "删除对话消息" "PASS" "deleted=${DC2}"
  else
    log_result "TC-8.2" "删除对话消息" "FAIL" "HTTP ${HTTP_CODE}"
  fi
else
  log_result "TC-8.2" "删除对话消息" "SKIP" "无消息"
fi
echo ""

# ============================================================
# 报告
# ============================================================
echo "============================================================"
echo " 测试报告"
echo "============================================================"
echo " 总用例: ${TOTAL}"
echo -e " ${GREEN}通过: ${PASS}${NC}"
echo -e " ${RED}失败: ${FAIL}${NC}"
echo -e " ${YELLOW}跳过: ${SKIP}${NC}"
if [ "$TOTAL" -gt 0 ]; then
  echo " 通过率: $(echo "scale=1; ${PASS} * 100 / ${TOTAL}" | bc)%"
fi
echo ""
echo "| 编号 | 用例名称 | 结果 | 详情 |"
echo "|------|---------|------|------|"
echo -e "$RESULTS"
echo ""
echo " 完成时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================================"
