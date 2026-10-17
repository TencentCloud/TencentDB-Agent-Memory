#!/usr/bin/env bash
# 一键拉起 memory → memory-hub → proxy 三件套（交互式）。
#
# 顺序：先起 memory（内核），等 healthy；再起 memory-hub（面板+知识），等 healthy；
# 最后起 proxy。任意一步失败会中止并打印容器日志。
#
# 用法：
#   ./start-all.sh            # 交互式引导填写 LLM（回车保留当前值），自动检查通路，通过后一键起
#   PULL=1 ./start-all.sh     # 先 docker pull 三个镜像，升级到最新 latest
#
# 交互式说明：
#   - .env 不存在时自动从 .env.example 复制一份
#   - 每次运行都会交互式确认 memory 组 + proxy 组 LLM（已有值作为默认，回车保留）
#   - 填完立即检查 LLM 通路，不通会提示重新输入，直到通过或主动放弃
#   - 最终把填写的值写回 .env 持久化，下次启动默认复用

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# .env 不存在时从模板复制（交互式流程会引导填写 LLM）
if [[ ! -f "$ENV_FILE" ]]; then
  info ".env 不存在，从 .env.example 复制一份"
  cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
fi

load_env

# 交互式确认 LLM 两组配置 + 通路检查 + 写回 .env
interactive_llm_setup

# 一次性校验全部必填参数，避免拉起 memory 之后才发现 proxy 参数缺
require_vars \
  MEMORY_CORE_IMAGE MEMORY_HUB_IMAGE PROXY_IMAGE \
  MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT PROXY_PORT \
  MEMORY_CORE_VOLUME PANEL_VOLUME \
  MEMORY_LLM_BASE_URL MEMORY_LLM_API_KEY MEMORY_LLM_MODEL \
  KNOWLEDGE_PUBLIC_BASE_URL \
  PROXY_UPSTREAM_URL PROXY_UPSTREAM_API_KEY PROXY_UPSTREAM_MODEL

# 端口预检：一次性检查 4 个目标端口，被外部进程占用则报错退出，
# 避免拉起 memory 之后才发现 hub/proxy 端口冲突。（会排除 tdai 自己旧容器）
check_ports

info "═══ Step 1/3: memory ═══════════════════════════════════════"
"$SCRIPT_DIR/start-memory-core.sh"

info "═══ Step 2/3: memory-hub ═══════════════════════════════════"
"$SCRIPT_DIR/start-memory-hub.sh"

info "═══ Step 3/3: proxy ════════════════════════════════════════"
# 默认打开完整流水线（auth + sessionInit + tdai 注入）。
# 用户可用 PROXY_FULL_STACK=0 关闭；也可在 .env 分别覆盖三个开关。
PROXY_FULL_STACK="${PROXY_FULL_STACK:-1}" "$SCRIPT_DIR/start-proxy.sh"

ok "═══ 全部服务已就绪 ═════════════════════════════════════════"
print_endpoints

# 打印 Claude Code / proxy 使用命令
ADMIN_KEY_FILE="${MEMORY_CORE_ADMIN_KEY_FILE:-$SCRIPT_DIR/.admin-key}"
if [[ -s "$ADMIN_KEY_FILE" ]]; then
  ADMIN_KEY=$(cat "$ADMIN_KEY_FILE")
  UPSTREAM_MODEL="${PROXY_UPSTREAM_MODEL:-<your-model>}"
  echo ""
  echo "  ┌─ 通过 proxy 用 Claude Code ─────────────────────────────────────┐"
  echo "  │  export ANTHROPIC_BASE_URL=http://127.0.0.1:${PROXY_PORT}/claude-code/default"
  echo "  │  export ANTHROPIC_AUTH_TOKEN='${ADMIN_KEY}'"
  echo "  │  claude --model ${UPSTREAM_MODEL}"
  echo "  │"
  echo "  │  admin user_key 保存在: $ADMIN_KEY_FILE"
  echo "  └────────────────────────────────────────────────────────────────┘"
fi
echo ""
echo "  查看日志：  docker logs -f tdai-memory-core | tdai-memory-hub | tdai-proxy"
echo "  停止服务：  ./stop-all.sh"
echo ""
