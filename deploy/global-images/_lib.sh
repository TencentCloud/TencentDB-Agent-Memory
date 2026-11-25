#!/usr/bin/env bash
# 通用工具函数：加载 .env、校验必填参数、等待容器 health、清理旧容器。
# 由 start-*.sh 通过 `source _lib.sh` 引入，不单独执行。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"

# Read the language setting early so even errors raised before load_env are
# localized. An exported value takes precedence over the value in .env.
_TDAI_OUTPUT_LANGUAGE_OVERRIDE="${TDAI_OUTPUT_LANGUAGE:-}"
if [[ -z "$_TDAI_OUTPUT_LANGUAGE_OVERRIDE" && -f "$ENV_FILE" ]]; then
  TDAI_OUTPUT_LANGUAGE="$(grep -E '^[[:space:]]*TDAI_OUTPUT_LANGUAGE=' "$ENV_FILE" \
    | tail -n1 | cut -d= -f2- | tr -d '[:space:]"' || true)"
fi
TDAI_OUTPUT_LANGUAGE="${TDAI_OUTPUT_LANGUAGE:-zh}"

tdai_translate() {
  local _tdai_message="$*" _tdai_from _tdai_to
  case "${TDAI_OUTPUT_LANGUAGE:-zh}" in
    en|EN) ;;
    *) printf '%s' "$_tdai_message"; return 0 ;;
  esac

  # Keep this as a Bash 3.2-compatible catalog for macOS users.
  while IFS='|' read -r _tdai_from _tdai_to; do
    [[ -n "$_tdai_from" ]] || continue
    _tdai_from="${_tdai_from//~/ }"
    _tdai_to="${_tdai_to//~/ }"
    _tdai_message="${_tdai_message//$_tdai_from/$_tdai_to}"
  done <<'TDAI_EN_MESSAGES'
