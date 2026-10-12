#!/usr/bin/env bash
# 单独拉起 memory-core（内核 gateway，端口 8420），首次启动自动 init-admin +
# 把生成的 user_key 持久化到 .admin-key 供 proxy / claude-code 使用。
#
# 用法：
#   ./start-memory-core.sh
#
# 数据持久化到 named volume（默认 tdai-memory-core-data，可在 .env 改 MEMORY_CORE_VOLUME）。
# 重复执行会先移除旧容器再启新的，volume 数据保留 —— admin user_key 也随之保留。

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

load_env
require_vars MEMORY_CORE_IMAGE MEMORY_CORE_PORT MEMORY_CORE_VOLUME

# ── Gateway 内部管理凭据 ─────────────────────────────────────────
# 用 ${VAR-default}（不是 :-default）：允许 .env 里显式设为空字符串来关闭 Bearer gate。
#
# 当前 memory-core 的 Bearer gate 与 proxy auth 存在**已知不兼容**：proxy 调
# /v3/meta/auth/verify 时不带 Bearer（源码遗漏，见 MemoryProxy/src/auth.ts），
# 所以 proxy 启用 auth 时必须把 MEMORY_CORE_GATEWAY_API_KEY 留空。默认已置空。
MEMORY_CORE_GATEWAY_API_KEY="${MEMORY_CORE_GATEWAY_API_KEY-}"
MEMORY_CORE_ADMIN_USERNAME="${MEMORY_CORE_ADMIN_USERNAME:-admin}"

# admin user_key 持久化位置（宿主机侧；volume 数据被清后需一并删掉此文件）
ADMIN_KEY_FILE="${MEMORY_CORE_ADMIN_KEY_FILE:-$SCRIPT_DIR/.admin-key}"

if [[ -n "$MEMORY_CORE_GATEWAY_API_KEY" ]]; then
  warn "MEMORY_CORE_GATEWAY_API_KEY 非空 —— proxy 的 sessionInit/auth 目前会因缺 Bearer 而失败。"
  warn "本地体验请把 .env 里的 MEMORY_CORE_GATEWAY_API_KEY 留空。"
fi

CONTAINER=tdai-memory-core
NETWORK=tdai-memory-stack

# 创建共享网络（幂等）
if ! $DOCKER network inspect "$NETWORK" >/dev/null 2>&1; then
  info "创建 docker 网络 $NETWORK"
  $DOCKER network create "$NETWORK" >/dev/null
fi

# ── 存储后端：sqlite（默认）/ mongodb ─────────────────────────────────────
# MEMORY_CORE_STORE_MODE=mongodb 时数据面走 MongoDB（L0/L1/profile/skill +
# mongot 原生 BM25）。要求目标 Mongo 7.0+ 且带 mongot —— core 首次建连会拨测，
# 无 mongot 直接 init 报错（FTS 是刚需，不静默降级）。
#   MONGODB_ENDPOINT 已设   → 用外部 Mongo（Atlas 或自建带 mongot 的副本集）
#   MONGODB_ENDPOINT 未设   → 自动在同网络起一个 mongodb-atlas-local 容器
#                             （mongod + mongot 一体，数据卷 mongo-local-* 持久化）
#
# 元数据后端（meta_* 团队/用户/agent/task/ACL）：
#   MEMORY_CORE_METADATA_BACKEND=auto（默认，跟随 STORE_MODE）/ sqlite / mongodb
#   mongodb 时默认复用同一个 Mongo（TDAI_METADATA_MONGO_URI 可另行覆盖）；
#   元数据用多文档事务，目标必须是副本集（atlas-local 单节点 RS 满足）。
MEMORY_CORE_STORE_MODE="${MEMORY_CORE_STORE_MODE:-sqlite}"
MEMORY_CORE_METADATA_BACKEND="${MEMORY_CORE_METADATA_BACKEND:-auto}"
MONGODB_DATABASE="${MONGODB_DATABASE:-tdai_memory}"
MONGO_LOCAL_CONTAINER="${MONGO_LOCAL_CONTAINER:-tdai-mongo-local}"
MONGO_LOCAL_IMAGE="${MONGO_LOCAL_IMAGE:-mongodb/mongodb-atlas-local:8.3}"
MONGO_ENV_ARGS=()

