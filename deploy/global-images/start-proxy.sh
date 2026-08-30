#!/usr/bin/env bash
# 单独拉起 proxy（context-proxy，端口 8096）。
#
# proxy 的转发上游走 PROXY_UPSTREAM_URL（与 memory 组的 MEMORY_LLM_* 独立）。
# proxy 会调 memory:8420 做鉴权 / skill / tdai memory 注入；调 memory-hub:8125
# 做 sessionInit control plane。可以单跑 proxy 但相关能力会降级 / 关闭。
#
# 用法：
#   ./start-proxy.sh
#
# 需要以下 proxy 组参数（写在 .env）：
#   PROXY_UPSTREAM_URL / PROXY_UPSTREAM_API_KEY / PROXY_UPSTREAM_MODEL

set -euo pipefail
# 与 start-memory-core.sh 一致：禁用 MSYS 的 POSIX→Windows 路径自动转换；
# 否则 docker -v 的冒号会被误判成盘符，挂载源被拼成 `xxx;D`，config 挂载失效。
export MSYS_NO_PATHCONV=1
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

load_env
require_vars \
  PROXY_IMAGE PROXY_PORT \
  PROXY_UPSTREAM_URL PROXY_UPSTREAM_API_KEY PROXY_UPSTREAM_MODEL

# 与 memory-core 保持一致的 gateway 内部凭据（默认 local，仅本地体验）
MEMORY_CORE_GATEWAY_API_KEY="${MEMORY_CORE_GATEWAY_API_KEY:-local}"

CONTAINER=tdai-proxy
NETWORK=tdai-memory-stack

if ! $DOCKER network inspect "$NETWORK" >/dev/null 2>&1; then
  info "创建 docker 网络 $NETWORK"
  $DOCKER network create "$NETWORK" >/dev/null
fi

# 依赖检查（不阻塞，仅提醒）
if ! $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "tdai-memory-core"; then
  warn "memory-core 容器未运行，proxy 的 auth / tdai memory / skill 注入将全部降级。"
fi
if ! $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "tdai-memory-hub"; then
  warn "memory-hub 容器未运行，proxy 的 sessionInit control plane 不可达。"
fi

pull_image "$PROXY_IMAGE"
rm_container_if_exists "$CONTAINER"

# proxy 只从 YAML 读上游 URL / API key（不认 PROXY_UPSTREAM_URL 环境变量），
# 所以我们从 .env 生成一个最小 config.yaml 挂到容器 /data/config.yaml。
# 容器 CMD 已经是 [--config /data/config.yaml]。
CONFIG_DIR="${PROXY_CONFIG_DIR:-$SCRIPT_DIR/.proxy-config}"
mkdir -p "$CONFIG_DIR"
CONFIG_FILE="$CONFIG_DIR/config.yaml"

# ── 三大能力开关（默认最小可用；打开时自动串联依赖）──
# PROXY_ENABLE_AUTH        : 客户端凭 x-tdai-user-key 走内核 auth/verify → user_id
# PROXY_ENABLE_SESSION_INIT: 首轮弹表单选 team/agent/task；依赖 auth+tdai
# PROXY_ENABLE_TDAI        : L2/L3 记忆注入 + L1 召回；依赖 memory-core
#
# 便捷开关 PROXY_FULL_STACK=1 一键把三个都开。
if [[ "${PROXY_FULL_STACK:-0}" == "1" ]]; then
  PROXY_ENABLE_AUTH=1
  PROXY_ENABLE_TDAI=1
  PROXY_ENABLE_SESSION_INIT=1
fi
PROXY_ENABLE_AUTH="${PROXY_ENABLE_AUTH:-0}"
PROXY_ENABLE_TDAI="${PROXY_ENABLE_TDAI:-0}"
PROXY_ENABLE_SESSION_INIT="${PROXY_ENABLE_SESSION_INIT:-0}"
# ── Opik 可观测（TRACK：围绕调用链路 / Token / 记忆注入 / 工具交互补可观测）──
# PROXY_OPIK_ENABLED=1 时把 trace 上报到 PROXY_OPIK_URL（Opik 服务 /api/v1/private）。
# 默认关闭：不配 Opik 时零网络开销（opik.ts 内部全部 fire-and-forget）。
PROXY_OPIK_ENABLED="${PROXY_OPIK_ENABLED:-0}"
PROXY_OPIK_URL="${PROXY_OPIK_URL:-}"
PROXY_OPIK_API_KEY="${PROXY_OPIK_API_KEY:-}"

