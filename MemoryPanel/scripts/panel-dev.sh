#!/usr/bin/env bash
# panel-dev.sh — MemoryPanel 前后端本地开发服务管理
#
# 用法：
#   scripts/panel-dev.sh start            启动后端 + 前端（已在运行的不会重复启动）
#   scripts/panel-dev.sh stop             停止后端 + 前端
#   scripts/panel-dev.sh restart          重启后端 + 前端
#   scripts/panel-dev.sh status           查看运行状态
#   scripts/panel-dev.sh logs [backend|web]  实时跟踪日志（默认 backend）
#
# 端口（可用环境变量覆盖）：
#   PANEL_BACKEND_PORT   默认取 .env 的 PORT，否则 8123
#   PANEL_WEB_PORT       默认 5173
#
# 产物（logs/ 已 gitignore）：
#   logs/dev/backend.log  logs/dev/backend.pid
#   logs/dev/web.log      logs/dev/web.pid
#
# 说明：
#   - 后端：项目根目录 `pnpm dev`（tsx watch src/index.ts），默认 http://127.0.0.1:8123
#   - 前端：web/ 目录 `npm run dev -- --port <port> --strictPort`，默认 http://localhost:5173
#   - 停止时优先杀 pid 文件记录的进程树，并兜底清理占用端口的残留进程；
#     端口被非本项目进程占用时会跳过并告警，不会误杀。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_DIR="$ROOT_DIR/web"
RUN_DIR="$ROOT_DIR/logs/dev"

BE_LOG="$RUN_DIR/backend.log"
WEB_LOG="$RUN_DIR/web.log"
BE_PID_FILE="$RUN_DIR/backend.pid"
WEB_PID_FILE="$RUN_DIR/web.pid"

MAX_LOG_BYTES=$((5 * 1024 * 1024))

# ── 端口解析 ────────────────────────────────────────────────
resolve_backend_port() {
  local p="${PANEL_BACKEND_PORT:-}"
  if [ -z "$p" ] && [ -f "$ROOT_DIR/.env" ]; then
    p="$(grep -E '^[[:space:]]*PORT=' "$ROOT_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '[:space:]"'"'"'')"
  fi
  printf '%s' "${p:-8123}"
}

BACKEND_PORT="$(resolve_backend_port)"
WEB_PORT="${PANEL_WEB_PORT:-5173}"

# ── 基础工具 ────────────────────────────────────────────────
pid_on_port() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1
}

is_panel_process() {
  local pid="$1" cmd
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  [ -z "$cmd" ] && return 1
  case "$cmd" in
    *"$ROOT_DIR"*) return 0 ;;
    *"$(basename "$ROOT_DIR")"*) return 0 ;;
  esac
  return 1
}

# 先递归杀子进程，再杀自身，避免残留孤儿进程
kill_tree() {
  local pid="$1" sig="${2:-TERM}" child
  if command -v pgrep >/dev/null 2>&1; then
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do
      kill_tree "$child" "$sig"
    done
  fi
  kill "-$sig" "$pid" 2>/dev/null || true
}

wait_port_up() {
  local port="$1" i
  for i in $(seq 1 60); do
    [ -n "$(pid_on_port "$port")" ] && return 0
    sleep 0.5
  done
  return 1
}

wait_port_free() {
  local port="$1" i
  for i in $(seq 1 20); do
    [ -z "$(pid_on_port "$port")" ] && return 0
    sleep 0.5
  done
  return 1
}

rotate_log() {
  local f="$1"
  if [ -f "$f" ]; then
    local size
    size="$(wc -c <"$f" | tr -d ' ')"
    if [ "${size:-0}" -gt "$MAX_LOG_BYTES" ]; then
      mv -f "$f" "$f.1"
    fi
  fi
}

# ── start ──────────────────────────────────────────────────
start_backend() {
  local pid
  pid="$(pid_on_port "$BACKEND_PORT")"
  if [ -n "$pid" ]; then
    echo "[backend] 已在运行：pid $pid  http://127.0.0.1:$BACKEND_PORT"
    return 0
  fi
  if [ ! -d "$ROOT_DIR/node_modules" ]; then
    echo "[backend] 缺少依赖，请先执行：cd $ROOT_DIR && pnpm install" >&2
    return 1
  fi
  if [ ! -f "$ROOT_DIR/.env" ]; then
    cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
    echo "[backend] 未发现 .env，已从 .env.example 复制"
  fi

  mkdir -p "$RUN_DIR"
  rotate_log "$BE_LOG"

  local runner=""
  if command -v pnpm >/dev/null 2>&1; then
    runner="pnpm dev"
  else
    runner="npx tsx watch src/index.ts"
  fi

  ( cd "$ROOT_DIR" && exec nohup $runner </dev/null >>"$BE_LOG" 2>&1 ) &
  echo "$!" >"$BE_PID_FILE"

  if wait_port_up "$BACKEND_PORT"; then
    echo "[backend] 已启动：http://127.0.0.1:$BACKEND_PORT  (日志 $BE_LOG)"
  else
    echo "[backend] 启动超时，请查看日志：$BE_LOG" >&2
    return 1
  fi
}

