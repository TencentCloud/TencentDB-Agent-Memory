#!/usr/bin/env bash
# 单独拉起 memory-hub（panel + knowledge 合并镜像，端口 8125 + 8424）。
#
# 依赖：memory 需要先起来（memory-hub 里 knowledge 调 memory 做 embed/RAG）。
# 如果 memory 容器不存在，此脚本会打 warn 但仍继续（LLM_MODE=proxy 时 memory-hub
# 自身可以启动，只是 knowledge 首次调 memory 时会失败）。
#
# 用法：
#   ./start-memory-hub.sh
#
# 需要以下 LLM 参数（写在 .env）：
#   MEMORY_LLM_BASE_URL / MEMORY_LLM_API_KEY / MEMORY_LLM_MODEL

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

load_env
require_vars \
  MEMORY_HUB_IMAGE PANEL_PORT KNOWLEDGE_PORT PANEL_VOLUME \
  MEMORY_LLM_BASE_URL MEMORY_LLM_API_KEY MEMORY_LLM_MODEL \
  KNOWLEDGE_PUBLIC_BASE_URL

# 与 memory-core 保持一致的 gateway 内部凭据（默认 local，仅本地体验）
MEMORY_CORE_GATEWAY_API_KEY="${MEMORY_CORE_GATEWAY_API_KEY:-local}"

# 确保 Panel ↔ Knowledge 服务间鉴权 key 存在（首次自动生成并回写 .env）
ensure_knowledge_service_key

# Panel UI "客户端接入地址"卡片显示的 base URL（供 CodeBuddy / ClaudeCode 拷贝使用）。
# 开源本地部署 core 和 proxy 分开跑，客户端要接的是 proxy，不是 core/gateway。
#
# 默认探测宿主机对外可达地址；Windows/MSYS、Linux、macOS 分别处理，
# 都失败时回退 localhost（仅同机使用，跨机需显式设 MEMORY_HUB_PROXY_PUBLIC_URL）。
#
# 显式设了 MEMORY_HUB_PROXY_PUBLIC_URL 环境变量则完全按你给的值来。
# 显式设为空字符串则 Panel 前端回落到 gateway_endpoint（老行为）。
# Panel 后端 → Kernel 的转发地址始终走 REMOTE_INSTANCE_URL，不受此变量影响。
if [[ -z "${MEMORY_HUB_PROXY_PUBLIC_URL+x}" ]]; then
  # 未设 → 用探测出的 IP + PROXY_PORT 拼默认值
  _host_ip=$(detect_host_ip)
  MEMORY_HUB_PROXY_PUBLIC_URL="http://${_host_ip}:${PROXY_PORT:-8096}"
  info "自动探测宿主机地址: MEMORY_HUB_PROXY_PUBLIC_URL=$MEMORY_HUB_PROXY_PUBLIC_URL"
  info "  (如需覆盖，在 .env 里显式设 MEMORY_HUB_PROXY_PUBLIC_URL=http://<your-ip>:${PROXY_PORT:-8096})"
fi

CONTAINER=tdai-memory-hub
NETWORK=tdai-memory-stack

if ! $DOCKER network inspect "$NETWORK" >/dev/null 2>&1; then
  info "创建 docker 网络 $NETWORK"
  $DOCKER network create "$NETWORK" >/dev/null
fi

# memory 未起来时给提醒，不阻塞
if ! $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "tdai-memory-core"; then
  warn "memory-core 容器未运行。memory-hub 能启动，但 knowledge 调 memory 时会失败。"
  warn "建议先 ./start-memory-core.sh 再来这里，或直接 ./start-all.sh"
fi

pull_image "$MEMORY_HUB_IMAGE"
rm_container_if_exists "$CONTAINER"

# 内部 knowledge 通过 upstream memory 调 LLM 走 custom 模式，直接指向 MEMORY_LLM_*
# LLM_MODE=custom → 不走 memory 的 LLM proxy，而是 knowledge 直连用户提供的端点
info "启动 memory-hub (image=$MEMORY_HUB_IMAGE, panel=$PANEL_PORT knowledge=$KNOWLEDGE_PORT)"
MSYS_NO_PATHCONV=1 $DOCKER run -d --name "$CONTAINER" \
  --network "$NETWORK" \
  --network-alias memory-hub \
  --add-host=host.docker.internal:host-gateway \
  -p "${PANEL_PORT}:8125" \
  -p "${KNOWLEDGE_PORT}:8424" \
  -v "${PANEL_VOLUME}:/data/knowledge" \
  -e PANEL_PORT=8125 \
  -e KNOWLEDGE_PORT=8424 \
  -e KNOWLEDGE_PUBLIC_BASE_URL="$KNOWLEDGE_PUBLIC_BASE_URL" \
  -e KNOWLEDGE_SERVICE_KEY="$KNOWLEDGE_SERVICE_KEY" \
  -e KNOWLEDGE_AUTH_TOKEN="$KNOWLEDGE_SERVICE_KEY" \
  -e REMOTE_INSTANCE_ID=default \
  -e REMOTE_INSTANCE_NAME=default \
  -e REMOTE_INSTANCE_URL="http://memory-core:8420" \
  -e REMOTE_INSTANCE_KEY="$MEMORY_CORE_GATEWAY_API_KEY" \
  -e REMOTE_INSTANCE_PROXY_URL="$MEMORY_HUB_PROXY_PUBLIC_URL" \
  -e LLM_MODE=custom \
  -e LLM_PROTOCOL="${MEMORY_LLM_PROTOCOL:-openai}" \
  -e LLM_API_KEY="$MEMORY_LLM_API_KEY" \
  -e LLM_BASE_URL="$MEMORY_LLM_BASE_URL" \
  -e LLM_MODEL="$MEMORY_LLM_MODEL" \
  -e KNOWLEDGE_LLM_BINDING_SYNC=0 \
  "$MEMORY_HUB_IMAGE" >/dev/null

wait_healthy "$CONTAINER" 120
ok "memory-hub 已启动"
ok "  Panel UI  → http://localhost:${PANEL_PORT}/"
ok "  KS Health → http://localhost:${KNOWLEDGE_PORT}/health"
