#!/usr/bin/env bash
set -euo pipefail

# 先确保 config 目录存在，避免用户 bind-mount 文件时父目录缺失被当成目录挂载。
mkdir -p /app/panel/config "${KNOWLEDGE_DATA_DIR:-/data/knowledge}" "$(dirname "${KNOWLEDGE_DB_PATH:-/data/knowledge/knowledge.db}")"

# 用户可通过挂载 /app/panel/config/metadata-instances.json 提供多实例配置；
# 此时 REMOTE_INSTANCE_* env 不再必需，脚本也不会覆盖该文件。
INSTANCES_FILE="/app/panel/config/metadata-instances.json"
USER_PROVIDED_INSTANCES=0
if [[ -f "$INSTANCES_FILE" ]]; then
  USER_PROVIDED_INSTANCES=1
  echo "[start-combined] detected user-provided $INSTANCES_FILE; skipping env-based generation"
fi

if [[ "$USER_PROVIDED_INSTANCES" -ne 1 ]]; then
  : "${REMOTE_INSTANCE_URL:?REMOTE_INSTANCE_URL is required, e.g. http://host.docker.internal:8420 (or mount metadata-instances.json)}"
  : "${REMOTE_INSTANCE_KEY:?REMOTE_INSTANCE_KEY is required, e.g. local or admin gateway key (or mount metadata-instances.json)}"
fi

PANEL_PORT="${PANEL_PORT:-8125}"
KNOWLEDGE_PORT="${KNOWLEDGE_PORT:-8424}"
INSTANCE_ID="${REMOTE_INSTANCE_ID:-default}"
INSTANCE_NAME="${REMOTE_INSTANCE_NAME:-$INSTANCE_ID}"
KS_INTERNAL_URL="http://127.0.0.1:${KNOWLEDGE_PORT}"
# service_url 需包含 API prefix（/v3），context_proxy 会拼成 {service_url}/tools/list。
KS_PUBLIC_URL="${KNOWLEDGE_PUBLIC_BASE_URL:-${KS_INTERNAL_URL}/v3}"
PROXY_BASE_URL="${KNOWLEDGE_LLM_PROXY_BASE_URL:-}"

# 仅当用户未提供 instances 文件时，才用 REMOTE_INSTANCE_* env 生成单实例配置。
# REMOTE_INSTANCE_PROXY_URL 为可选项：
#   - 未设置 → 不写 proxy_endpoint 字段，Panel UI "客户端接入地址"卡片仍按老行为
#     回落到 gateway_endpoint（线上部署 gateway 前置 proxy 时两者合一，无需改动）
#   - 已设置 → 写入 proxy_endpoint；此时 UI 卡片显示的接入地址会切到 proxy，
#     但 Panel 后端 → Kernel 的转发地址仍走 gateway_endpoint（不受影响）
if [[ "$USER_PROVIDED_INSTANCES" -ne 1 ]]; then
# 只有非空时才拼一行 proxy_endpoint 到 dict 字面量里；空则完全不出现，保持老行为。
PROXY_ENDPOINT_LINE=""
if [[ -n "${REMOTE_INSTANCE_PROXY_URL:-}" ]]; then
  PROXY_ENDPOINT_LINE="    'proxy_endpoint': '${REMOTE_INSTANCE_PROXY_URL}',"
fi
python3 - <<PY
import json
from pathlib import Path
p=Path('$INSTANCES_FILE')
p.write_text(json.dumps({
  'instances': [{
    'id': '${INSTANCE_ID}',
    'name': '${INSTANCE_NAME}',
    'gateway_endpoint': '${REMOTE_INSTANCE_URL}',
${PROXY_ENDPOINT_LINE}
    'api_key': '${REMOTE_INSTANCE_KEY}',
  }]
}, ensure_ascii=False, indent=2) + '\n')
PY
fi

cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup INT TERM EXIT

export API_PREFIX="${API_PREFIX:-/v3}"
export KNOWLEDGE_DATA_DIR="${KNOWLEDGE_DATA_DIR:-/data/knowledge}"
export KNOWLEDGE_DB_PATH="${KNOWLEDGE_DB_PATH:-/data/knowledge/knowledge.db}"
export TDAI_AGENT_TEMPLATE_DIR="${TDAI_AGENT_TEMPLATE_DIR:-/data/knowledge/agent-templates}"
export KNOWLEDGE_PUBLIC_BASE_URL="${KS_PUBLIC_URL}"
export TMC_CALLBACK_URL="${TMC_CALLBACK_URL:-http://127.0.0.1:${PANEL_PORT}}"

