#!/usr/bin/env bash
# context-proxy 后台管理脚本（默认启动 proxy + 守护进程）
# 用法: ./proxy.sh [start|stop|restart|status|log|daemon|daemon-stop|daemon-status]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 项目根目录（scripts/ 的上一级），src/index.ts 与 config.yaml 都在这里
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$SCRIPT_DIR/context-proxy.pid"
DAEMON_PID_FILE="$SCRIPT_DIR/context-proxy-daemon.pid"
LOG_DIR="$SCRIPT_DIR/logs"
LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d).log"
DAEMON_LOG="$LOG_DIR/daemon.log"
CONFIG_FILE="$PROJECT_ROOT/config.yaml"

# 从 config.yaml 读取端口（默认 8096）
PROXY_PORT="$(grep -E '^\s*port:' "$CONFIG_FILE" 2>/dev/null | head -1 | awk '{print $2}')"
PROXY_PORT="${PROXY_PORT:-8096}"

# 守护进程配置（可通过环境变量覆盖）
DAEMON_CHECK_INTERVAL="${DAEMON_CHECK_INTERVAL:-5}"       # 健康检查间隔（秒）
DAEMON_MAX_RESTARTS="${DAEMON_MAX_RESTARTS:-10}"           # 窗口内最大重启次数
DAEMON_RESTART_WINDOW="${DAEMON_RESTART_WINDOW:-300}"      # 重启计数窗口（秒）
DAEMON_BACKOFF_BASE="${DAEMON_BACKOFF_BASE:-2}"            # 退避指数底数
DAEMON_BACKOFF_MAX="${DAEMON_BACKOFF_MAX:-60}"             # 最大退避间隔（秒）

# 如果是守护循环入口，跳过 set -euo 严格模式，避免意外退出
if [[ "${1:-}" != "_daemon_entry" ]]; then
  set -euo pipefail
fi

# Ensure logs directory exists
mkdir -p "$LOG_DIR"

# 自动检测 node 路径（兼容 nvm / fnm / 系统安装 / 自定义路径）
_find_node() {
  local p
  # 1. 优先尝试 NVM，强制激活并定位 Node v22
  for s in "$HOME/.nvm/nvm.sh" /usr/local/nvm/nvm.sh; do
    if [[ -f "$s" ]]; then
      source "$s" 2>/dev/null
      p="$(nvm which 22 2>/dev/null || nvm which default 2>/dev/null)"
      [[ -n "$p" ]] && { echo "$p"; return; }
    fi
  done
  # 2. 尝试使用 FNM
  if command -v fnm &>/dev/null; then
    eval "$(fnm env 2>/dev/null)"
    p="$(command -v node 2>/dev/null)"
    [[ -n "$p" ]] && { echo "$p"; return; }
  fi
  # 3. 兜底当前 PATH
  p="$(command -v node 2>/dev/null)" && { echo "$p"; return; }
  # 4. 常见自定义目录
  for d in "$HOME/.workbuddy/binaries/node/versions" "$HOME/.local/share/fnm/node-versions"; do
    [[ -d "$d" ]] && { p="$(find "$d" -maxdepth 3 -type f -name node -executable 2>/dev/null | sort -V | tail -1)"; [[ -n "$p" ]] && { echo "$p"; return; }; }
  done
  return 1
}

NODE_BIN="$(_find_node)" || { echo "[context-proxy] ERROR: node not found" >&2; exit 1; }
export PATH="$(dirname "$NODE_BIN"):$PATH"

_is_running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

cmd_start() {
  if _is_running; then
    echo "[context-proxy] already running (pid=$(cat "$PID_FILE"))"
    return 0
  fi

  echo "[context-proxy] starting..."
  cd "$PROJECT_ROOT"
  nohup "$NODE_BIN" --import tsx/esm src/index.ts --config "$CONFIG_FILE" \
    >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"

  # 等待启动
  local i=0
  while (( i < 10 )); do
    if curl -sf http://localhost:${PROXY_PORT}/health > /dev/null 2>&1; then
      echo "[context-proxy] started (pid=$(cat "$PID_FILE"))"
      echo "[context-proxy] log: $LOG_FILE"
      return 0
    fi
    sleep 0.5
    (( i++ )) || true
  done

  echo "[context-proxy] failed to start, check log: $LOG_FILE" >&2
  return 1
}

cmd_stop() {
  # 先停守护进程，防止它立刻把 proxy 拉起来
  if _daemon_is_running; then
    cmd_daemon_stop
  fi

  local pid=""
  if [[ -f "$PID_FILE" ]]; then
    pid=$(cat "$PID_FILE")
    kill "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  # 兜底：确保端口释放
  fuser -k ${PROXY_PORT}/tcp 2>/dev/null || true
  sleep 1
  if [[ -n "$pid" ]]; then
    echo "[context-proxy] stopped (pid=$pid)"
  else
    echo "[context-proxy] stopped"
  fi
}

cmd_restart() {
  cmd_daemon_stop
  cmd_stop
  sleep 1
  cmd_daemon
}

cmd_status() {
  if _is_running; then
    local pid
    pid=$(cat "$PID_FILE")
    echo "[context-proxy] running (pid=$pid)"
    curl -s http://localhost:${PROXY_PORT}/health | python3 -m json.tool 2>/dev/null || \
      curl -s http://localhost:${PROXY_PORT}/health
  else
    echo "[context-proxy] not running"
  fi
}

