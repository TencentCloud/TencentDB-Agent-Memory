#!/usr/bin/env bash
#
# gateway-up.sh — 确保 TencentDB Agent Memory Gateway 在线（幂等）。
#
# 行为：
#   1. 探测 Gateway 健康端点（GET /health，用 python3，不依赖 curl）。
#   2. 已健康 → 直接返回 0（复用既有实例）。
#   3. 未在线 → 委托既有 memory-tencentdb-ctl.sh start 拉起，再做健康检查。
#
# 可重复调用，CodeBuddy Skill 在每个会话首次涉及记忆时调用一次即可。
#
# ctl.sh 定位顺序：
#   1. $MEMORY_TENCENTDB_CTL 环境变量（显式指定 ctl.sh 路径）
#   2. 同目录 .gateway-ctl-path 文件（install 脚本写入仓库内 ctl.sh 绝对路径）
#   3. 相对路径 ../../scripts/memory-tencentdb-ctl.sh（源码树内位置）
#   4. PATH 中的 memory-tencentdb-ctl.sh
#
# 环境变量：
#   MEMORY_TENCENTDB_GATEWAY_HOST / _PORT   默认 127.0.0.1 / 8420
#   TDAI_GATEWAY_API_KEY                    若 Gateway 启用鉴权（/health 无需鉴权，此处不使用）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GATEWAY_HOST="${MEMORY_TENCENTDB_GATEWAY_HOST:-127.0.0.1}"
GATEWAY_PORT="${MEMORY_TENCENTDB_GATEWAY_PORT:-8420}"

log()  { printf '[gateway-up] %s\n' "$*" >&2; }
die()  { printf '[gateway-up:error] %s\n' "$*" >&2; exit 1; }

# 健康检查（GET /health；不依赖 curl，用 python3）
health_check() {
    local timeout="${1:-3}"
    command -v python3 >/dev/null 2>&1 || return 1
    python3 - "$GATEWAY_HOST" "$GATEWAY_PORT" "$timeout" <<'PYEOF' >/dev/null 2>&1
import json, sys, urllib.request
host, port, timeout = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
url = f"http://{host}:{port}/health"
try:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        body = json.loads(r.read().decode("utf-8", "replace"))
    # status 为 ok / degraded 均视为在线（degraded = 向量库未配，但服务可用）
    sys.exit(0 if body.get("status") in ("ok", "degraded") else 1)
except Exception:
    sys.exit(1)
PYEOF
}

# 定位 ctl.sh
resolve_ctl() {
    if [[ -n "${MEMORY_TENCENTDB_CTL:-}" && -f "${MEMORY_TENCENTDB_CTL}" ]]; then
        printf '%s' "$MEMORY_TENCENTDB_CTL"; return 0
    fi
    local path_file="$SCRIPT_DIR/.gateway-ctl-path"
    if [[ -f "$path_file" ]]; then
        local p; p="$(cat "$path_file" 2>/dev/null | tr -d '\n')"
        if [[ -n "$p" && -f "$p" ]]; then printf '%s' "$p"; return 0; fi
    fi
    local rel="$SCRIPT_DIR/../../scripts/memory-tencentdb-ctl.sh"
    if [[ -f "$rel" ]]; then printf '%s' "$rel"; return 0; fi
    if command -v memory-tencentdb-ctl.sh >/dev/null 2>&1; then
        command -v memory-tencentdb-ctl.sh; return 0
    fi
    return 1
}

main() {
    if health_check 3; then
        log "Gateway 已在线 http://$GATEWAY_HOST:$GATEWAY_PORT"
        echo "ok"
        return 0
    fi

    log "Gateway 未在线，尝试拉起…"
    local ctl
    if ! ctl="$(resolve_ctl)"; then
        die "找不到 memory-tencentdb-ctl.sh；请设 MEMORY_TENCENTDB_CTL 指向它，或先运行 install-codebuddy-skill.sh"
    fi
    log "委托启动: $ctl start"
    if ! bash "$ctl" start; then
        log "ctl.sh start 返回非 0；请查看 Gateway 日志（memory-tencentdb-ctl.sh logs）"
    fi

    # 再做一次健康检查（ctl.sh start 内部已轮询，这里二次确认）
    local i
    for i in $(seq 1 10); do
        if health_check 2; then
            log "Gateway 已就绪 http://$GATEWAY_HOST:$GATEWAY_PORT"
            echo "ok"
            return 0
        fi
        sleep 0.5
    done
    die "Gateway 启动后仍未通过健康检查；请运行 'bash $ctl logs' 排查（参考 references/troubleshooting.md）"
}

main "$@"