.env 不存在。先 cp .env.example .env 并填入 LLM 参数。|.env not found. Copy .env.example to .env and enter the LLM settings.
.env 中以下必填参数未设置或仍为 REPLACE_ME：|The following required values in .env are missing or still set to REPLACE_ME:
找不到 docker 命令。请先安装 Docker Desktop / OrbStack / colima + docker CLI。|Docker was not found. Install Docker Desktop, OrbStack, or Colima with the Docker CLI.
.env 不存在，从 .env.example 复制一份|.env not found; copying .env.example
.env 不存在。执行：cp .env.example .env|.env not found. Run: cp .env.example .env
~.env 里显式设置了|~.env explicitly sets~
，与本脚本冲突。|, which conflicts with this script.
二选一：|Choose one:
想用 mongo：注释掉 .env 里该行，重跑本脚本；|To use MongoDB, comment out this line in .env and rerun this script;
想用~|To use~
：直接 ./start-all.sh。|: run ./start-all.sh.
①~|1)~
②~|2)~
已写入 MEMORY_CORE_STORE_MODE=mongodb 到 .env（数据面 + 元数据默认均落 MongoDB）|Set MEMORY_CORE_STORE_MODE=mongodb in .env (MongoDB is the default for both data and metadata).
编辑~|Edit~
~后重试。|~and try again.
proxy 组是否复用 memory 组的 LLM 配置？|Reuse the memory group's LLM settings for the proxy group?
交互式配置 LLM（回车 = 保留当前值）|Interactive LLM setup (press Enter to keep current values)
端口预检|Port preflight
存在端口冲突，请先释放端口后重试。|Port conflict detected; free the port and retry.
═══ 全部服务已就绪 ═════════════════════════════════════════|All services are ready
通过 proxy 用 Claude Code|Use Claude Code through the proxy
admin user_key 保存在:~|admin user_key saved in:~
查看日志：|View logs:
停止服务：|Stop services:
服务地址|Service endpoints
停止并移除~|Stopping and removing~
未运行，跳过|is not running; skipping
--purge 已启用：删除 volume + 网络 + admin key 文件|--purge enabled: removing volumes, network, and admin key file
已删除 volume~|Removed volume~
删除 volume~|remove volume~
已删除网络~|Removed network~
已删除 admin key 文件~|Removed admin key file~
已删除 proxy config 目录~|Removed proxy config directory~
已删除 memory-core config 目录~|Removed memory-core config directory~
完成。|Done.
拉取镜像~|Pulling image~
拉取~|Pulling~
移除已存在的容器~|Removing existing container~
等待~|Waiting for~
~就绪（最长~|~to be ready (timeout:~
s）...|s)...
~状态~|~is in state~
，输出最近日志：|; recent logs:
~未运行。|~is not running.
unhealthy，日志：|~is unhealthy; logs:
~健康检查失败。|~health check failed.
~running（无 healthcheck）|~running (no health check)
~等待超时，最后日志：|~timed out; last logs:
~在~|~was not ready within~
s 内未就绪。|s.
OpenAI 协议通路 OK|OpenAI connection check passed
~在 /models 列表内|~is listed in /models
未在 /models 里显式列出~|is not explicitly listed in /models:~
，业务侧仍可能可用|; requests may still work
Anthropic 协议通路 OK|Anthropic connection check passed
模型~|model~
~已应答|~responded
API key 无效|API key is invalid
GET /models 404 —— 该厂商可能没有该端点，改用 anthropic 协议检查|GET /models returned 404; this provider may not support the endpoint, retrying with the Anthropic protocol
无法访问~|Cannot reach~
URL 不存在|URL not found
检查 BASE_URL|check BASE_URL
模型名~|Model name~
~无效|~is invalid
HTTP 400（可能是参数格式问题，非通路错）：|HTTP 400 (possibly a request format issue, not a connection issue):~
通路（协议=|~connectivity (protocol=
协议=|protocol=
未知协议~|Unknown protocol~
，回退到 openai|; falling back to openai
LLM 协议|LLM protocol
是否重新输入？|Re-enter the values?
memory 组 LLM 通路检查未通过。|LLM connectivity check failed for the memory group.
proxy 组 LLM 通路检查未通过。|LLM connectivity check failed for the proxy group.
用户放弃，退出。|Cancelled by user. Exiting.
proxy 组复用 memory 组配置，跳过重复检查|Reusing the memory group settings for the proxy; skipping the duplicate check
写回 LLM 配置 →~|Saving LLM settings to~
LLM 配置已保存到~|LLM settings saved to~
端口~|Port~
~由 tdai 旧容器占用（启动时会重建），跳过|~is used by an existing tdai container and will be recreated at startup; skipping
~已被占用，请释放该端口或在 .env 改端口。|~is already in use; free it or change the port in .env.
~空闲|~is available
已生成 KNOWLEDGE_SERVICE_KEY 并写回~|Generated KNOWLEDGE_SERVICE_KEY and saved it to~
（Panel 与 Knowledge 共用）|(shared by Panel and Knowledge)
MEMORY_CORE_GATEWAY_API_KEY 非空 —— proxy 的 sessionInit/auth 目前会因缺 Bearer 而失败。|MEMORY_CORE_GATEWAY_API_KEY is non-empty; proxy sessionInit/auth currently fails because the Bearer token is missing.
本地体验请把 .env 里的 MEMORY_CORE_GATEWAY_API_KEY 留空。|For local use, leave MEMORY_CORE_GATEWAY_API_KEY empty in .env.
创建 docker 网络~|Creating Docker network~
未设 MONGODB_ENDPOINT → 启动本地 atlas-local|MONGODB_ENDPOINT is not set; starting local atlas-local
等待 mongo 就绪...|Waiting for MongoDB to be ready...
mongo 容器 60s 内未就绪，docker logs~|MongoDB did not become ready within 60s; inspect with docker logs~
mongo 就绪|MongoDB is ready
容器~|container~
网络内别名 mongo-search|, network alias mongo-search
memory-core 数据面后端 = mongodb|memory-core data backend = mongodb
memory-core 元数据后端 = mongodb|memory-core metadata backend = mongodb
memory-core 元数据后端 = sqlite|memory-core metadata backend = sqlite
库名 tdai_metadata_<instance>|database tdai_metadata_<instance>
容器 volume 内|inside the container volume
仅支持 current 或 jev|only supports current or jev
生成 gateway config →~|Generating gateway config →~
memory-core 已启动|memory-core started
初始化 admin user|Initializing admin user
复用已保存的 admin key（.admin-key 已存在）|Reusing the saved admin key (.admin-key exists)
admin user 已创建|admin user created
admin user_key 已保存到~|admin user_key saved to~
admin user 已存在（跳过 init-admin，用~|admin user already exists (skipping init-admin; using~
admin user 已存在，但~|admin user already exists, but~
缺失，无法恢复 user_key。|~is missing; cannot recover the user_key.
选项 A: 清理 volume 重建 ——~|Option A: remove the volume and recreate it --~
选项 B: 手动创建新 admin user_key（需要旧 key 或 gateway apiKey）|Option B: manually create a new admin user_key (requires the old key or gateway apiKey)
init-admin 返回 HTTP=|init-admin returned HTTP=
，可能需要手动排查：|; manual investigation may be needed:
校验通过（auth/verify 200）|validated (auth/verify 200)
校验失败（auth/verify 非 200）。检查~|validation failed (auth/verify was not 200). Check~
~与 volume 是否匹配。|~and verify it matches the volume.
自动探测宿主机地址:~|Auto-detected host address:~
如需覆盖，在 .env 里显式设~|To override, set this in .env:~
容器未运行。memory-hub 能启动，但 knowledge 调 memory 时会失败。|container is not running. memory-hub can start, but Knowledge requests to memory will fail.
建议先~|Start with~
再来这里，或直接~|~first, or run~
memory-hub 已启动|memory-hub started
memory-core 容器未运行，proxy 的 auth / tdai memory / skill 注入将全部降级。|memory-core is not running; proxy auth, tdai memory, and skill injection will be degraded.
memory-core 容器未运行。memory-hub 能启动，但 knowledge 调 memory 时会失败。|memory-core is not running. memory-hub can start, but Knowledge requests to memory will fail.
memory-hub 容器未运行，proxy 的 sessionInit control plane 不可达。|memory-hub is not running; the proxy sessionInit control plane is unreachable.
需要 auth；自动打开|~requires auth; enabling
生成 proxy config|Generating proxy config
proxy 已启动|proxy started
用法：把 coding agent 的 API base 指向|Usage: set the coding agent API base to
未知参数:~|Unknown argument:~
（忽略）|~(ignored)
从容器~|from container~
~内部再打一次~|; checking again inside the container:~
容器~|Container~
无法访问~|~cannot reach~
（网络隔离 / DNS 失败）|(network isolation or DNS failure)
网络可达|network is reachable
docker 可用:~|Docker is available:~
docker 不可用|Docker is unavailable
所有必填参数已填写|All required values are set
以下必填参数未设置：|The following required values are missing:
.env 存在|.env exists
镜像本地已存在:~|Image is available locally:~
镜像本地不存在，启动时会 pull:~|Image is not available locally; it will be pulled at startup:~
跳过 LLM 通路检查（--skip-llm）|Skipping LLM connectivity checks (--skip-llm)
跳过 LLM 通路检查（必填参数未填齐）|Skipping LLM connectivity checks (required values are missing)
LLM 通路检查|LLM connectivity checks
proxy 组 与 memory 组完全相同，跳过重复检查|Proxy and memory group settings are identical; skipping the duplicate check
~个错误|~errors
~个警告 —— 可以启动，但请注意上面的提示|~warnings -- can start, but review the messages above
~—— 无法启动|~-- cannot start
✓ 全部检查通过 —— 可以直接 ./start-all.sh|✓ All checks passed -- run ./start-all.sh
memory 组|memory group
proxy 组|proxy group
key 持久化 →~|key is persisted at →~
已被占用，启动前请释放或在 .env 改端口|is already in use; free it before startup or change it in .env
通路|~connectivity
检查~|Checking~
失败|failed
——|--
②~|2)~
①~|1)~
~——~|~--~
（|~(
）|)
：|:~
，|,~
。|.
；|;~
。|.
TDAI_EN_MESSAGES
  printf '%s' "$_tdai_message"
}