# sessionInit 依赖 auth 拿 user_id；开 sessionInit 时自动补 auth
if [[ "$PROXY_ENABLE_SESSION_INIT" == "1" && "$PROXY_ENABLE_AUTH" != "1" ]]; then
  warn "PROXY_ENABLE_SESSION_INIT=1 需要 auth；自动打开 PROXY_ENABLE_AUTH"
  PROXY_ENABLE_AUTH=1
fi

bool() { [[ "$1" == "1" ]] && echo "true" || echo "false"; }

PROXY_MODEL_ALIAS_CLIENT="${PROXY_MODEL_ALIAS_CLIENT:-claude-sonnet-*}"
# ── 前缀通配家族：Claude-sonnet / haiku / opus / fable 全系列，升级大版本自动命中 ──
WILDCARD_FAMILIES="claude-sonnet-* claude-haiku-* claude-opus-* claude-fable-*"
# ── 精确兜底：历史常见版本，即便通配逻辑没加载也能用 ──
# 常见客户端模型名统一映射到上游 PROXY_UPSTREAM_MODEL（glm-4.5-air）：
# Claude 系 + Codex/DeepSeek 系 + 智谱系 + 通义系
FIXED_ALIASES="claude-sonnet-4-5 claude-sonnet-5 claude-sonnet-5.1 claude-sonnet-6 claude-haiku-3-5 claude-haiku-4 claude-opus-4 claude-opus-5 claude-fable-1 deepseek-v4-flash deepseek-v4-pro deepseek-chat deepseek-reasoner glm-4.5 glm-4.6v glm-4.6 qwen3.8-flash qwen-max"
ALL_ENTRIES=""
# 上游模型自身条目：WorkBuddy 等客户端直接发送上游模型名（使用者自定义）时，
# 必须能在定价表中命中，否则报 "not a registered display name" 错误。
ALL_ENTRIES+="    - name: \"${PROXY_UPSTREAM_MODEL}\"
      modelName: \"${PROXY_UPSTREAM_MODEL}\"
      input: 0.0
      output: 0.0
      cacheRead: 0.0
      cacheWrite5m: 0.0
      cacheWrite1h: 0.0
"
for FAMILY in $WILDCARD_FAMILIES; do
  ALL_ENTRIES+="    - name: \"${PROXY_UPSTREAM_MODEL}\"
      modelName: \"${FAMILY}\"
      input: 0.0
      output: 0.0
      cacheRead: 0.0
      cacheWrite5m: 0.0
      cacheWrite1h: 0.0
"
done
for ALIAS in $FIXED_ALIASES; do
  ALL_ENTRIES+="    - name: \"${PROXY_UPSTREAM_MODEL}\"
      modelName: \"${ALIAS}\"
      input: 0.0
      output: 0.0
      cacheRead: 0.0
      cacheWrite5m: 0.0
      cacheWrite1h: 0.0
"
done
# 动态生成 injectors 列表：TDAI 关闭时不注入 tdai-memory（它占 ~3 万 token），
# 只保留 skill + knowledge（模板短，不影响响应速度）
PROXY_INJECTORS_LINES="    - skill
    - knowledge"
if [[ "$PROXY_ENABLE_TDAI" == "1" ]]; then
  PROXY_INJECTORS_LINES="$PROXY_INJECTORS_LINES
    - tdai-memory"
fi

# ── WorkBuddy Chat Completions 兼容开关 ───────────────────────────────────
# WorkBuddy 走 OpenAI Responses API（/v1/responses），但智谱 GLM 等上游只
# 实现 /chat/completions。开启后 proxy 会把 WorkBuddy 请求翻译成 chat 格式
# 转发，并把上游 chat SSE 翻译回 Responses SSE（见 workbuddyHandler.ts 与
# src/common/responses-chat-compat.ts）。
PROXY_WORKBUDDY_CHAT_COMPLETIONS="${PROXY_WORKBUDDY_CHAT_COMPLETIONS:-0}"
PROXY_WORKBUDDY_CHAT_TO_ANTHROPIC="${PROXY_WORKBUDDY_CHAT_TO_ANTHROPIC:-0}"
PROXY_WORKBUDDY_AGENTS_LINES=""
if [[ "$PROXY_WORKBUDDY_CHAT_COMPLETIONS" == "1" ]]; then
PROXY_WORKBUDDY_AGENTS_LINES="  agents:
    workbuddy:
      chatCompletions: true
      url: \"${PROXY_UPSTREAM_URL}\"
      apiKey: \"${PROXY_UPSTREAM_API_KEY}\""