if [[ "$MEMORY_CORE_METADATA_BACKEND" == "auto" ]]; then
  if [[ "$MEMORY_CORE_STORE_MODE" == "mongodb" ]]; then
    MEMORY_CORE_METADATA_BACKEND="mongodb"
  else
    MEMORY_CORE_METADATA_BACKEND="sqlite"
  fi
fi

if [[ "$MEMORY_CORE_STORE_MODE" == "mongodb" || "$MEMORY_CORE_METADATA_BACKEND" == "mongodb" ]]; then
  if [[ -z "${MONGODB_ENDPOINT:-}" ]]; then
    info "未设 MONGODB_ENDPOINT → 启动本地 atlas-local（$MONGO_LOCAL_IMAGE）"
    if ! $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "$MONGO_LOCAL_CONTAINER"; then
      rm_container_if_exists "$MONGO_LOCAL_CONTAINER"
      # --hostname 必须固定：atlas-local 用容器主机名初始化单节点 RS 成员。
      # 不固定时容器重建 → 主机名变化 → RS 配置里的旧成员名失配 → 永远无 primary
      # （not primary / ReplicaSetNoPrimary），只能清卷重来。
      $DOCKER run -d --name "$MONGO_LOCAL_CONTAINER" \
        --hostname mongo-search \
        --network "$NETWORK" \
        --network-alias mongo-search \
        -v mongo-local-db:/data/db \
        -v mongo-local-configdb:/data/configdb \
        -v mongo-local-mongot:/data/mongot \
        "$MONGO_LOCAL_IMAGE" >/dev/null
    fi
    info "等待 mongo 就绪..."
    mongo_ready=0
    for _ in $(seq 1 30); do
      # ping 在 RS 无 primary 时也会成功 —— 必须等到 isWritablePrimary，
      # 否则 core 会在 RS 选举完成前启动，启动期 ensureIndex/事务全部报错。
      if $DOCKER exec "$MONGO_LOCAL_CONTAINER" mongosh --quiet --eval \
          'if (db.adminCommand("hello").isWritablePrimary === true) quit(0); else quit(1)' >/dev/null 2>&1; then
        mongo_ready=1; break
      fi
      sleep 2
    done
    [[ "$mongo_ready" == "1" ]] || die "mongo 容器 60s 内未就绪，docker logs $MONGO_LOCAL_CONTAINER 排查"
    ok "mongo 就绪（容器 $MONGO_LOCAL_CONTAINER，网络内别名 mongo-search）"
    MONGODB_ENDPOINT="mongodb://mongo-search:27017/?directConnection=true"
  fi
fi

if [[ "$MEMORY_CORE_STORE_MODE" == "mongodb" ]]; then
  MONGO_ENV_ARGS+=( -e "MONGODB_ENDPOINT=$MONGODB_ENDPOINT" -e "MONGODB_DATABASE=$MONGODB_DATABASE" )
  info "memory-core 数据面后端 = mongodb（endpoint=$MONGODB_ENDPOINT, db=$MONGODB_DATABASE）"
fi

if [[ "$MEMORY_CORE_METADATA_BACKEND" == "mongodb" ]]; then
  # 元数据默认与数据面共用同一 Mongo 实例（不同库：{prefix}_{instance_id}，默认前缀 tdai_metadata）。
  # 注意：元数据 client 自建、不经共享连接池，且不继承数据面的 w:1（事务持久性依赖服务端默认 majority）。
  TDAI_METADATA_MONGO_URI="${TDAI_METADATA_MONGO_URI:-$MONGODB_ENDPOINT}"
  MONGO_ENV_ARGS+=( -e "TDAI_METADATA_MONGO_URI=$TDAI_METADATA_MONGO_URI" )
  info "memory-core 元数据后端 = mongodb（uri=$TDAI_METADATA_MONGO_URI, 库名 tdai_metadata_<instance>）"
else
  info "memory-core 元数据后端 = sqlite（容器 volume 内）"
fi

pull_image "$MEMORY_CORE_IMAGE"
rm_container_if_exists "$CONTAINER"

# ── 生成 gateway config.yaml，挂到容器 /data/config/tdai-gateway.yaml ──
# 默认镜像里没 config，memory-core 走编译时的默认（skill / knowledge 模块关闭）。
# 从 .env 里的 MEMORY_LLM_* 生成一份 standalone+skill 的最小配置。
CORE_CONFIG_DIR="${MEMORY_CORE_CONFIG_DIR:-$SCRIPT_DIR/.memory-core-config}"
mkdir -p "$CORE_CONFIG_DIR"
CORE_CONFIG_FILE="$CORE_CONFIG_DIR/tdai-gateway.yaml"
info "生成 gateway config → $CORE_CONFIG_FILE"
cat > "$CORE_CONFIG_FILE" <<YAML
# 由 start-memory-core.sh 自动生成 —— 每次启动覆盖，请不要手动改。
deployMode: standalone
stateBackend: local