tdai_echo() { printf '%s\n' "$(tdai_translate "$*")"; }

# 颜色
if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YLW=$'\033[33m'; C_BLU=$'\033[34m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YLW=""; C_BLU=""; C_RST=""
fi

info() { echo "${C_BLU}[$(date +%H:%M:%S)]${C_RST} $(tdai_translate "$*")"; }
ok()   { echo "${C_GRN}[ok]${C_RST} $(tdai_translate "$*")"; }
warn() { echo "${C_YLW}[warn]${C_RST} $(tdai_translate "$*")" >&2; }
die()  { echo "${C_RED}[error]${C_RST} $(tdai_translate "$*")" >&2; exit 1; }

# 加载 .env（未创建时给指引）
load_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    die ".env 不存在。先 cp .env.example .env 并填入 LLM 参数。"
  fi
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  if [[ -n "$_TDAI_OUTPUT_LANGUAGE_OVERRIDE" ]]; then
    TDAI_OUTPUT_LANGUAGE="$_TDAI_OUTPUT_LANGUAGE_OVERRIDE"
  fi
}

# 校验一组必填变量；缺一个都不启动，一次性列出所有缺失项
require_vars() {
  local missing=()
  for var in "$@"; do
    local val="${!var:-}"
    if [[ -z "$val" || "$val" == "REPLACE_ME" ]]; then
      missing+=("$var")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    tdai_echo "${C_RED}[error]${C_RST} .env 中以下必填参数未设置或仍为 REPLACE_ME：" >&2
    for v in "${missing[@]}"; do echo "  - $v" >&2; done
    echo "" >&2
    tdai_echo "  编辑 $ENV_FILE 后重试。" >&2
    exit 1
  fi
}