elif [[ "$PROXY_WORKBUDDY_CHAT_TO_ANTHROPIC" == "1" ]]; then
  # TRACK 05A：WorkBuddy（Chat）→ Anthropic 风格上游
  PROXY_WORKBUDDY_AGENTS_LINES="  agents:
    workbuddy:
      url: \"${PROXY_ANTHROPIC_UPSTREAM_URL}\"
      apiKey: \"${PROXY_UPSTREAM_API_KEY}\"
      chatToAnthropic: true"
fi

# ── Codex 兼容开关（Chat Completions / TRACK 05B Responses→Anthropic）──────
# Codex 走 OpenAI Responses API，但智谱只实现 /chat/completions。开启后
# codexHandler 会把 /v1/responses 翻译成 /chat/completions（复用
# src/common/responses-chat-compat.ts，与 workbuddy 同一套转换层）。
PROXY_CODEX_CHAT_COMPLETIONS="${PROXY_CODEX_CHAT_COMPLETIONS:-0}"
PROXY_CODEX_RESPONSES_TO_ANTHROPIC="${PROXY_CODEX_RESPONSES_TO_ANTHROPIC:-0}"
PROXY_CODEX_AGENTS_LINES=""
if [[ "$PROXY_CODEX_CHAT_COMPLETIONS" == "1" ]]; then
  PROXY_CODEX_AGENTS_LINES="    codex:
      chatCompletions: true"
elif [[ "$PROXY_CODEX_RESPONSES_TO_ANTHROPIC" == "1" ]]; then
  # TRACK 05B：Codex（Responses 客户端）→ Anthropic 风格上游
  PROXY_CODEX_AGENTS_LINES="    codex:
      url: \"${PROXY_ANTHROPIC_UPSTREAM_URL}\"
      apiKey: \"${PROXY_UPSTREAM_API_KEY}\"
      responsesToAnthropic: true"
fi

# ── Claude Code 独立上游（Anthropic 协议）──────────────────────────────────
# 智谱同时提供两套兼容端点：
#   OpenAI 兼容   https://open.bigmodel.cn/api/paas/v4    （chat/completions）
#   Anthropic 兼容 https://open.bigmodel.cn/api/anthropic/v1 （messages）
# WorkBuddy 走 OpenAI 端点；Claude Code 走 Anthropic 端点，必须按 agent 单独
# 指 URL，否则会被转发到 OpenAI 端点的 /messages 导致 404。apiKey 与全局
# 上游 key 相同（智谱 key）。
PROXY_ANTHROPIC_UPSTREAM_URL="${PROXY_ANTHROPIC_UPSTREAM_URL:-}"
PROXY_CLAUDE_CODE_ANTHROPIC_TO_CHAT="${PROXY_CLAUDE_CODE_ANTHROPIC_TO_CHAT:-0}"
PROXY_CLAUDE_CODE_ANTHROPIC_TO_RESPONSES="${PROXY_CLAUDE_CODE_ANTHROPIC_TO_RESPONSES:-0}"
PROXY_RESPONSES_UPSTREAM_URL="${PROXY_RESPONSES_UPSTREAM_URL:-}"
PROXY_RESPONSES_UPSTREAM_API_KEY="${PROXY_RESPONSES_UPSTREAM_API_KEY:-}"
PROXY_RESPONSES_UPSTREAM_MODEL="${PROXY_RESPONSES_UPSTREAM_MODEL:-}"
PROXY_AGENTS_LINES="$PROXY_WORKBUDDY_AGENTS_LINES"
if [[ -n "$PROXY_CODEX_AGENTS_LINES" ]]; then
  PROXY_AGENTS_LINES="$PROXY_AGENTS_LINES