server:
  port: 8420
  host: 0.0.0.0

data:
  baseDir: /data/tdai-memory

llm:
  baseUrl: "${MEMORY_LLM_BASE_URL:-}"
  apiKey: "${MEMORY_LLM_API_KEY:-}"
  model: "${MEMORY_LLM_MODEL:-}"
  maxTokens: 32000
  timeoutMs: 300000

memory:
  # promptMode: code（默认，代码工程场景，抽取项目事实/任务/决策/SOP/禁忌等团队共享记忆）
  #           | chat（通用聊天/教学场景，抽取 persona/episodic/instruction 个人记忆）
  # 通过 .env 里 MEMORY_PROMPT_MODE 覆盖。
  # 注意：code 模式下，纯闲聊对话可能抽出 0 条记忆（LLM 认为没有可沉淀的工程内容）。
  promptMode: ${MEMORY_PROMPT_MODE:-code}
  capture: { enabled: true }
  extraction:
    enabled: true
    enableDedup: true
    maxMemoriesPerSession: 20
  persona:
    triggerEveryN: 50
    maxScenes: 15
  pipeline:
    everyNConversations: 5
    enableWarmup: true
    l1IdleTimeoutSeconds: 600
    l2DelayAfterL1Seconds: 90
    l2MinIntervalSeconds: 900
    l2MaxIntervalSeconds: 3600
  recall:
    enabled: true
    maxResults: 5
    scoreThreshold: 0.3
    strategy: hybrid
    timeoutMs: 5000
  # gateway 形态下存储后端实际由 STORE_MODE 环境变量决定（见 docker run -e STORE_MODE），
  # 此处保持同值仅为可读性；插件/SDK 形态才读这个字段。
  storeBackend: ${MEMORY_CORE_STORE_MODE}
  embedding:
    provider: none

# ── Skill 模块 ──
skill:
  enabled: true
  routing:
    mode: bm25
    searchTopK: 20
  extraction:
    enabled: true
    maxIterations: 16
    queue:
      backend: local
      keyPrefix: tdai
      resultTtlSeconds: 86400
      lockTtlMs: 600000
      maxRetries: 2
      retryBackoffsMs: [5000, 15000]
  resources:
    maxResourceSizeBytes: 5000000
YAML

info "启动 memory-core (image=$MEMORY_CORE_IMAGE, port=$MEMORY_CORE_PORT)"
$DOCKER run -d --name "$CONTAINER" \
  --network "$NETWORK" \
  --network-alias memory-core \
  -p "${MEMORY_CORE_PORT}:8420" \
  -v "${MEMORY_CORE_VOLUME}:/data/tdai-memory" \
  -v "$CORE_CONFIG_FILE:/data/config/tdai-gateway.yaml:ro" \
  -e TDAI_GATEWAY_PORT=8420 \
  -e TDAI_GATEWAY_HOST=0.0.0.0 \
  -e TDAI_GATEWAY_API_KEY="$MEMORY_CORE_GATEWAY_API_KEY" \
  -e TDAI_DATA_DIR=/data/tdai-memory \
  -e STORE_MODE="$MEMORY_CORE_STORE_MODE" \
  ${MONGO_ENV_ARGS[@]+"${MONGO_ENV_ARGS[@]}"} \
  "$MEMORY_CORE_IMAGE" >/dev/null

wait_healthy "$CONTAINER" 90
ok "memory-core 已启动 → http://localhost:${MEMORY_CORE_PORT}/"

# ── Admin user 生命周期 ─────────────────────────────────────────
# 首次启动：init-admin 时**传入我们生成的随机 user_key**，返回体里读回来存文件。
# 重启且已初始化（409）：优先读 .admin-key；若 volume 是新造的但 .admin-key 是
#   旧的，无法恢复（volume/key 必须同步；提示用户清理）。
#
# init-admin 接口尊重传入的 user_key（见 MemoryCore/src/metadata/store/sqlite-adapter.ts
# defaultKeyValue = input.default_key_value ?? generateUserKey()）；只要 volume 空、
# 我们传固定 key，就能拿到自己指定的 key。首次启动时脚本生成一把 32 字节随机
# base32url —— 每台机器/每次 purge 都是独立 key，不会撞车。