# 找到可用 docker 命令（兼容 Homebrew 独立安装 + colima）
# 优先级：PATH 中的 docker → Homebrew apple silicon → Homebrew intel → /usr/local
# Homebrew Cellar 路径下按版本 glob，取最新（sort -V），避免硬编码具体小版本号。
find_docker() {
  if command -v docker >/dev/null 2>&1; then
    echo "docker"
    return
  fi
  local candidate
  for prefix in /opt/homebrew/Cellar/docker /usr/local/Cellar/docker; do
    if [[ -d "$prefix" ]]; then
      candidate=$(ls -1 "$prefix" 2>/dev/null | sort -V | tail -n1)
      if [[ -n "$candidate" && -x "$prefix/$candidate/bin/docker" ]]; then
        echo "$prefix/$candidate/bin/docker"
        return
      fi
    fi
  done
  for path in /opt/homebrew/bin/docker /usr/local/bin/docker; do
    if [[ -x "$path" ]]; then
      echo "$path"
      return
    fi
  done
  die "找不到 docker 命令。请先安装 Docker Desktop / OrbStack / colima + docker CLI。"
}

DOCKER="$(find_docker)"

# PULL=1 时拉取镜像最新版本。
# 默认关闭：docker run 在本地没有镜像时会自动拉，但本地已有同名 :latest 时会直接复用，
# 不会感知远端更新——想升级到最新 latest 就带 PULL=1。
pull_image() {
  local image="$1"
  [[ "${PULL:-0}" == "1" ]] || return 0
  info "拉取镜像 $image"
  $DOCKER pull "$image" || die "拉取 $image 失败。"
}

# 幂等移除同名容器
rm_container_if_exists() {
  local name="$1"
  if $DOCKER ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$name"; then
    info "移除已存在的容器 $name"
    $DOCKER rm -f "$name" >/dev/null
  fi
}

# 等待容器进入 healthy 状态（或没有 healthcheck 时等 running）
wait_healthy() {
  local name="$1"
  local timeout="${2:-90}"    # 秒
  local waited=0
  info "等待 $name 就绪（最长 ${timeout}s）..."
  while (( waited < timeout )); do
    local status health
    status="$($DOCKER inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo "missing")"
    health="$($DOCKER inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null || echo "unknown")"

    if [[ "$status" != "running" ]]; then
      warn "${name} 状态 ${status}，输出最近日志："
      $DOCKER logs --tail 30 "$name" 2>&1 || true
      die "${name} 未运行。"
    fi

    case "$health" in
      healthy) ok "$name healthy"; return 0 ;;
      unhealthy)
        warn "${name} unhealthy，日志："
        $DOCKER logs --tail 30 "$name" 2>&1 || true
        die "${name} 健康检查失败。"
        ;;
      none)
        # 镜像没有 healthcheck：容器 running 就当就绪
        ok "${name} running（无 healthcheck）"
        return 0
        ;;
    esac
    sleep 2
    waited=$((waited + 2))
  done
  warn "${name} 等待超时，最后日志："
  $DOCKER logs --tail 30 "$name" 2>&1 || true
  die "${name} 在 ${timeout}s 内未就绪。"
}