start_web() {
  local pid
  pid="$(pid_on_port "$WEB_PORT")"
  if [ -n "$pid" ]; then
    echo "[web]     已在运行：pid $pid  http://localhost:$WEB_PORT"
    return 0
  fi
  if [ ! -d "$WEB_DIR/node_modules" ]; then
    echo "[web]     缺少依赖，请先执行：cd $WEB_DIR && npm install" >&2
    return 1
  fi

  mkdir -p "$RUN_DIR"
  rotate_log "$WEB_LOG"

  ( cd "$WEB_DIR" && exec nohup npm run dev -- --port "$WEB_PORT" --strictPort </dev/null >>"$WEB_LOG" 2>&1 ) &
  echo "$!" >"$WEB_PID_FILE"

  if wait_port_up "$WEB_PORT"; then
    echo "[web]     已启动：http://localhost:$WEB_PORT  (日志 $WEB_LOG)"
  else
    echo "[web]     启动超时，请查看日志：$WEB_LOG" >&2
    return 1
  fi
}

# ── stop ───────────────────────────────────────────────────
stop_target() {
  local name="$1" port="$2" pidfile="$3"
  local candidates="" p lp

  if [ -f "$pidfile" ]; then
    p="$(tr -d '[:space:]' <"$pidfile" 2>/dev/null || true)"
    [ -n "$p" ] && candidates="$p"
  fi

  lp="$(pid_on_port "$port")"
  if [ -n "$lp" ]; then
    case " $candidates " in
      *" $lp "*) ;;
      *) candidates="${candidates:+$candidates }$lp" ;;
    esac
  fi

  if [ -z "$candidates" ]; then
    echo "[$name] 未在运行（端口 $port 空闲）"
    rm -f "$pidfile"
    return 0
  fi

  for p in $candidates; do
    if ! kill -0 "$p" 2>/dev/null; then
      continue
    fi
    if ! is_panel_process "$p"; then
      echo "[$name] 端口 $port 被非本项目进程占用，已跳过：pid $p  $(ps -o command= -p "$p" 2>/dev/null)" >&2
      continue
    fi
    kill_tree "$p" TERM
  done

  if wait_port_free "$port"; then
    echo "[$name] 已停止（端口 $port 已释放）"
    rm -f "$pidfile"
    return 0
  fi

  echo "[$name] 进程未响应 TERM，强制结束…" >&2
  for p in $candidates; do
    is_panel_process "$p" && kill_tree "$p" KILL
  done
  if wait_port_free "$port"; then
    echo "[$name] 已强制停止（端口 $port 已释放）"
    rm -f "$pidfile"
    return 0
  fi
  echo "[$name] 停止失败，端口 $port 仍被占用" >&2
  return 1
}

# ── status ─────────────────────────────────────────────────
status_one() {
  local name="$1" port="$2" url="$3" pid
  pid="$(pid_on_port "$port")"
  if [ -z "$pid" ]; then
    printf '%-8s 未运行  (端口 %s)\n' "$name" "$port"
    return 1
  fi
  if is_panel_process "$pid"; then
    printf '%-8s 运行中  pid %-7s 端口 %-5s %s\n' "$name" "$pid" "$port" "$url"
  else
    printf '%-8s 端口 %s 被其他进程占用  pid %s  %s\n' "$name" "$port" "$pid" "$(ps -o command= -p "$pid" 2>/dev/null)"
  fi
}

cmd_status() {
  status_one "backend" "$BACKEND_PORT" "http://127.0.0.1:$BACKEND_PORT/health"
  status_one "web" "$WEB_PORT" "http://localhost:$WEB_PORT"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:$BACKEND_PORT/health" 2>/dev/null || true)"
  [ -n "$code" ] && echo "backend /health -> $code"
}

# ── logs ───────────────────────────────────────────────────
cmd_logs() {
  local which="${1:-backend}" f
  case "$which" in
    backend | be) f="$BE_LOG" ;;
    web | frontend | fe) f="$WEB_LOG" ;;
    *)
      echo "用法：$0 logs [backend|web]" >&2
      return 2
      ;;
  esac
  [ -f "$f" ] || {
    echo "日志文件不存在：$f" >&2
    return 1
  }
  tail -n 100 -f "$f"
}

# ── 入口 ───────────────────────────────────────────────────
usage() {
  sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
}

cmd_start() {
  local rc=0
  start_backend || rc=1
  start_web || rc=1
  echo
  cmd_status
  return "$rc"
}

cmd_stop() {
  local rc=0
  stop_target "backend" "$BACKEND_PORT" "$BE_PID_FILE" || rc=1
  stop_target "web" "$WEB_PORT" "$WEB_PID_FILE" || rc=1
  return "$rc"
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart)
    cmd_stop
    echo
    sleep 1
    cmd_start
    ;;
  status) cmd_status ;;
  logs) shift; cmd_logs "${1:-backend}" ;;
  "" | -h | --help | help) usage ;;
  *)
    echo "未知命令：$1" >&2
    usage
    exit 2
    ;;
esac