$PROXY_CODEX_AGENTS_LINES"
fi
if [[ -n "$PROXY_ANTHROPIC_UPSTREAM_URL" || "$PROXY_CLAUDE_CODE_ANTHROPIC_TO_RESPONSES" == "1" ]]; then
  if [[ "$PROXY_CLAUDE_CODE_ANTHROPIC_TO_CHAT" == "1" ]]; then
    # TRACK 05A：Claude Code（Anthropic）→ OpenAI 风格上游
    PROXY_CLAUDE_CODE_LINES="    claude-code:
      url: \"${PROXY_UPSTREAM_URL}\"
      apiKey: \"${PROXY_UPSTREAM_API_KEY}\"
      anthropicToChat: true"
  elif [[ "$PROXY_CLAUDE_CODE_ANTHROPIC_TO_RESPONSES" == "1" ]]; then
    # TRACK 05B：Claude Code（Anthropic 客户端）→ Responses 风格上游。
    # PROXY_RESPONSES_UPSTREAM_URL 需指向支持 OpenAI Responses API 的 base
    # （如阿里云百炼 https://dashscope.aliyuncs.com/compatible-mode/v1）。
    # apiKey / model 为该上游专用凭据与模型名（如 qwen-flash）。
    PROXY_CLAUDE_CODE_LINES="    claude-code:
      url: \"${PROXY_RESPONSES_UPSTREAM_URL:-${PROXY_UPSTREAM_URL}}\"
      apiKey: \"${PROXY_RESPONSES_UPSTREAM_API_KEY:-${PROXY_UPSTREAM_API_KEY}}\"
      model: \"${PROXY_RESPONSES_UPSTREAM_MODEL:-${PROXY_UPSTREAM_MODEL}}\"
      anthropicToResponses: true"
  else
    PROXY_CLAUDE_CODE_LINES="    claude-code:
      url: \"${PROXY_ANTHROPIC_UPSTREAM_URL}\"
      apiKey: \"${PROXY_UPSTREAM_API_KEY}\""
  fi
  PROXY_AGENTS_LINES="$PROXY_AGENTS_LINES
$PROXY_CLAUDE_CODE_LINES"
fi

info "生成 proxy config → $CONFIG_FILE  (auth=$(bool $PROXY_ENABLE_AUTH) session-init=$(bool $PROXY_ENABLE_SESSION_INIT) tdai=$(bool $PROXY_ENABLE_TDAI))"
info "  upstream.url    = ${PROXY_UPSTREAM_URL}"
info "  upstream.model  = ${PROXY_UPSTREAM_MODEL}"
info "  workbuddy chat-compat = $(bool $PROXY_WORKBUDDY_CHAT_COMPLETIONS)"
info "  codex chat-compat     = $(bool $PROXY_CODEX_CHAT_COMPLETIONS)"
info "  codex responses→anthropic = $(bool $PROXY_CODEX_RESPONSES_TO_ANTHROPIC)"
info "  claude-code anthropic→responses = $(bool $PROXY_CLAUDE_CODE_ANTHROPIC_TO_RESPONSES)"
info "  claude-code anthropic upstream = ${PROXY_ANTHROPIC_UPSTREAM_URL:-（未配置，走全局 url）}"
info "  wildcard aliases = claude-sonnet-* / claude-haiku-* / claude-opus-* / claude-fable-*  → ${PROXY_UPSTREAM_MODEL}"
info "  fixed fallbacks  = sonnet 4-5 / sonnet 5 / haiku 3-5 / opus 4 / fable 1 → ${PROXY_UPSTREAM_MODEL}"
info "  (升级 Claude Code、切 Sonnet/Haiku/Opus 模型都无需改配置)"
cat > "$CONFIG_FILE" <<YAML
# 由 start-proxy.sh 自动生成 —— 每次启动覆盖，请不要手动改。
server:
  host: 0.0.0.0
  port: 8096
  forwardTimeoutMs: 600000

upstream:
  url: "${PROXY_UPSTREAM_URL}"
  apiKey: "${PROXY_UPSTREAM_API_KEY}"
  autoDetect:
    enabled: ${PROXY_UPSTREAM_AUTO_DETECT:-false}
    timeoutMs: ${PROXY_UPSTREAM_AUTO_DETECT_TIMEOUT:-3000}