# 打印统一的服务地址表
print_endpoints() {
  echo ""
  tdai_echo "  ┌─────────────────────────────────────────────────────────┐"
  if [[ "${TDAI_OUTPUT_LANGUAGE:-zh}" == "en" || "${TDAI_OUTPUT_LANGUAGE:-zh}" == "EN" ]]; then
    printf '  │ %-56s│\n' "Service endpoints"
  else
    tdai_echo "  │ 服务地址                                                │"
  fi
  echo "  ├─────────────────────────────────────────────────────────┤"
  printf "  │ Panel UI       http://localhost:%-24s│\n" "${PANEL_PORT}/"
  printf "  │ Panel API      http://localhost:%-24s│\n" "${PANEL_PORT}/api/v1/"
  printf "  │ Knowledge API  http://localhost:%-24s│\n" "${KNOWLEDGE_PORT}/v3/"
  printf "  │ Knowledge Docs http://localhost:%-24s│\n" "${KNOWLEDGE_PORT}/docs"
  printf "  │ Memory Core     http://localhost:%-24s│\n" "${MEMORY_CORE_PORT}/"
  printf "  │ Proxy          http://localhost:%-24s│\n" "${PROXY_PORT}/"
  tdai_echo "  └─────────────────────────────────────────────────────────┘"
}

# ═══════════════════════════════════════════════════════════════
# LLM 通路检查（与 verify.sh 同源逻辑；供 start-all.sh 交互式流程复用）
# ═══════════════════════════════════════════════════════════════

CURL="${CURL:-/usr/bin/curl}"
if [[ ! -x "$CURL" ]]; then
  if command -v curl >/dev/null 2>&1; then
    CURL="$(command -v curl)"
  else
    CURL="curl"
  fi
fi

# check_llm_openai <label> <base_url> <api_key> <model>
#   OpenAI 兼容：GET {base}/models 只验证 auth+URL，不消耗 token。返回 0 通过 / 1 失败。
check_llm_openai() {
  local label="$1" base="$2" key="$3" model="$4"
  base="${base%/}"
  base="${base%/messages}"
  base="${base%/chat/completions}"
  local url="${base}/models"
  local code body_file=/tmp/llm-check.$$
  code=$("$CURL" -sS --max-time 10 -o "$body_file" -w "%{http_code}" \
    -H "Authorization: Bearer $key" "$url" 2>/dev/null || echo "000")
  local rc=0
  if [[ "$code" == "200" ]]; then
    if grep -q "\"$model\"" "$body_file" 2>/dev/null; then
      ok "$label OpenAI 协议通路 OK（$model 在 /models 列表内）"
    else
      ok "$label OpenAI 协议通路 OK（未在 /models 里显式列出 ${model}，业务侧仍可能可用）"
    fi
  elif [[ "$code" == "401" || "$code" == "403" ]]; then
    warn "$label API key 无效（HTTP ${code}）：$url"
    head -c 200 "$body_file" >&2; echo >&2
    rc=1
  elif [[ "$code" == "404" ]]; then
    warn "$label GET /models 404 —— 该厂商可能没有该端点，改用 anthropic 协议检查"
    rm -f "$body_file"
    check_llm_anthropic "$label" "$base" "$key" "$model"
    return $?
  else
    warn "$label 无法访问 ${url}（HTTP=${code}）$(head -c 100 "$body_file" 2>/dev/null)"
    rc=1
  fi
  rm -f "$body_file"
  return $rc
}