# 日志落文件（持久化到 /data/knowledge/logs/，容器重启不丢）+ stdout（docker logs 可见）。
# Panel 和 KS 各自一个文件，避免混在一起难排查。
LOG_DIR="${LOG_DIR:-/data/knowledge/logs}"
mkdir -p "$LOG_DIR"
PANEL_LOG="$LOG_DIR/panel.log"
KNOWLEDGE_LOG="$LOG_DIR/knowledge.log"
# 每次启动轮转一次（保留上一份 .prev），避免单文件无限增长。
[[ -f "$PANEL_LOG" ]] && mv "$PANEL_LOG" "$PANEL_LOG.prev"
[[ -f "$KNOWLEDGE_LOG" ]] && mv "$KNOWLEDGE_LOG" "$KNOWLEDGE_LOG.prev"
echo "[start-combined] panel log → $PANEL_LOG" ; echo "[start-combined] knowledge log → $KNOWLEDGE_LOG"

# Knowledge LLM 路由（对齐 MemoryKnowledge/src/config.ts 读的变量名）。
#   LLM_MODE=proxy (默认)：wiki ingest 走 context_proxy（依赖 panel 推 llm_binding）。
#   LLM_MODE=custom：直连 OpenAI 兼容端点，需 LLM_API_KEY / LLM_BASE_URL。
export LLM_MODE="${LLM_MODE:-proxy}"
export LLM_PROVIDER="${LLM_PROVIDER:-custom}"
export LLM_API_KEY="${LLM_API_KEY:-}"
export LLM_BASE_URL="${LLM_BASE_URL:-}"
export LLM_MODEL="${LLM_MODEL:-Memory-Model}"
export LLM_MAX_TOKENS="${LLM_MAX_TOKENS:-32768}"
export LLM_TIMEOUT_MS="${LLM_TIMEOUT_MS:-1200000}"

# Panel 启动时为每个 instance 推一份 mode=proxy 的 llm_binding 给 knowledge。
# LLM_MODE=proxy 时强制同步（proxy 模式必须有 binding 才能工作）；
# LLM_MODE=custom 时由用户自行决定 KNOWLEDGE_LLM_BINDING_SYNC（默认仍为 1）。
SYNC_ENV="${KNOWLEDGE_LLM_BINDING_SYNC:-1}"
if [[ "${LLM_MODE}" == "proxy" ]]; then
  SYNC_ENV=1
fi

cd /app/knowledge
PORT="${KNOWLEDGE_PORT}" LOG_LEVEL="${LOG_LEVEL:-info}" \
  node "$(test -f dist/server.js && echo dist/server.js || echo dist/server.mjs)" 2>&1 \
  | tee -a "$KNOWLEDGE_LOG" &
KNOWLEDGE_PID=$!

# 等 KS 就绪再起 panel：panel 启动时会调 KS /v3/internal/llm-binding/status
# 检查 binding 是否存在（ensureKnowledgeLlmBindings），KS 没起来会 fetch failed。
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:${KNOWLEDGE_PORT}/health" >/dev/null 2>&1; then
    echo "knowledge service ready on :${KNOWLEDGE_PORT}"
    break
  fi
  sleep 0.5
  if ! kill -0 "$KNOWLEDGE_PID" 2>/dev/null; then
    echo "knowledge service exited before ready" >&2
    wait "$KNOWLEDGE_PID"
  fi
done

cd /app/panel
HOST=0.0.0.0 \
PORT="${PANEL_PORT}" \
UI_DIST_DIR=/app/panel/web/dist \
METADATA_INSTANCES_CONFIG=/app/panel/config/metadata-instances.json \
METADATA_REMOTE_TIMEOUT_MS="${METADATA_REMOTE_TIMEOUT_MS:-15000}" \
KNOWLEDGE_SERVICE_URL="${KS_INTERNAL_URL}" \
KNOWLEDGE_AUTH_TOKEN="${KNOWLEDGE_AUTH_TOKEN:-}" \
KNOWLEDGE_TIMEOUT_MS="${KNOWLEDGE_TIMEOUT_MS:-15000}" \
KNOWLEDGE_LLM_BINDING_SYNC="${SYNC_ENV}" \
KNOWLEDGE_LLM_PROXY_BASE_URL="${PROXY_BASE_URL}" \
LOG_LEVEL="${LOG_LEVEL:-info}" \
LOG_FORMAT="${LOG_FORMAT:-json}" \
node dist/index.js 2>&1 \
  | tee -a "$PANEL_LOG" &
PANEL_PID=$!

for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:${PANEL_PORT}/health" >/dev/null 2>&1; then
    echo "combined service ready: panel=:${PANEL_PORT}, knowledge=:${KNOWLEDGE_PORT}, instance=${INSTANCE_ID}"
    break
  fi
  sleep 0.5
  if ! kill -0 "$PANEL_PID" 2>/dev/null; then
    echo "panel service exited" >&2
    wait "$PANEL_PID"
  fi
done

wait -n "$KNOWLEDGE_PID" "$PANEL_PID"