${PROXY_AGENTS_LINES}

log:
  file: ""
  level: info
  backend: console

# Opik 可观测：trace / LLM span 上报（含身份、会话、注入统计、工具交互 metadata）。
# 默认 disabled；开之前先起好 Opik 服务（见 MemoryProxy/docs/plugin-integration/2026-08-27-opik-observability.md）。
opik:
  enabled: $(bool $PROXY_OPIK_ENABLED)
  url: "${PROXY_OPIK_URL}"
  apiKey: "${PROXY_OPIK_API_KEY}"

# tdai 内核对接（用于 injection / skill / auth 拉取）
tdai:
  enabled: $(bool $PROXY_ENABLE_TDAI)
  endpoint: "http://memory-core:8420"
  apiKey: "${MEMORY_CORE_GATEWAY_API_KEY}"
  serviceId: default
  grants: ${PROXY_TDAI_GRANTS:-[]}
  memory:
    enabled: true
    inject: true
    writeL0: true
    bypassWritePolicy: "${TDAI_BYPASS_WRITE_POLICY:-skip}"
    bypassReadPolicy: "${TDAI_BYPASS_READ_POLICY:-none}"
    recallL1: true
    injectL2L3: true
    intentEmbedding:
      baseUrl: "${TDAI_INTENT_EMBEDDING_BASE_URL:-}"
      apiKey: "${TDAI_INTENT_EMBEDDING_API_KEY:-}"
      model: "${TDAI_INTENT_EMBEDDING_MODEL:-}"
      dimensions: ${TDAI_INTENT_EMBEDDING_DIMENSIONS:-1024}
      minScore: ${TDAI_INTENT_EMBEDDING_MIN_SCORE:-0.30}
      timeoutMs: ${TDAI_INTENT_EMBEDDING_TIMEOUT_MS:-3000}

skill:
  endpoint: "http://memory-core:8420"
  serviceToken: "${MEMORY_CORE_GATEWAY_API_KEY}"

auth:
  enabled: $(bool $PROXY_ENABLE_AUTH)
  url: "http://memory-core:8420"
  timeoutMs: 5000
  failPolicy: "${PROXY_AUTH_FAIL_POLICY:-fail-closed}"

sessionInit:
  enabled: $(bool $PROXY_ENABLE_SESSION_INIT)
  maxRetries: 3
  injectAgentContext: true
  injectTaskContext: true
  headerAutoSelect:
    enabled: true
    teamHeader: "x-team-id"
    agentHeader: "x-agent-id"
    taskHeader: "x-task-id"
    onMismatch: "form"
  autoConversationId:
    enabled: ${PROXY_AUTO_CONVERSATION_ID:-true}
    ttlMinutes: ${PROXY_AUTO_CONVERSATION_TTL:-30}
    strategy: ${PROXY_AUTO_CONVERSATION_STRATEGY:-per-key}
  taskMissingPolicy: ${PROXY_TASK_MISSING_POLICY:-skip}
  threadIsolation:
    enabled: ${PROXY_THREAD_ISOLATION:-false}

costGuard:
  enabled: false

# 打开 skill + knowledge + tdai-memory 三个注入器；
# knowledge 依赖 memory-hub 起来，否则 hook 内部会降级为空块。
injection:
  enabled: true
  # 注入微调（A/B）：default 全局默认 + perAgent 按客户端覆盖（见 .env 注释）
  maxTotalChars: ${PROXY_INJECTION_MAX_TOTAL_CHARS:-0}
  tuning:
    default:
      memoryToolsGuide: "${PROXY_INJECTION_GUIDE:-always}"
      recallCharBudget: ${TDAI_RECALL_CHAR_BUDGET:-2000}
    perAgent:
${PROXY_INJECTION_PER_AGENT_LINES:-}
  # 注入器生成 curl 模板时用的 base URL（客户端视角可达地址）。
  # 不配会导致 fallback 探测容器内网卡 IP（如 172.18.0.4），宿主机客户端不可达。
  # host.docker.internal 在 Docker Desktop 上解析到宿主机，端口已 -p 映射。
  externalGatewayUrl: "${PROXY_EXTERNAL_URL}"
  injectors:
    - skill
    - knowledge
    - tdai-memory

