#!/usr/bin/env bash
# 通用工具函数：加载 .env、校验必填参数、等待容器 health、清理旧容器。
# 由 start-*.sh 通过 `source _lib.sh` 引入，不单独执行。

set -euo pipefail

# 避免 Windows 下 Git Bash 将 -v 挂载路径（特别是 :ro 后缀）翻译错误
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"

# 颜色
if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YLW=$'\033[33m'; C_BLU=$'\033[34m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YLW=""; C_BLU=""; C_RST=""
fi

info() { echo "${C_BLU}[$(date +%H:%M:%S)]${C_RST} $*"; }
ok()   { echo "${C_GRN}[ok]${C_RST} $*"; }
warn() { echo "${C_YLW}[warn]${C_RST} $*" >&2; }
die()  { echo "${C_RED}[error]${C_RST} $*" >&2; exit 1; }

# 加载 .env（未创建时给指引）
load_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    die ".env 不存在。先 cp .env.example .env 并填入 LLM 参数。"
  fi
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
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
    echo "${C_RED}[error]${C_RST} .env 中以下必填参数未设置或仍为 REPLACE_ME：" >&2
    for v in "${missing[@]}"; do echo "  - $v" >&2; done
    echo "" >&2
    echo "  编辑 $ENV_FILE 后重试。" >&2
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

# 可移植 curl 定位：Git Bash (Windows) 下 /usr/bin/curl 不存在，curl 在 PATH 里
# （/c/Windows/system32/curl）。统一用 command -v 解析一次，避免硬编码路径。
CURL="$(command -v curl || true)"
if [[ -z "$CURL" ]]; then
  die "找不到 curl 命令，请先安装（macOS/Linux 自带，Windows 用 Git Bash 自带或 system32）。"
fi

# PULL=1 时拉取镜像最新版本。
# 默认关闭：docker run 在本地没有镜像时会自动拉，但本地已有同名 :latest 时会直接复用，
# 不会感知远端更新——想升级到最新 latest 就带 PULL=1。
pull_image() {
  local image="$1"
  [[ "${PULL:-0}" == "1" ]] || return 0
  info "拉取镜像 $image"
  $DOCKER pull "$image" || die "拉取 $image 失败。"
}

# fork 模式：确保组件镜像可用（一键启动，无需手动跑 build-*-fork.sh / 热补丁）。
# 判定：<COMP>_FORK=1，或镜像名以 `:fork` 结尾。
#   - 镜像已存在 → 直接复用（<COMP>_REBUILD=1 / PULL=1 时强制重建）
#   - 镜像不存在 → 自动调用对应的 build-*-fork.sh 构建
# 非 fork 模式 → 走原始 pull_image 逻辑（拉官方镜像）。
#
# 用法：ensure_fork_image "<IMAGE_VAR_NAME>" "<BUILD_SCRIPT>"
#   例：ensure_fork_image "PROXY_IMAGE" "build-proxy-fork.sh"
#       ensure_fork_image "MEMORY_HUB_IMAGE" "build-memory-hub-fork.sh"
# fork 开关变量：<VAR_NAME 前缀>_FORK（如 PROXY_FORK / MEMORY_HUB_FORK）、
#                <前缀>_REBUILD（如 PROXY_REBUILD / MEMORY_HUB_REBUILD）。
ensure_fork_image() {
  local var_name="$1"
  local build_script="$2"
  local image="${!var_name:-}"
  local prefix="${var_name%_IMAGE}"  # PROXY_IMAGE → PROXY, MEMORY_HUB_IMAGE → MEMORY_HUB

  if [[ -z "$image" ]]; then
    die "$var_name 未设置。"
  fi

  local fork_flag="${prefix}_FORK"
  local rebuild_flag="${prefix}_REBUILD"
  if [[ "${!fork_flag:-0}" == "1" || "$image" == *":fork" ]]; then
    if docker image inspect "$image" >/dev/null 2>&1 && [[ "${!rebuild_flag:-0}" != "1" && "${PULL:-0}" != "1" ]]; then
      info "fork 镜像 $image 已存在，直接复用（$rebuild_flag=1 可强制重建）"
      return 0
    fi
    info "构建 fork 镜像 $image（本地改动内置，无需热补丁）..."
    bash "$SCRIPT_DIR/$build_script"
    return 0
  fi
  pull_image "$image"
}

# 兼容旧调用（proxy 专用），行为与 ensure_fork_image 一致。
ensure_proxy_image() {
  ensure_fork_image "PROXY_IMAGE" "build-proxy-fork.sh"
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
  echo "  ┌─────────────────────────────────────────────────────────┐"
  echo "  │ 服务地址                                                │"
  echo "  ├─────────────────────────────────────────────────────────┤"
  printf "  │ Panel UI       http://localhost:%-24s│\n" "${PANEL_PORT}/"
  printf "  │ Panel API      http://localhost:%-24s│\n" "${PANEL_PORT}/api/v1/"
  printf "  │ Knowledge API  http://localhost:%-24s│\n" "${KNOWLEDGE_PORT}/v3/"
  printf "  │ Knowledge Docs http://localhost:%-24s│\n" "${KNOWLEDGE_PORT}/docs"
  printf "  │ Memory Core     http://localhost:%-24s│\n" "${MEMORY_CORE_PORT}/"
  printf "  │ Proxy          http://localhost:%-24s│\n" "${PROXY_PORT}/"
  echo "  └─────────────────────────────────────────────────────────┘"
}