cmd_log() {
  local today_log="$LOG_DIR/$(date +%Y-%m-%d).log"
  if [[ -f "$today_log" ]]; then
    tail -f "$today_log"
  else
    echo "[context-proxy] No log for today yet: $today_log"
    # Fallback: show latest log file
    local latest
    latest="$(ls -t "$LOG_DIR"/*.log 2>/dev/null | head -1)"
    [[ -n "$latest" ]] && echo "[context-proxy] Latest log: $latest" && tail -f "$latest"
  fi
}

# ── 守护进程 ──────────────────────────────────────────────────────────────

_daemon_is_running() {
  [[ -f "$DAEMON_PID_FILE" ]] && kill -0 "$(cat "$DAEMON_PID_FILE")" 2>/dev/null
}

_daemon_log() {
  echo "[daemon $(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$DAEMON_LOG"
}

# 核心守护循环：监控 proxy 进程，异常时自动重启
_daemon_loop() {
  # 不在守护循环里用 set -e，每个操作自己处理错误
  set +e

  local restart_count=0
  local window_start=0
  local consecutive_failures=0

  while true; do
    if ! _is_running; then
      _daemon_log "proxy process died, attempting restart..."

      # 退避策略：连续失败越多，等待越久
      local backoff=$(( DAEMON_BACKOFF_BASE ** consecutive_failures ))
      [[ $backoff -gt $DAEMON_BACKOFF_MAX ]] && backoff=$DAEMON_BACKOFF_MAX

      # 重启次数限流
      local now
      now=$(date +%s)
      if (( window_start == 0 )) || (( now - window_start > DAEMON_RESTART_WINDOW )); then
        window_start=$now
        restart_count=0
      fi

      if (( restart_count >= DAEMON_MAX_RESTARTS )); then
        _daemon_log "FATAL: exceeded $DAEMON_MAX_RESTARTS restarts in ${DAEMON_RESTART_WINDOW}s window. Giving up."
        exit 1
      fi

      _daemon_log "backoff ${backoff}s (failure #$((consecutive_failures + 1)), restart #$((restart_count + 1))/${DAEMON_MAX_RESTARTS})"
      sleep "$backoff"

      if cmd_start; then
        _daemon_log "proxy restarted successfully"
        consecutive_failures=0
        restart_count=$((restart_count + 1))
      else
        _daemon_log "proxy restart failed"
        consecutive_failures=$((consecutive_failures + 1))
      fi
    else
      # 进程存活，重置连续失败计数（但保留窗口内重启计数）
      consecutive_failures=0
    fi

    sleep "$DAEMON_CHECK_INTERVAL"
  done
}

cmd_daemon() {
  if _daemon_is_running; then
    echo "[daemon] already running (pid=$(cat "$DAEMON_PID_FILE"))"
    return 0
  fi

  # 确保 proxy 先启动
  if ! _is_running; then
    echo "[daemon] proxy not running, starting first..."
    cmd_start || { echo "[daemon] failed to start proxy, aborting" >&2; return 1; }
  fi

  echo "[daemon] starting daemon process..."
  mkdir -p "$LOG_DIR"

  # 后台启动守护循环
  nohup "$SCRIPT_DIR/proxy.sh" _daemon_entry >> "$DAEMON_LOG" 2>&1 &

  echo $! > "$DAEMON_PID_FILE"
  echo "[daemon] started (pid=$(cat "$DAEMON_PID_FILE"))"
  echo "[daemon] check interval: ${DAEMON_CHECK_INTERVAL}s, max restarts: ${DAEMON_MAX_RESTARTS}/${DAEMON_RESTART_WINDOW}s"
  echo "[daemon] log: $DAEMON_LOG"
}

cmd_daemon_stop() {
  if _daemon_is_running; then
    local pid
    pid=$(cat "$DAEMON_PID_FILE")
    kill "$pid" 2>/dev/null || true
    rm -f "$DAEMON_PID_FILE"
    echo "[daemon] stopped (pid=$pid)"
  else
    echo "[daemon] not running"
  fi
}

cmd_daemon_status() {
  if _daemon_is_running; then
    local pid
    pid=$(cat "$DAEMON_PID_FILE")
    echo "[daemon] running (pid=$pid)"
    if [[ -f "$DAEMON_LOG" ]]; then
      echo "[daemon] recent log:"
      tail -5 "$DAEMON_LOG"
    fi
  else
    echo "[daemon] not running"
  fi
}

case "${1:-daemon}" in
  start)          cmd_start          ;;
  stop)           cmd_stop           ;;
  restart)        cmd_restart        ;;
  status)         cmd_status         ;;
  log)            cmd_log            ;;
  daemon)         cmd_daemon         ;;
  daemon-stop)    cmd_daemon_stop    ;;
  daemon-status)  cmd_daemon_status  ;;
  _daemon_entry)  _daemon_loop       ;;  # 内部入口，不对外暴露
  *)
    echo "用法: $0 [start|stop|restart|status|log|daemon|daemon-stop|daemon-status]"
    exit 1
    ;;
esac