# check_llm_anthropic <label> <base_url> <api_key> <model>
#   Anthropic：POST {base}/v1/messages 发 max_tokens=1，消耗 ≤ 10 token。返回 0/1。
check_llm_anthropic() {
  local label="$1" base="$2" key="$3" model="$4"
  base="${base%/}"
  local url
  if [[ "$base" == */messages ]]; then
    url="$base"
  elif [[ "$base" == */v1 ]]; then
    url="${base}/messages"
  else
    url="${base}/v1/messages"
  fi
  local code body_file=/tmp/llm-check.$$
  code=$("$CURL" -sS --max-time 15 -o "$body_file" -w "%{http_code}" \
    -X POST -H "Content-Type: application/json" \
    -H "x-api-key: $key" -H "Authorization: Bearer $key" \
    -H "anthropic-version: 2023-06-01" \
    -d "{\"model\":\"$model\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" \
    "$url" 2>/dev/null || echo "000")
  local rc=0
  case "$code" in
    200) ok "$label Anthropic 协议通路 OK（模型 $model 已应答）" ;;
    401|403)
      warn "$label API key 无效（HTTP ${code}）：$url"
      head -c 200 "$body_file" >&2; echo >&2
      rc=1 ;;
    404)
      warn "$label URL 不存在（HTTP 404）：$url —— 检查 BASE_URL"
      rc=1 ;;
    400)
      if grep -qE "model.*not.*found|invalid.*model|model_not_found" "$body_file" 2>/dev/null; then
        warn "$label 模型名 '$model' 无效（HTTP 400）"
        rc=1
      else
        warn "$label HTTP 400（可能是参数格式问题，非通路错）：$(head -c 150 "$body_file")"
        rc=0
      fi ;;
    *)
      warn "$label 无法访问 ${url}（HTTP=${code}）$(head -c 100 "$body_file" 2>/dev/null)"
      rc=1 ;;
  esac
  rm -f "$body_file"
  return $rc
}

# check_llm_group <label> <base_url> <api_key> <model> <protocol>
check_llm_group() {
  local label="$1" base="$2" key="$3" model="$4" proto="${5:-openai}"
  info "检查 $label 通路（协议=${proto}）..."
  case "$proto" in
    anthropic) check_llm_anthropic "$label" "$base" "$key" "$model" ;;
    *)         check_llm_openai    "$label" "$base" "$key" "$model" ;;
  esac
}

# ═══════════════════════════════════════════════════════════════
# 交互式输入辅助
# ═══════════════════════════════════════════════════════════════

# prompt_with_default <label> <default>
#   打印 "label [default]: "，读一行；空输入返回 default。结果输出到 stdout。
prompt_with_default() {
  local label="$1" default="${2:-}"
  # 提示走 stderr，结果走 stdout（供 $(...) 捕获，避免把提示文本也捕获进来）
  if [[ -n "$default" ]]; then
    printf '%s [%s]: ' "$(tdai_translate "$label")" "$default" >&2
  else
    printf '%s: ' "$(tdai_translate "$label")" >&2
  fi
  local input
  IFS= read -r input || { printf '\n' >&2; printf '%s' "$default"; return 0; }
  if [[ -z "$input" ]]; then
    printf '%s' "$default"
  else
    printf '%s' "$input"
  fi
}

# prompt_protocol <default>
#   让用户确认 LLM 协议（openai/anthropic），非法输入回退 openai。
prompt_protocol() {
  local default="${1:-openai}"
  printf '%s [%s]: ' "$(tdai_translate 'memory 组 LLM 协议（openai/anthropic）')" "$default" >&2
  local input
  IFS= read -r input || { printf '\n' >&2; printf '%s' "$default"; return 0; }
  input="${input:-$default}"
  case "$input" in
    openai|anthropic) printf '%s' "$input" ;;
    *) warn "未知协议 '$input'，回退到 openai"; printf 'openai' ;;
  esac
}

# prompt_confirm <question> <default_yes:0|1>
#   返回 0=是 / 1=否
prompt_confirm() {
  local question="$1" default_yes="${2:-0}"
  local hint
  if [[ "$default_yes" == "1" ]]; then hint="[Y/n]"; else hint="[y/N]"; fi
  printf '%s %s: ' "$(tdai_translate "$question")" "$hint" >&2
  local input
  IFS= read -r input || return 1
  case "$input" in
    [yY]|[yY][eE][sS]) return 0 ;;
    [nN]|[nN][oO])     return 1 ;;
    "")                [[ "$default_yes" == "1" ]] && return 0 || return 1 ;;
    *)                 return 1 ;;
  esac
}

