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
#
# 可选：
#   PROXY_VOLUME           : proxy sqlite store 的 named volume（默认 tdai-proxy-data）。
#                            不挂 volume 时 store 落在容器可写层，重建容器即清空所有
#                            session / binding / 限流桶 / 对话缓冲。
#   PROXY_ALLOW_LLM_WRITE  : =1 时把 skillRuntime.allowLlmWrite 渲染成 true（默认 0）。
#                            镜像与代码里都没有这个 env（开关本来是 YAML-only：
#                            MemoryProxy/src/config.ts:138 / :484-486），这里只是本脚本的
#                            .env → YAML 糖，方便和上面三个能力开关用同一套习惯。

set -euo pipefail
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

# proxy sqlite store 持久化（session/binding/限流桶/对话缓冲都在这个库里）。
# 不挂 volume 时数据在容器可写层，而本脚本每次都会 rm + run（见上方
# rm_container_if_exists），容器一重建 session 全部消失——bridge 调用随即
# 40101。named volume 与 memory-core / memory-hub 同一套习惯
# （start-memory-core.sh:208、start-memory-hub.sh:98）。
# 不覆盖 PROXY_DB_PATH：镜像已把它指向 /data/tdai-memory-proxy/proxy.db
# （MemoryProxy/Dockerfile:93，目录 Dockerfile:84），mount 同一目录即代码与挂载点天然一致。
PROXY_VOLUME="${PROXY_VOLUME:-tdai-proxy-data}"

# skill 写权限开关（YAML-only: MemoryProxy/src/config.ts:138 skillRuntime.allowLlmWrite，
# 执行点 skill-bridge.ts:533-542 → 40302）。这里只是 .env→YAML 糖，默认 0=只读。
PROXY_ALLOW_LLM_WRITE="${PROXY_ALLOW_LLM_WRITE:-0}"

# sessionInit 依赖 auth 拿 user_id；开 sessionInit 时自动补 auth
if [[ "$PROXY_ENABLE_SESSION_INIT" == "1" && "$PROXY_ENABLE_AUTH" != "1" ]]; then
  warn "PROXY_ENABLE_SESSION_INIT=1 需要 auth；自动打开 PROXY_ENABLE_AUTH"
  PROXY_ENABLE_AUTH=1
fi

bool() { [[ "$1" == "1" ]] && echo "true" || echo "false"; }

info "生成 proxy config → $CONFIG_FILE  (auth=$(bool $PROXY_ENABLE_AUTH) session-init=$(bool $PROXY_ENABLE_SESSION_INIT) tdai=$(bool $PROXY_ENABLE_TDAI))"
cat > "$CONFIG_FILE" <<YAML
# 由 start-proxy.sh 自动生成 —— 每次启动覆盖，请不要手动改。
server:
  host: 0.0.0.0
  port: 8096
  forwardTimeoutMs: 600000

upstream:
  url: "${PROXY_UPSTREAM_URL}"
  apiKey: "${PROXY_UPSTREAM_API_KEY}"

log:
  file: ""
  level: info
  backend: console

# tdai 内核对接（用于 injection / skill / auth 拉取）
tdai:
  enabled: $(bool $PROXY_ENABLE_TDAI)
  endpoint: "http://memory-core:8420"
  apiKey: "${MEMORY_CORE_GATEWAY_API_KEY}"
  serviceId: default
  memory:
    enabled: true
    inject: true
    writeL0: true
    recallL1: true
    injectL2L3: true

skill:
  endpoint: "http://memory-core:8420"
  serviceToken: "${MEMORY_CORE_GATEWAY_API_KEY}"

# knowledge 注入器的注册门槛（shouldRegisterKnowledgeInjector）：
# injectors 含 knowledge + knowledge.enabled + knowledge.serviceToken 三者同时满足。
# 缺了这一段时注入器静默不注册，<knowledge_tools> 永远不会出现。
knowledge:
  enabled: $(bool $PROXY_ENABLE_TDAI)
  endpoint: "http://memory-core:8420"
  serviceToken: "${MEMORY_CORE_GATEWAY_API_KEY}"
  serviceId: default

auth:
  enabled: $(bool $PROXY_ENABLE_AUTH)
  url: "http://memory-core:8420"
  timeoutMs: 5000

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

costGuard:
  enabled: false

# 打开 skill + knowledge + tdai-memory 三个注入器；
# knowledge 依赖 memory-hub 起来，否则 hook 内部会降级为空块。
injection:
  enabled: true
  injectors:
    - skill
    - knowledge
    - tdai-memory

redis:
  enabled: false

# skill-bridge 写子路径（create/update/delete）默认 40302 拒绝；
# PROXY_ALLOW_LLM_WRITE=1 才放行（安全含义见 agents/openhands/README.md §7）。
skillRuntime:
  allowLlmWrite: $(bool $PROXY_ALLOW_LLM_WRITE)
YAML

info "启动 proxy (image=$PROXY_IMAGE, port=$PROXY_PORT, volume=$PROXY_VOLUME, llm-write=$(bool $PROXY_ALLOW_LLM_WRITE))"
$DOCKER run -d --name "$CONTAINER" \
  --network "$NETWORK" \
  --network-alias proxy \
  --add-host=host.docker.internal:host-gateway \
  -p "${PROXY_PORT}:8096" \
  -v "$CONFIG_FILE:/data/config.yaml:ro" \
  -v "${PROXY_VOLUME}:/data/tdai-memory-proxy" \
  "$PROXY_IMAGE" >/dev/null

wait_healthy "$CONTAINER" 90
ok "proxy 已启动 → http://localhost:${PROXY_PORT}/"
ok "  用法：把 coding agent 的 API base 指向 http://localhost:${PROXY_PORT}"
