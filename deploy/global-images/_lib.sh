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

# ── Windows / Git Bash 兼容 ─────────────────────────────────────
# MSYS(Git Bash) 会把"看起来像路径"的参数自动转成 Windows 路径再传给原生
# docker.exe，导致：
#   -e TDAI_DATA_DIR=/data/tdai-memory  → C:/Program Files/Git/data/tdai-memory
#   -v src:/data/config/x.yaml:ro       → 目标端被改写成 \Program Files\Git\...
# 关掉转换即可，但**只针对 docker 调用**（见下面的 docker_cmd 包装）。
# 不要全局 export：curl.exe 同样是原生程序，全局关掉之后 `-o /tmp/xxx` 会被
# 原样传过去而写不进文件，curl 于是以非 0 退出——看着像请求失败，其实成过了。
IS_MSYS=0
case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*) IS_MSYS=1 ;;
esac

# 宿主机路径 → docker 能识别的形式。
# Git Bash 下 /f/foo 对 docker.exe 无意义，用 cygpath -m 转成 F:/foo。
to_host_path() {
  if (( IS_MSYS )) && command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    echo "$1"
  fi
}

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

DOCKER_BIN="$(find_docker)"

# 所有 docker 调用都走这里：只在这一层关掉 MSYS 路径转换，
# 保证 -e /data/... 和 -v src:/dest:ro 的容器侧路径原样传进去。
docker_cmd() {
  if (( IS_MSYS )); then
    MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' "$DOCKER_BIN" "$@"
  else
    "$DOCKER_BIN" "$@"
  fi
}

# 各脚本统一用 $DOCKER 调用（这里指向上面的函数，不是可执行文件路径）
DOCKER=docker_cmd

# 找到可用 curl。
# 优先 /usr/bin/curl（macOS/Linux 系统自带，避开 brew 版本差异）；
# Git Bash for Windows 没有 /usr/bin/curl（在 /mingw64/bin），退回 PATH。
find_curl() {
  if [[ -x /usr/bin/curl ]]; then
    echo "/usr/bin/curl"
    return
  fi
  if command -v curl >/dev/null 2>&1; then
    command -v curl
    return
  fi
  die "找不到 curl 命令。"
}

CURL="$(find_curl)"

# 打本机容器端口用这个：绕过 HTTP_PROXY/HTTPS_PROXY。
# 否则宿主机上设了全局代理时，localhost 请求也会被送去代理，
# 代理连不上就回 502 —— 看起来像 gateway 挂了，其实没有。
curl_local() {
  "$CURL" --noproxy '*' "$@"
}

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