generate_user_key() {
  # sk-mem-<32 chars A-Za-z0-9>，与 metadata/utils/user-key.ts 的格式一致
  # 用 openssl（可移植；tr 过滤 base64 里的 +/= 到 32 位）
  local raw
  if command -v openssl >/dev/null 2>&1; then
    raw=$(openssl rand -base64 48 | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 32)
  else
    # 兜底：读足够多的 urandom 保证过滤后 >=32
    raw=$(head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 32)
  fi
  echo "sk-mem-${raw}"
}

verify_user_key() {
  local key="$1"
  local code
  code=$("$CURL" -sS -o /dev/null -w "%{http_code}" --max-time 5 \
    -X POST -H "Content-Type: application/json" \
    -H "x-tdai-service-id: default" \
    ${MEMORY_CORE_GATEWAY_API_KEY:+-H "Authorization: Bearer ${MEMORY_CORE_GATEWAY_API_KEY}"} \
    "http://127.0.0.1:${MEMORY_CORE_PORT}/v3/meta/auth/verify" \
    -d "$(printf '{"user_key":"%s"}' "$key")" 2>/dev/null || echo "000")
  [[ "$code" == "200" ]]
}

info "初始化 admin user（username=${MEMORY_CORE_ADMIN_USERNAME}, key 持久化 → ${ADMIN_KEY_FILE}）..."

# 生成随机 key（首次 init-admin 用；若之前有 file 就复用）
if [[ -s "$ADMIN_KEY_FILE" ]]; then
  ADMIN_KEY=$(cat "$ADMIN_KEY_FILE")
  info "  复用已保存的 admin key（.admin-key 已存在）"
else
  ADMIN_KEY=$(generate_user_key)
fi

init_body=$(printf '{"username":"%s","user_key":"%s"}' \
  "$MEMORY_CORE_ADMIN_USERNAME" "$ADMIN_KEY")
init_resp=$("$CURL" -sS -o /tmp/init-admin.$$ -w "%{http_code}" \
  -X POST -H "Content-Type: application/json" \
  ${MEMORY_CORE_GATEWAY_API_KEY:+-H "Authorization: Bearer ${MEMORY_CORE_GATEWAY_API_KEY}"} \
  -H "x-tdai-service-id: default" \
  "http://127.0.0.1:${MEMORY_CORE_PORT}/v3/internal/meta/user/init-admin" \
  -d "$init_body" 2>/dev/null || echo "000")

case "$init_resp" in
  200)
    ok "admin user 已创建"
    # 落盘 key（把宿主机 file 的权限收紧）
    umask 077
    echo -n "$ADMIN_KEY" > "$ADMIN_KEY_FILE"
    ok "  admin user_key 已保存到 $ADMIN_KEY_FILE"
    ;;
  409)
    if [[ -s "$ADMIN_KEY_FILE" ]]; then
      ok "admin user 已存在（跳过 init-admin，用 $ADMIN_KEY_FILE 里的 key）"
    else
      warn "admin user 已存在，但 $ADMIN_KEY_FILE 缺失，无法恢复 user_key。"
      warn "选项 A: 清理 volume 重建 —— ./stop-all.sh --purge && ./start-memory-core.sh"
      warn "选项 B: 手动创建新 admin user_key（需要旧 key 或 gateway apiKey）"
    fi
    ;;
  *)
    warn "init-admin 返回 HTTP=${init_resp}，可能需要手动排查："
    cat /tmp/init-admin.$$ 2>/dev/null; echo
    ;;
esac
rm -f /tmp/init-admin.$$

# ── 校验 admin key 可用 ─────────────────────────────────────────
if [[ -s "$ADMIN_KEY_FILE" ]]; then
  ADMIN_KEY=$(cat "$ADMIN_KEY_FILE")
  if verify_user_key "$ADMIN_KEY"; then
    # 只在末尾做脱敏输出：整串路径 masked，让终端历史里不留全值
    masked="${ADMIN_KEY:0:11}****${ADMIN_KEY: -4}"
    ok "admin user_key 校验通过（auth/verify 200）—— $masked"
    ok "  key file: $ADMIN_KEY_FILE"
  else
    warn "admin user_key 校验失败（auth/verify 非 200）。检查 $ADMIN_KEY_FILE 与 volume 是否匹配。"
  fi
fi
