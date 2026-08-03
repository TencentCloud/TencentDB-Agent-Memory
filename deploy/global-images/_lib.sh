#!/usr/bin/env bash
# 通用工具函数：加载 .env、校验必填参数、等待容器 health、清理旧容器。
# 由 start-*.sh 通过 `source _lib.sh` 引入，不单独执行。

set -euo pipefail

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

find_curl() {
  local candidate="${CURL:-curl}"
  local resolved
  resolved="$(command -v "$candidate" 2>/dev/null || true)"
  if [[ -n "$resolved" ]]; then
    echo "$resolved"
    return
  fi
  if [[ -x "$candidate" ]]; then
    echo "$candidate"
    return
  fi
  die "找不到 curl 命令（CURL=${candidate}）。请安装 curl 或通过 CURL 指定可执行文件。"
}

DOCKER="$(find_docker)"

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