# set_env_value <key> <value> <file>
#   就地更新/追加 .env 里的 KEY=VALUE。用 awk 原样输出，避免 sed/perl 转义坑。
set_env_value() {
  local key="$1" value="$2" file="$3"
  if grep -qE "^[[:space:]]*${key}=" "$file"; then
    local tmp="$file.tmp.$$"
    awk -v k="$key" -v v="$value" '
      $0 ~ ("^[[:space:]]*" k "=") { print k "=" v; next }
      { print }
    ' "$file" > "$tmp" && mv "$tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

# ensure_knowledge_service_key
#   Knowledge 服务间鉴权 key（Panel ↔ Knowledge 共用）。
#   为空或占位符时自动生成随机值并回写 .env（幂等：已生成则复用，重启不漂移）。
#   调用方随后把同一个值分两次注入 memory-hub 容器：
#     KNOWLEDGE_SERVICE_KEY → Knowledge 进程校验侧
#     KNOWLEDGE_AUTH_TOKEN  → Panel 进程调用侧
ensure_knowledge_service_key() {
  if [[ -z "${KNOWLEDGE_SERVICE_KEY:-}" || "${KNOWLEDGE_SERVICE_KEY}" == "REPLACE_ME" ]]; then
    local rand
    if command -v openssl >/dev/null 2>&1; then
      rand="$(openssl rand -hex 24)"
    else
      rand="$(head -c 24 /dev/urandom | od -A n -t x1 | tr -d ' \n')"
    fi
    KNOWLEDGE_SERVICE_KEY="ks-svc-${rand}"
    set_env_value KNOWLEDGE_SERVICE_KEY "$KNOWLEDGE_SERVICE_KEY" "$ENV_FILE"
    info "已生成 KNOWLEDGE_SERVICE_KEY 并写回 ${ENV_FILE}（Panel 与 Knowledge 共用）"
  fi
}

# interactive_llm_setup
#   交互式引导填写 LLM 两组（memory + proxy）→ 通路检查（可重试）→ 写回 .env。
#   会更新内存中的 MEMORY_LLM_* / PROXY_UPSTREAM_* 变量（已 export），并写回 .env 持久化。
interactive_llm_setup() {
  local base key model proto reuse_same

  echo ""
  info "═══ 交互式配置 LLM（回车 = 保留当前值） ═══════════════════"

  # ── memory 组 ──
  while true; do
    base=$(prompt_with_default "memory 组 LLM BASE_URL" "${MEMORY_LLM_BASE_URL:-}")
    key=$(prompt_with_default "memory 组 LLM API_KEY" "${MEMORY_LLM_API_KEY:-}")
    model=$(prompt_with_default "memory 组 LLM MODEL" "${MEMORY_LLM_MODEL:-}")
    proto=$(prompt_protocol "${MEMORY_LLM_PROTOCOL:-openai}")

    if check_llm_group "memory 组" "$base" "$key" "$model" "$proto"; then
      MEMORY_LLM_BASE_URL="$base"
      MEMORY_LLM_API_KEY="$key"
      MEMORY_LLM_MODEL="$model"
      MEMORY_LLM_PROTOCOL="$proto"
      break
    fi
    warn "memory 组 LLM 通路检查未通过。"
    prompt_confirm "是否重新输入？" 1 || die "用户放弃，退出。"
  done

  # ── proxy 组 ──
  # 默认复用（回车即复用）的情况：
  #   1) .env 里 proxy 组与刚填的 memory 组完全相同；
  #   2) proxy 组仍为空 / REPLACE_ME（首次使用尚未配置，默认复用更顺手）。
  reuse_same=0
  if [[ "${PROXY_UPSTREAM_URL:-}" == "$MEMORY_LLM_BASE_URL" && \
        "${PROXY_UPSTREAM_API_KEY:-}" == "$MEMORY_LLM_API_KEY" && \
        "${PROXY_UPSTREAM_MODEL:-}" == "$MEMORY_LLM_MODEL" ]]; then
    reuse_same=1
  elif [[ -z "${PROXY_UPSTREAM_URL:-}" || "${PROXY_UPSTREAM_URL:-}" == "REPLACE_ME" ]] && \
       [[ -z "${PROXY_UPSTREAM_API_KEY:-}" || "${PROXY_UPSTREAM_API_KEY:-}" == "REPLACE_ME" ]] && \
       [[ -z "${PROXY_UPSTREAM_MODEL:-}" || "${PROXY_UPSTREAM_MODEL:-}" == "REPLACE_ME" ]]; then
    reuse_same=1
  fi

  if prompt_confirm "proxy 组是否复用 memory 组的 LLM 配置？" "$reuse_same"; then
    PROXY_UPSTREAM_URL="$MEMORY_LLM_BASE_URL"
    PROXY_UPSTREAM_API_KEY="$MEMORY_LLM_API_KEY"
    PROXY_UPSTREAM_MODEL="$MEMORY_LLM_MODEL"
    ok "proxy 组复用 memory 组配置，跳过重复检查"
  else
    while true; do
      base=$(prompt_with_default "proxy 组 UPSTREAM_URL" "${PROXY_UPSTREAM_URL:-}")
      key=$(prompt_with_default "proxy 组 UPSTREAM_API_KEY" "${PROXY_UPSTREAM_API_KEY:-}")
      model=$(prompt_with_default "proxy 组 UPSTREAM_MODEL" "${PROXY_UPSTREAM_MODEL:-}")

      if check_llm_group "proxy 组" "$base" "$key" "$model" openai; then
        PROXY_UPSTREAM_URL="$base"
        PROXY_UPSTREAM_API_KEY="$key"
        PROXY_UPSTREAM_MODEL="$model"
        break
      fi
      warn "proxy 组 LLM 通路检查未通过。"
      prompt_confirm "是否重新输入？" 1 || die "用户放弃，退出。"
    done
  fi

  # ── 写回 .env ──
  info "写回 LLM 配置 → $ENV_FILE"
  set_env_value MEMORY_LLM_BASE_URL "$MEMORY_LLM_BASE_URL" "$ENV_FILE"
  set_env_value MEMORY_LLM_API_KEY "$MEMORY_LLM_API_KEY" "$ENV_FILE"
  set_env_value MEMORY_LLM_MODEL "$MEMORY_LLM_MODEL" "$ENV_FILE"
  set_env_value MEMORY_LLM_PROTOCOL "$MEMORY_LLM_PROTOCOL" "$ENV_FILE"
  set_env_value PROXY_UPSTREAM_URL "$PROXY_UPSTREAM_URL" "$ENV_FILE"
  set_env_value PROXY_UPSTREAM_API_KEY "$PROXY_UPSTREAM_API_KEY" "$ENV_FILE"
  set_env_value PROXY_UPSTREAM_MODEL "$PROXY_UPSTREAM_MODEL" "$ENV_FILE"
  ok "LLM 配置已保存到 $ENV_FILE"
}

# ═══════════════════════════════════════════════════════════════
# 端口预检
# ═══════════════════════════════════════════════════════════════

# port_in_use <port>
#   检测宿主机某端口是否处于 LISTEN 状态。返回 0=被占 / 1=空闲。
port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ":${port}$"
  else
    return 1  # 无检测工具时当作空闲，不阻塞启动
  fi
}