contextCompaction:
  enabled: ${PROXY_CONTEXT_COMPACTION:-false}
  keepRounds: ${PROXY_CONTEXT_COMPACTION_ROUNDS:-5}
  summarize: false

redis:
  enabled: false

# 会话状态与身份绑定持久化（sqlite → named volume，重建容器后 session 可恢复，
# 避免"Proxy 重启后身份丢失、记忆张冠李戴"的问题）
storage:
  enabled: true
  backend: sqlite
  ttlDays: 7
  archiveNamespaces: ${PROXY_ARCHIVE_NAMESPACES:-[]}
  sqlite:
    dbPath: "/data/tdai-memory-proxy/proxy.db"

# 模型别名映射：前缀通配（*）+ 精确兜底双层策略覆盖 Claude 全系常用版本。
# 前缀通配：claude-sonnet / haiku / opus / fable 家族所有版本号（4-5 / 5 / 5.1 / 6 ...）
# 精确兜底：即便 pricing.ts 的通配逻辑没加载，历史常见版本也能命中。
# 升级 Claude Code、切 Sonnet/Haiku/Opus/Fable 模型都无需手动改配置。
creditPricing:
  models:
${ALL_ENTRIES}
YAML

info "启动 proxy (image=$PROXY_IMAGE, port=$PROXY_PORT)"
# 项目根目录：deploy/global-images 往上两级 → TencentDB-Agent-Memory-feat-server_team
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)/../.."
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"
PROXY_SRC_DIR="$PROJECT_ROOT/MemoryProxy/src"
# 解决 Git Bash on Windows 的路径转换问题（把 /c/xxx 转成 C:/xxx 让 Docker Desktop 认得）
if command -v cygpath >/dev/null 2>&1; then
  PROXY_SRC_DIR="$(cygpath -m "$PROXY_SRC_DIR")"
elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
  # Git Bash 无 cygpath 时的兜底：把 /c/XXX 转成 C:/XXX
  if [[ "$PROXY_SRC_DIR" == /?/* ]]; then
    DRIVE="${PROXY_SRC_DIR:1:1}"
    REST="${PROXY_SRC_DIR:3}"
    PROXY_SRC_DIR="${DRIVE^^}:/${REST}"
  fi
fi
info "  proxy src mount = $PROXY_SRC_DIR → /app/src（本地源码改动自动生效，无需 cp）"

# ⚠️ 注意：所有 -v 挂载不允许加 :ro 结尾。
# 在 Git Bash (MSYS) 环境下，冒号会被 POSIX→Windows 路径转换误判为盘符（如 :ro 被当成 D:），
# 导致 Source/Destination 被错误拼接，最终容器内读不到 /data/config.yaml → fallback 到占位符 upstream。
# 本地开发环境对源码和 config 没有强制只读需求，去掉 :ro 可同时修复挂载 + 避免 IDE 改文件被锁只读。
$DOCKER run -d --name "$CONTAINER" --restart always \
  --network "$NETWORK" \
  --network-alias proxy \
  --add-host=host.docker.internal:host-gateway \
  -p "${PROXY_PORT}:8096" \
  -e "TDAI_CLIENT_PLATFORM=${TDAI_CLIENT_PLATFORM:-}" \
  -e "TDAI_INTENT_EMBEDDING_BASE_URL=${TDAI_INTENT_EMBEDDING_BASE_URL:-}" \
  -e "TDAI_INTENT_EMBEDDING_API_KEY=${TDAI_INTENT_EMBEDDING_API_KEY:-}" \
  -e "TDAI_INTENT_EMBEDDING_MODEL=${TDAI_INTENT_EMBEDDING_MODEL:-}" \
  -v "$CONFIG_FILE:/data/config.yaml" \
  -v "$PROXY_DATA_VOLUME:/data/tdai-memory-proxy" \
  -v "$PROXY_SRC_DIR:/app/src" \
  "$PROXY_IMAGE" >/dev/null

wait_healthy "$CONTAINER" 90
ok "proxy 已启动 → http://localhost:${PROXY_PORT}/"
ok "  用法：把 coding agent 的 API base 指向 http://localhost:${PROXY_PORT}"