# tdai_self_ports
#   输出当前 running 的 tdai 三件套容器映射到宿主机的端口（空格分隔）。
#   这些端口是「自己人」占用，会在启动时被 rm_container_if_exists 重建，不算冲突。
tdai_self_ports() {
  local c p ports=""
  for c in tdai-proxy tdai-memory-hub tdai-memory-core; do
    if $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
      p="$($DOCKER port "$c" 2>/dev/null | grep -oE '[0-9]+$' | sort -u | tr '\n' ' ' || true)"
      ports="$ports $p"
    fi
  done
  printf '%s' "$ports"
}

# check_ports
#   一次性检查 4 个目标端口是否被占用；被「外部进程」占用则报错退出。
#   会排除 tdai 自己容器占用的端口（那些会在启动时被重建）。
check_ports() {
  local self_ports port_var port conflict=0
  self_ports=" $(tdai_self_ports) "
  info "═══ 端口预检 ══════════════════════════════════════════"
  for port_var in MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT PROXY_PORT; do
    port="${!port_var:-}"
    if [[ -z "$port" ]]; then continue; fi
    if [[ "$self_ports" == *" $port "* ]]; then
      info "端口 $port ($port_var) 由 tdai 旧容器占用（启动时会重建），跳过"
      continue
    fi
    if port_in_use "$port"; then
      tdai_echo "${C_RED}[error]${C_RST} 端口 $port ($port_var) 已被占用，请释放该端口或在 .env 改端口。" >&2
      conflict=1
    else
      ok "端口 $port ($port_var) 空闲"
    fi
  done
  (( conflict == 0 )) || die "存在端口冲突，请先释放端口后重试。"
}
