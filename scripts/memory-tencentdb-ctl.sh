#!/usr/bin/env bash
#
# memory-tencentdb-ctl.sh — memory_tencentdb (TDAI) 服务统一管理脚本
#
# 两种运行模式：
#
#   默认：standalone 模式
#     Gateway 以独立 HTTP 服务方式运行，完全不触碰 ~/.hermes/
#       日志目录  : $TDAI_DATA_DIR/logs/
#       配置文件  : $TDAI_DATA_DIR/tdai-gateway.json   （llm / embedding / tcvdb）
#       Gateway 端: 127.0.0.1:8420
#
#   --hermes 模式（需显式传 --hermes 或设 MEMORY_TENCENTDB_MODE=hermes）
#     额外做 hermes 集成 —— 路径约定沿用 install_hermes_tdai_gateway.sh：
#       日志目录      : ~/.hermes/logs/memory_tencentdb/
#       env 片段文件  : ~/.hermes/env.d/memory-tencentdb-llm.sh （config llm 会写入）
#       hermes 主配置 : ~/.hermes/config.yaml            （enable-hermes-memory 会修改）
#       目的：hermes 的 supervisor 可通过 os.environ.copy() 把 LLM 凭据继承给
#             它自己托管起来的 Gateway 子进程；也方便 hermes 端排障。
#
# 命令：
#   start | stop | restart | status | logs | health
#   config llm      --api-key <k> --base-url <u> --model <m>
#   config embedding --provider <p> --api-key <k> --base-url <u> --model <m> --dimensions <d>
#                   [--proxy-url <u>]
#   config vdb      --url <u> --username <u> --api-key <k> --database <d> [--ca-pem <path>]
#   config show
#   enable-hermes-memory        # 仅 --hermes 模式：把 hermes config.yaml 的 memory.provider
#                               #                   置为 memory_tencentdb
#
# 绝大多数子命令支持 --dry-run；写入操作均使用临时文件 + rename 原子替换，
# 生成的敏感文件权限设为 0600。

set -euo pipefail

# ============================================================
# 常量 / 路径
# ============================================================

SCRIPT_NAME="memory-tencentdb-ctl"
USER_HOME="${HOME:-$(eval echo "~$(whoami)")}"

# memory-tencentdb 统一根目录（所有 tdai 相关数据/代码默认收纳在此）
# 可通过环境变量 MEMORY_TENCENTDB_ROOT 覆盖
MEMORY_TENCENTDB_ROOT="${MEMORY_TENCENTDB_ROOT:-$USER_HOME/.memory-tencentdb}"

TDAI_INSTALL_DIR="${TDAI_INSTALL_DIR:-$MEMORY_TENCENTDB_ROOT/tdai-memory-openclaw-plugin}"
TDAI_DATA_DIR="${TDAI_DATA_DIR:-$MEMORY_TENCENTDB_ROOT/memory-tdai}"
GATEWAY_CFG="$TDAI_DATA_DIR/tdai-gateway.json"

# 旧路径（仅做提示，不自动迁移；迁移由 install_hermes_memory_tencentdb.sh 负责）
_LEGACY_INSTALL_DIR="$USER_HOME/tdai-memory-openclaw-plugin"
_LEGACY_DATA_DIR="$USER_HOME/memory-tdai"
if [ -z "${TDAI_INSTALL_DIR_EXPLICIT:-}" ] && [ ! -e "$TDAI_INSTALL_DIR" ] && [ -e "$_LEGACY_INSTALL_DIR" ]; then
    printf '[%s] WARN: legacy install dir detected at %s; new default is %s. Run install_hermes_memory_tencentdb.sh to migrate, or `export TDAI_INSTALL_DIR=%s` to keep old location.\n' \
        "$SCRIPT_NAME" "$_LEGACY_INSTALL_DIR" "$TDAI_INSTALL_DIR" "$_LEGACY_INSTALL_DIR" >&2
fi
if [ -z "${TDAI_DATA_DIR_EXPLICIT:-}" ] && [ ! -e "$TDAI_DATA_DIR" ] && [ -e "$_LEGACY_DATA_DIR" ]; then
    printf '[%s] WARN: legacy data dir detected at %s; new default is %s. Run install_hermes_memory_tencentdb.sh to migrate, or `export TDAI_DATA_DIR=%s` to keep old location.\n' \
        "$SCRIPT_NAME" "$_LEGACY_DATA_DIR" "$TDAI_DATA_DIR" "$_LEGACY_DATA_DIR" >&2
fi

# hermes 路径仅在 --hermes 模式下使用；此处保留定义以便 helper 复用。
HERMES_HOME="${HERMES_HOME:-$USER_HOME/.hermes}"
HERMES_CONFIG="$HERMES_HOME/config.yaml"
HERMES_ENV_DIR="$HERMES_HOME/env.d"

GATEWAY_HOST="${MEMORY_TENCENTDB_GATEWAY_HOST:-127.0.0.1}"
GATEWAY_PORT="${MEMORY_TENCENTDB_GATEWAY_PORT:-8420}"

# 运行模式：standalone（默认）| hermes
MODE="${MEMORY_TENCENTDB_MODE:-standalone}"

# 这些会在 _apply_mode_paths 中根据 MODE 实际赋值
HERMES_LOG_DIR=""
PID_FILE=""
STDOUT_LOG=""
STDERR_LOG=""

DRY_RUN=0

# ============================================================
# 通用 helpers
# ============================================================

log()  { printf '[%s] %s\n' "$SCRIPT_NAME" "$*"; }
warn() { printf '[%s:warn] %s\n' "$SCRIPT_NAME" "$*" >&2; }
die()  { printf '[%s:error] %s\n' "$SCRIPT_NAME" "$*" >&2; exit "${2:-1}"; }

need_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found: $1" 127
}

# 安全 shell 引用，避免 api_key 等特殊字符破坏 source
shell_quote() {
    printf '%s' "$1" | sed -e "s/'/'\\\\''/g" -e "1s/^/'/" -e "\$s/\$/'/"
}

# 原子写文件：write_file <path> <mode> <stdin 内容>
write_file_atomic() {
    local path="$1" mode="$2"
    local dir; dir="$(dirname "$path")"
    mkdir -p "$dir"
    if [[ $DRY_RUN -eq 1 ]]; then
        log "[dry-run] would write $path (mode=$mode):"
        sed 's/^/    /'
        return 0
    fi
    local tmp; tmp="$(mktemp "$dir/.${SCRIPT_NAME}.XXXXXX")"
    cat > "$tmp"
    chmod "$mode" "$tmp"
    mv -f "$tmp" "$path"
    log "wrote $path (mode=$mode)"
}

# 端口上的监听 PID（优先 lsof，兜底 ss）
listening_pids() {
    local port="$1"
    if command -v lsof >/dev/null 2>&1; then
        lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true
    elif command -v ss >/dev/null 2>&1; then
        ss -ltnpH "sport = :$port" 2>/dev/null \
            | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | sort -u
    fi
}

# 健康检查（不依赖 curl，用 python3）
health_check() {
    local timeout="${1:-3}"
    python3 - "$GATEWAY_HOST" "$GATEWAY_PORT" "$timeout" <<'PYEOF' 2>/dev/null
import json, sys, urllib.request
host, port, timeout = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
url = f"http://{host}:{port}/health"
try:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        body = r.read().decode("utf-8", "replace")
        print(body)
        sys.exit(0)
except Exception as e:
    print(f"health check failed: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF
}

# 根据 MODE 解析日志 / PID 目录。必须在解析完 --hermes 后、任何 ensure_paths
# / 启动逻辑之前调用。
_apply_mode_paths() {
    case "$MODE" in
        standalone)
            HERMES_LOG_DIR="${MEMORY_TENCENTDB_LOG_DIR:-$TDAI_DATA_DIR/logs}"
            ;;
        hermes)
            HERMES_LOG_DIR="${MEMORY_TENCENTDB_LOG_DIR:-$HERMES_HOME/logs/memory_tencentdb}"
            ;;
        *)
            die "invalid MODE: $MODE (expected standalone | hermes)" 1
            ;;
    esac
    PID_FILE="$HERMES_LOG_DIR/gateway.pid"
    STDOUT_LOG="$HERMES_LOG_DIR/gateway.stdout.log"
    STDERR_LOG="$HERMES_LOG_DIR/gateway.stderr.log"
}

# 仅在 --hermes 模式下执行的守卫。非 hermes 模式调用 hermes 专属命令会直接退出。
require_hermes_mode() {
    [[ "$MODE" == "hermes" ]] || die \
        "'$1' 仅在 --hermes 模式下可用；请追加 --hermes 或设 MEMORY_TENCENTDB_MODE=hermes" 1
}

ensure_paths() {
    mkdir -p "$HERMES_LOG_DIR" "$TDAI_DATA_DIR"
    [[ "$MODE" == "hermes" ]] && mkdir -p "$HERMES_ENV_DIR"
    return 0
}

# 在需要 source 用户 env 的命令里调用。standalone 模式下只读取顶层 /etc/profile.d/
# 的系统级配置（保持和 install 脚本兼容），不 source ~/.hermes/env.d/*。
source_user_envs() {
    # 系统级：install_hermes_tdai_gateway.sh 写入的 /etc/profile.d/memory-tencentdb-env.sh
    # 里只有 Gateway 自身需要的变量（port/host/cmd/llm env），两种模式都可安全 source。
    if [[ -r /etc/profile.d/memory-tencentdb-env.sh ]]; then
        # shellcheck disable=SC1091
        source /etc/profile.d/memory-tencentdb-env.sh
    fi

    if [[ "$MODE" == "hermes" ]]; then
        if [[ -r /etc/profile.d/hermes-env.sh ]]; then
            # shellcheck disable=SC1091
            source /etc/profile.d/hermes-env.sh
        fi
        # 用户级 env.d，优先级更高
        if [[ -d "$HERMES_ENV_DIR" ]]; then
            local f
            for f in "$HERMES_ENV_DIR"/*.sh; do
                [[ -r "$f" ]] || continue
                # shellcheck disable=SC1090
                source "$f"
            done
        fi
    fi
}

# ============================================================
# 启动命令构造
#
# 优先级：
#   1. MEMORY_TENCENTDB_GATEWAY_CMD（install 脚本写入的环境变量）
#   2. 本地 tsx:  cd $TDAI_INSTALL_DIR && npx tsx src/gateway/server.ts
# ============================================================

resolve_gateway_cmd() {
    if [[ -n "${MEMORY_TENCENTDB_GATEWAY_CMD:-}" ]]; then
        printf '%s' "$MEMORY_TENCENTDB_GATEWAY_CMD"
        return 0
    fi
    local entry="$TDAI_INSTALL_DIR/src/gateway/server.ts"
    [[ -f "$entry" ]] || die "Gateway entry not found: $entry (是否已执行 install_hermes_tdai_gateway.sh？)"
    # 与 install 脚本相同风格：sh -c 'cd ... && exec npx tsx ...'
    printf "sh -c 'cd %s && exec npx tsx src/gateway/server.ts'" "$TDAI_INSTALL_DIR"
}

# ============================================================
# 子命令：start / stop / restart / status / logs / health
# ============================================================

cmd_start() {
    ensure_paths
    source_user_envs

    local pids; pids="$(listening_pids "$GATEWAY_PORT")"
    if [[ -n "$pids" ]]; then
        warn "Gateway 已在 :$GATEWAY_PORT 运行 (pid=$pids)"
        return 0
    fi

    need_cmd node
    need_cmd npx

    local gw_cmd; gw_cmd="$(resolve_gateway_cmd)"
    log "starting gateway: $gw_cmd"
    log "stdout -> $STDOUT_LOG"
    log "stderr -> $STDERR_LOG"

    if [[ $DRY_RUN -eq 1 ]]; then
        log "[dry-run] skip spawn"
        return 0
    fi

    # setsid 让 Gateway 脱离当前 shell 的进程组；nohup 兜底保证终端断开不挂
    # eval 是必要的：gw_cmd 是 "sh -c '...'" 这种带引号结构
    if command -v setsid >/dev/null 2>&1; then
        eval "setsid nohup $gw_cmd >>\"$STDOUT_LOG\" 2>>\"$STDERR_LOG\" </dev/null &"
    else
        eval "nohup $gw_cmd >>\"$STDOUT_LOG\" 2>>\"$STDERR_LOG\" </dev/null &"
    fi
    local bg_pid=$!
    echo "$bg_pid" > "$PID_FILE"
    log "spawned pid=$bg_pid (shell wrapper)"

    # 等待端口监听起来 / 健康检查
    local i
    for i in $(seq 1 30); do
        sleep 0.5
        if [[ -n "$(listening_pids "$GATEWAY_PORT")" ]]; then
            if health_check 2 >/dev/null 2>&1; then
                log "gateway healthy on http://$GATEWAY_HOST:$GATEWAY_PORT"
                return 0
            fi
        fi
    done
    warn "gateway 未在 15s 内通过健康检查，请查看 $STDERR_LOG"
    return 1
}

cmd_stop() {
    local pids; pids="$(listening_pids "$GATEWAY_PORT")"
    if [[ -z "$pids" ]]; then
        log "no gateway listening on :$GATEWAY_PORT"
        # 同时清理可能残留的 shell wrapper
        if [[ -f "$PID_FILE" ]]; then
            local wpid; wpid="$(cat "$PID_FILE" 2>/dev/null || true)"
            [[ -n "$wpid" ]] && kill -0 "$wpid" 2>/dev/null && kill -TERM "$wpid" 2>/dev/null || true
            rm -f "$PID_FILE"
        fi
        return 0
    fi

    log "sending SIGTERM to: $pids"
    [[ $DRY_RUN -eq 1 ]] && { log "[dry-run] skip kill"; return 0; }
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true

    local i
    for i in $(seq 1 10); do
        sleep 0.5
        pids="$(listening_pids "$GATEWAY_PORT")"
        [[ -z "$pids" ]] && break
    done

    if [[ -n "$pids" ]]; then
        warn "SIGTERM 未生效，发送 SIGKILL: $pids"
        # shellcheck disable=SC2086
        kill -KILL $pids 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    log "gateway stopped"
}

cmd_restart() {
    cmd_stop || true
    sleep 0.5
    cmd_start
}

cmd_status() {
    local pids; pids="$(listening_pids "$GATEWAY_PORT")"
    echo "== memory_tencentdb Gateway =="
    echo "  mode      : $MODE"
    echo "  host:port : $GATEWAY_HOST:$GATEWAY_PORT"
    echo "  install   : $TDAI_INSTALL_DIR"
    echo "  data dir  : $TDAI_DATA_DIR"
    echo "  log dir   : $HERMES_LOG_DIR"
    echo "  config    : $GATEWAY_CFG $([[ -f $GATEWAY_CFG ]] && echo '[exists]' || echo '[missing]')"
    if [[ "$MODE" == "hermes" ]]; then
        echo "  hermes cfg: $HERMES_CONFIG $([[ -f $HERMES_CONFIG ]] && echo '[exists]' || echo '[missing]')"
    fi
    if [[ -n "$pids" ]]; then
        echo "  state     : RUNNING (pid=$pids)"
        if health_check 2 >/dev/null 2>&1; then
            echo "  health    : OK"
        else
            echo "  health    : UNHEALTHY"
        fi
    else
        echo "  state     : STOPPED"
    fi

    if [[ "$MODE" == "hermes" ]]; then
        echo
        echo "== hermes memory provider =="
        if [[ -f "$HERMES_CONFIG" ]]; then
            local prov
            prov="$(sed -n '/^memory:/,/^[a-zA-Z]/p' "$HERMES_CONFIG" \
                    | sed -n 's/^[[:space:]]*provider:[[:space:]]*//p' | head -n1)"
            echo "  memory.provider = ${prov:-<unset>}"
        else
            echo "  (hermes config 不存在)"
        fi

        echo
        echo "== env files =="
        if [[ -d "$HERMES_ENV_DIR" ]]; then
            ls -l "$HERMES_ENV_DIR"/*.sh 2>/dev/null || echo "  (none)"
        else
            echo "  $HERMES_ENV_DIR not found"
        fi
    fi
}

cmd_logs() {
    local which="${1:-all}" lines="${2:-200}"
    case "$which" in
        out|stdout) tail -n "$lines" -f "$STDOUT_LOG" ;;
        err|stderr) tail -n "$lines" -f "$STDERR_LOG" ;;
        all|*)
            log "tail $STDOUT_LOG & $STDERR_LOG (Ctrl-C 退出)"
            tail -n "$lines" -f "$STDOUT_LOG" "$STDERR_LOG"
            ;;
    esac
}

cmd_health() {
    if health_check 3; then
        log "gateway healthy"
    else
        die "gateway unhealthy" 1
    fi
}

# ============================================================
# 子命令：config <llm|embedding|vdb|show>
#
# 写入两处（与 sync_tdai_llm.sh 一致）：
#   - $HERMES_ENV_DIR/memory-tencentdb-<section>.sh   仅 llm 段需要（通过环境变量暴露）
#   - $GATEWAY_CFG (JSON)                             三段 llm / embedding / tcvdb 都合并写入
# ============================================================

# ---- JSON 合并 helper ----
# 用法：merge_gateway_json "<section>" <<<"$json_fragment"
# section: llm / embedding / tcvdb
merge_gateway_json() {
    local section="$1"
    ensure_paths
    if [[ $DRY_RUN -eq 1 ]]; then
        log "[dry-run] would merge '$section' into $GATEWAY_CFG"
        sed 's/^/    /'
        return 0
    fi
    need_cmd python3
    local fragment; fragment="$(cat)"
    SECTION="$section" FRAGMENT="$fragment" CFG="$GATEWAY_CFG" \
    python3 - <<'PYEOF'
import json, os, tempfile
section = os.environ["SECTION"]
fragment = json.loads(os.environ["FRAGMENT"])
path = os.environ["CFG"]

cfg = {}
if os.path.isfile(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            cfg = json.load(f) or {}
    except Exception:
        cfg = {}

# memory.* 段嵌套在 "memory" 下（gateway config.ts 的 loadGatewayConfig 约定），
# 但 llm 是顶层段（见 src/gateway/config.ts 第 79 行 obj(fileConfig,"llm")）。
if section == "llm":
    merged = cfg.get("llm") or {}
    merged.update(fragment)
    cfg["llm"] = merged
else:
    mem = cfg.get("memory") or {}
    sub = mem.get(section) or {}
    sub.update(fragment)
    mem[section] = sub
    cfg["memory"] = mem

d = os.path.dirname(path) or "."
fd, tmp = tempfile.mkstemp(prefix=".tdai-gateway.", dir=d)
os.close(fd)
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
os.chmod(tmp, 0o600)
os.replace(tmp, path)
PYEOF
    log "merged '$section' into $GATEWAY_CFG (0600)"
}

# ---- config llm ----
cmd_config_llm() {
    local api_key="" base_url="" model="" restart=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --api-key)  api_key="$2"; shift 2 ;;
            --base-url) base_url="$2"; shift 2 ;;
            --model)    model="$2"; shift 2 ;;
            --restart)  restart=1; shift ;;
            *) die "config llm: 未知参数 $1" 1 ;;
        esac
    done
    [[ -n "$api_key"  ]] || die "--api-key 必填"
    [[ -n "$base_url" ]] || die "--base-url 必填"
    [[ -n "$model"    ]] || die "--model 必填"
    case "$base_url" in
        http://*|https://*) ;;
        *) die "--base-url 必须以 http:// 或 https:// 开头: $base_url" 1 ;;
    esac

    log "configure LLM: model=$model base_url=$base_url api_key=<${#api_key} chars>"

    # 1) env 文件（仅 --hermes 模式）：供 hermes 启动时 source，
    #    hermes supervisor 再通过 os.environ.copy() 把凭据注入它自己托管的 Gateway 子进程。
    #    standalone 模式下 Gateway 直接读 tdai-gateway.json，无需 env 文件。
    if [[ "$MODE" == "hermes" ]]; then
        local qk qu qm
        qk="$(shell_quote "$api_key")"
        qu="$(shell_quote "$base_url")"
        qm="$(shell_quote "$model")"
        write_file_atomic "$HERMES_ENV_DIR/memory-tencentdb-llm.sh" 600 <<EOF
# Auto-generated by $SCRIPT_NAME — do not edit by hand.
# Source this file in the shell that launches hermes so MemoryTencentdbProvider
# inherits the credentials via os.environ.copy().
export TDAI_LLM_BASE_URL=$qu
export TDAI_LLM_API_KEY=$qk
export TDAI_LLM_MODEL=$qm
# Legacy aliases used by the Python provider's get_config_schema()
export MEMORY_TENCENTDB_LLM_BASE_URL="\$TDAI_LLM_BASE_URL"
export MEMORY_TENCENTDB_LLM_API_KEY="\$TDAI_LLM_API_KEY"
export MEMORY_TENCENTDB_LLM_MODEL="\$TDAI_LLM_MODEL"
EOF
    fi

    # 2) gateway.json 合并（两种模式都写）
    local frag
    frag=$(API="$api_key" URL="$base_url" MDL="$model" python3 -c '
import json, os
print(json.dumps({"baseUrl": os.environ["URL"], "apiKey": os.environ["API"], "model": os.environ["MDL"]}))
')
    printf '%s' "$frag" | merge_gateway_json llm

    [[ $restart -eq 1 ]] && cmd_restart || log "tip: 追加 --restart 可立刻重启 Gateway 让新 LLM 生效"
}

# ---- config embedding ----
cmd_config_embedding() {
    local provider="" api_key="" base_url="" model="" dimensions="" proxy_url="" restart=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --provider)   provider="$2"; shift 2 ;;
            --api-key)    api_key="$2"; shift 2 ;;
            --base-url)   base_url="$2"; shift 2 ;;
            --model)      model="$2"; shift 2 ;;
            --dimensions) dimensions="$2"; shift 2 ;;
            --proxy-url)  proxy_url="$2"; shift 2 ;;
            --restart)    restart=1; shift ;;
            *) die "config embedding: 未知参数 $1" 1 ;;
        esac
    done
    [[ -n "$provider" ]] || die "--provider 必填（none/openai/deepseek/qclaw/...）"

    # provider=none 只写 provider，其余置空，相当于关闭向量检索
    if [[ "$provider" == "none" ]]; then
        printf '%s' '{"provider":"none","enabled":false}' | merge_gateway_json embedding
        log "embedding disabled (provider=none)"
        [[ $restart -eq 1 ]] && cmd_restart
        return 0
    fi

    [[ -n "$api_key"    ]] || die "--api-key 必填"
    [[ -n "$base_url"   ]] || die "--base-url 必填"
    [[ -n "$model"      ]] || die "--model 必填"
    [[ -n "$dimensions" ]] || die "--dimensions 必填 (例如 1024)"
    case "$base_url" in
        http://*|https://*) ;;
        *) die "--base-url 必须以 http:// 或 https:// 开头: $base_url" 1 ;;
    esac
    [[ "$dimensions" =~ ^[0-9]+$ ]] || die "--dimensions 必须为正整数: $dimensions" 1

    if [[ "$provider" == "qclaw" && -z "$proxy_url" ]]; then
        die "provider=qclaw 需要额外的 --proxy-url" 1
    fi

    log "configure embedding: provider=$provider model=$model dims=$dimensions"

    local frag
    frag=$(
        PROV="$provider" API="$api_key" URL="$base_url" MDL="$model" \
        DIM="$dimensions" PROXY="$proxy_url" python3 -c '
import json, os
out = {
    "enabled": True,
    "provider": os.environ["PROV"],
    "baseUrl":  os.environ["URL"],
    "apiKey":   os.environ["API"],
    "model":    os.environ["MDL"],
    "dimensions": int(os.environ["DIM"]),
}
proxy = os.environ.get("PROXY", "")
if proxy:
    out["proxyUrl"] = proxy
print(json.dumps(out))
')
    printf '%s' "$frag" | merge_gateway_json embedding

    [[ $restart -eq 1 ]] && cmd_restart || log "tip: 追加 --restart 让 embedding 立即生效"
}

# ---- config vdb (Tencent Cloud VectorDB) ----
cmd_config_vdb() {
    local url="" username="root" api_key="" database="" alias="" ca_pem="" embedding_model="" restart=0
    local set_backend=1
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --url)             url="$2"; shift 2 ;;
            --username)        username="$2"; shift 2 ;;
            --api-key)         api_key="$2"; shift 2 ;;
            --database)        database="$2"; shift 2 ;;
            --alias)           alias="$2"; shift 2 ;;
            --ca-pem)          ca_pem="$2"; shift 2 ;;
            --embedding-model) embedding_model="$2"; shift 2 ;;
            --no-set-backend)  set_backend=0; shift ;;
            --restart)         restart=1; shift ;;
            *) die "config vdb: 未知参数 $1" 1 ;;
        esac
    done
    [[ -n "$url"      ]] || die "--url 必填 (例如 http://xxx.tencentclb.com:8100)"
    [[ -n "$api_key"  ]] || die "--api-key 必填"
    [[ -n "$database" ]] || die "--database 必填"
    case "$url" in
        http://*|https://*) ;;
        *) die "--url 必须以 http:// 或 https:// 开头: $url" 1 ;;
    esac
    if [[ -n "$ca_pem" && ! -r "$ca_pem" ]]; then
        die "--ca-pem 文件不可读: $ca_pem" 1
    fi

    log "configure VDB: url=$url database=$database user=$username"

    local frag
    frag=$(
        URL="$url" USR="$username" API="$api_key" DB="$database" \
        ALIAS="$alias" CA="$ca_pem" EM="$embedding_model" python3 -c '
import json, os
out = {
    "url":      os.environ["URL"],
    "username": os.environ["USR"],
    "apiKey":   os.environ["API"],
    "database": os.environ["DB"],
}
for k, env in [("alias","ALIAS"), ("caPemPath","CA"), ("embeddingModel","EM")]:
    v = os.environ.get(env, "")
    if v: out[k] = v
print(json.dumps(out))
')
    printf '%s' "$frag" | merge_gateway_json tcvdb

    # 默认同时把 storeBackend 切到 tcvdb（可用 --no-set-backend 关掉）
    if [[ $set_backend -eq 1 ]]; then
        printf '%s' '{"storeBackend":"tcvdb"}' | CFG="$GATEWAY_CFG" python3 -c '
import json, os, sys, tempfile
path = os.environ["CFG"]
fragment = json.loads(sys.stdin.read())
cfg = {}
if os.path.isfile(path):
    try:
        cfg = json.load(open(path, "r", encoding="utf-8")) or {}
    except Exception:
        cfg = {}
mem = cfg.get("memory") or {}
mem.update(fragment)
cfg["memory"] = mem
d = os.path.dirname(path) or "."
fd, tmp = tempfile.mkstemp(prefix=".tdai-gateway.", dir=d); os.close(fd)
json.dump(cfg, open(tmp, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
os.chmod(tmp, 0o600); os.replace(tmp, path)
' || warn "设置 storeBackend 失败"
        log "memory.storeBackend = tcvdb"
    fi

    [[ $restart -eq 1 ]] && cmd_restart || log "tip: 追加 --restart 让 VDB 配置立即生效"
}

# ---- config vdb-off ----
# 把 gateway.json 的 memory.storeBackend 切回 "sqlite"。
# 默认保留 memory.tcvdb 凭据（便于以后切回 vdb 不用重输）；
# 传 --purge-creds 显式清掉 memory.tcvdb 整段。
cmd_config_vdb_off() {
    local restart=0 purge=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --purge-creds) purge=1; shift ;;
            --restart)     restart=1; shift ;;
            *) die "config vdb-off: 未知参数 $1" 1 ;;
        esac
    done

    ensure_paths
    local purge_note=""
    [[ $purge -eq 1 ]] && purge_note=" (and remove memory.tcvdb)"
    if [[ $DRY_RUN -eq 1 ]]; then
        log "[dry-run] would set memory.storeBackend=sqlite in ${GATEWAY_CFG}${purge_note}"
        [[ $restart -eq 1 ]] && log "[dry-run] would restart Gateway"
        return 0
    fi
    if [[ ! -f "$GATEWAY_CFG" ]]; then
        warn "$GATEWAY_CFG 不存在；写入仅含 storeBackend=sqlite 的最小配置"
    fi

    need_cmd python3
    PURGE="$purge" CFG="$GATEWAY_CFG" python3 - <<'PYEOF' || die "回退到 sqlite 失败" 1
import json, os, sys, tempfile
path = os.environ["CFG"]
purge = os.environ.get("PURGE", "0") == "1"

cfg = {}
if os.path.isfile(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            cfg = json.load(f) or {}
    except Exception as e:
        sys.stderr.write(f"[memory-tencentdb-ctl:warn] 解析 {path} 失败，将以空配置重建: {e}\n")
        cfg = {}

mem = cfg.get("memory") or {}
prev = mem.get("storeBackend")
mem["storeBackend"] = "sqlite"
if purge and "tcvdb" in mem:
    mem.pop("tcvdb", None)
cfg["memory"] = mem

d = os.path.dirname(path) or "."
os.makedirs(d, exist_ok=True)
fd, tmp = tempfile.mkstemp(prefix=".tdai-gateway.", dir=d); os.close(fd)
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
os.chmod(tmp, 0o600)
os.replace(tmp, path)
sys.stderr.write(f"[memory-tencentdb-ctl] memory.storeBackend: {prev!r} -> 'sqlite'"
                 + (" (tcvdb creds purged)" if purge else " (tcvdb creds kept)") + "\n")
PYEOF
    if [[ $purge -eq 1 ]]; then
        log "memory.storeBackend = sqlite (tcvdb creds purged)"
    else
        log "memory.storeBackend = sqlite (tcvdb creds kept; 加 --purge-creds 可清除)"
    fi
    [[ $restart -eq 1 ]] && cmd_restart || log "tip: 追加 --restart 让回退立即生效"
}

# ---- config postgres (PostgreSQL + pgvector) ----
# 把 PG 连接信息合并写入 tdai-gateway.json 的 memory.postgres.*，
# 并默认把 memory.storeBackend 切到 "postgres"（可用 --no-set-backend 关闭）。
# 配置项含义见 docs/design/postgres-backend.md 第 8 节。
cmd_config_postgres() {
    local host="127.0.0.1" port="5432" database="postgres" user="postgres"
    local password="" schema="agent_memory" ssl="" pool_max="" stmt_timeout=""
    local text_config="" vector_index="" use_vector_scale="" restart=0
    local set_backend=1
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --host)                 host="$2"; shift 2 ;;
            --port)                 port="$2"; shift 2 ;;
            --database)             database="$2"; shift 2 ;;
            --user)                 user="$2"; shift 2 ;;
            --password)             password="$2"; shift 2 ;;
            --schema)               schema="$2"; shift 2 ;;
            --ssl)                  ssl="true"; shift ;;
            --no-ssl)               ssl="false"; shift ;;
            --pool-max)             pool_max="$2"; shift 2 ;;
            --statement-timeout-ms) stmt_timeout="$2"; shift 2 ;;
            --text-config)          text_config="$2"; shift 2 ;;
            --vector-index)         vector_index="$2"; shift 2 ;;
            --use-vector-scale)     use_vector_scale="true"; shift ;;
            --no-vector-scale)      use_vector_scale="false"; shift ;;
            --no-set-backend)       set_backend=0; shift ;;
            --restart)              restart=1; shift ;;
            *) die "config postgres: 未知参数 $1" 1 ;;
        esac
    done
    [[ -n "$database" ]] || die "--database 必填"
    [[ -n "$user"     ]] || die "--user 必填"
    [[ "$port" =~ ^[0-9]+$ ]] || die "--port 必须为正整数: $port" 1
    if [[ -n "$pool_max" && ! "$pool_max" =~ ^[0-9]+$ ]]; then
        die "--pool-max 必须为正整数: $pool_max" 1
    fi
    if [[ -n "$stmt_timeout" && ! "$stmt_timeout" =~ ^[0-9]+$ ]]; then
        die "--statement-timeout-ms 必须为正整数: $stmt_timeout" 1
    fi
    if [[ -n "$vector_index" ]]; then
        case "$vector_index" in
            none|hnsw|ivfflat|diskann) ;;
            *) die "--vector-index 只能是 none|hnsw|ivfflat|diskann: $vector_index" 1 ;;
        esac
    fi

    log "configure PostgreSQL: host=$host port=$port db=$database user=$user schema=$schema$([[ -n "$password" ]] && echo " password=<${#password} chars>")"

    local frag
    frag=$(
        HOST="$host" PORT="$port" DB="$database" USR="$user" PWD_="$password" \
        SCHEMA="$schema" SSL="$ssl" POOL="$pool_max" STMT="$stmt_timeout" \
        TEXTCFG="$text_config" VIDX="$vector_index" VSCALE="$use_vector_scale" python3 -c '
import json, os
out = {
    "host": os.environ["HOST"],
    "port": int(os.environ["PORT"]),
    "database": os.environ["DB"],
    "user": os.environ["USR"],
    "schema": os.environ["SCHEMA"],
}
pwd = os.environ.get("PWD_", "")
if pwd:
    out["password"] = pwd
ssl = os.environ.get("SSL", "")
if ssl:
    out["ssl"] = (ssl == "true")
pool = os.environ.get("POOL", "")
if pool:
    out["poolMax"] = int(pool)
stmt = os.environ.get("STMT", "")
if stmt:
    out["statementTimeoutMs"] = int(stmt)
tc = os.environ.get("TEXTCFG", "")
if tc:
    out["textConfig"] = tc
vidx = os.environ.get("VIDX", "")
if vidx:
    out["vectorIndex"] = vidx
vscale = os.environ.get("VSCALE", "")
if vscale:
    out["useVectorScale"] = (vscale == "true")
print(json.dumps(out))
')
    printf '%s' "$frag" | merge_gateway_json postgres

    # 默认把 storeBackend 切到 postgres（--no-set-backend 可关闭）
    if [[ $set_backend -eq 1 ]]; then
        if [[ $DRY_RUN -eq 1 ]]; then
            log "[dry-run] would set memory.storeBackend=postgres in $GATEWAY_CFG"
        else
            printf '%s' '{"storeBackend":"postgres"}' | CFG="$GATEWAY_CFG" python3 -c '
import json, os, sys, tempfile
path = os.environ["CFG"]
fragment = json.loads(sys.stdin.read())
cfg = {}
if os.path.isfile(path):
    try:
        cfg = json.load(open(path, "r", encoding="utf-8")) or {}
    except Exception:
        cfg = {}
mem = cfg.get("memory") or {}
mem.update(fragment)
cfg["memory"] = mem
d = os.path.dirname(path) or "."
fd, tmp = tempfile.mkstemp(prefix=".tdai-gateway.", dir=d); os.close(fd)
json.dump(cfg, open(tmp, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
os.chmod(tmp, 0o600); os.replace(tmp, path)
' || warn "设置 storeBackend 失败"
            log "memory.storeBackend = postgres"
        fi
    fi

    [[ $restart -eq 1 ]] && cmd_restart || log "tip: 追加 --restart 让 PostgreSQL 配置立即生效"
}

# ---- config show ----
cmd_config_show() {
    echo "== $GATEWAY_CFG =="
    if [[ -f "$GATEWAY_CFG" ]]; then
        # 自动脱敏 apiKey
        python3 - "$GATEWAY_CFG" <<'PYEOF'
import json, sys
cfg = json.load(open(sys.argv[1], "r", encoding="utf-8"))
def redact(d):
    if isinstance(d, dict):
        for k, v in d.items():
            if isinstance(v, (dict, list)):
                redact(v)
            elif k.lower() in ("apikey","api_key","password","token") and isinstance(v, str) and v:
                d[k] = f"<redacted:{len(v)} chars>"
    elif isinstance(d, list):
        for x in d: redact(x)
redact(cfg)
print(json.dumps(cfg, indent=2, ensure_ascii=False))
PYEOF
    else
        echo "(not found)"
    fi

    echo
    if [[ "$MODE" == "hermes" ]]; then
        echo "== env files =="
        if [[ -d "$HERMES_ENV_DIR" ]]; then
            local f
            for f in "$HERMES_ENV_DIR"/memory-tencentdb-*.sh; do
                [[ -r "$f" ]] || continue
                echo "--- $f ---"
                # 脱敏 API key 值
                sed -E "s/(API_KEY=)'([^']{0,4})[^']*'/\1'\2<redacted>'/g" "$f"
            done
        fi
    else
        echo "(standalone 模式：不写 env.d；如需 hermes 集成请追加 --hermes)"
    fi
}

# ============================================================
# 子命令：enable-hermes-memory （仅 --hermes 模式）
# 把 $HERMES_CONFIG 的 memory.provider 设置为 memory_tencentdb。
# 写入策略（按优先级，自动降级）：
#   1) ruamel.yaml round-trip：完整保留注释、键序、引号、缩进风格
#   2) 最小化原位行编辑：只改 provider 行，缩进直接拷贝既有兄弟键
#   3) memory 段不存在 → 在末尾追加最小段
# ============================================================

cmd_enable_hermes_memory() {
    require_hermes_mode "enable-hermes-memory"
    [[ -f "$HERMES_CONFIG" ]] || die "hermes 配置不存在: $HERMES_CONFIG"
    [[ $# -eq 0 ]] || die "enable-hermes-memory: 不支持额外参数: $*" 1

    if [[ $DRY_RUN -eq 1 ]]; then
        log "[dry-run] would set memory.provider=memory_tencentdb in $HERMES_CONFIG"
        return 0
    fi

    need_cmd python3
    # 写入策略（按优先级，自动降级）：
    #   1. ruamel.yaml round-trip：完整保留注释、键序、引号、缩进风格
    #   2. 原位行编辑：只改 memory.provider 那一行；缩进直接拷贝同段兄弟键的前缀
    #   3. memory 段不存在 → 在文件末尾追加最小段（此时无既有格式可破坏）
    python3 - "$HERMES_CONFIG" <<'PYEOF'
import os, re, sys, tempfile

path = sys.argv[1]
TARGET = "memory_tencentdb"


def _atomic_write(text: str) -> None:
    d = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=".hermes-config.", dir=d)
    os.close(fd)
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def try_ruamel() -> bool:
    """首选：用 ruamel.yaml round-trip 改写，完整保留注释/键序/缩进/引号。"""
    try:
        from ruamel.yaml import YAML  # type: ignore
    except Exception:
        return False
    yaml = YAML(typ="rt")
    yaml.preserve_quotes = True
    # 不强制 default indent；ruamel 会沿用文档原有缩进风格
    with open(path, "r", encoding="utf-8") as f:
        data = yaml.load(f)
    if data is None:
        # 空文件：构造最小 mapping
        from ruamel.yaml.comments import CommentedMap
        data = CommentedMap()
    if "memory" not in data or not hasattr(data.get("memory"), "__setitem__"):
        from ruamel.yaml.comments import CommentedMap
        data["memory"] = CommentedMap()
    data["memory"]["provider"] = TARGET
    import io
    buf = io.StringIO()
    yaml.dump(data, buf)
    _atomic_write(buf.getvalue())
    print(f"updated {path} (ruamel.yaml round-trip)")
    return True


def fallback_inline_edit() -> None:
    """兜底：纯文本最小化原位编辑，永不重写整个文件结构。

    规则：
      - 找到顶级 `memory:` 段及其 block（直到下一个顶级键）
      - 若 block 内已有 `^(\\s+)provider\\s*:` 行 → 用相同前缀替换该行
        （缩进直接复用现有 provider 行，零猜测）
      - 否则在 block 内"拓印"任意已存在兄弟键的缩进，紧跟 `memory:` 之后插入一行
      - 若 block 完全为空（仅 memory: 一行）→ 在 `memory:` 后插入一行，
        缩进 copy 自同文件中其他顶级 mapping 的子键缩进；找不到再退化为 2
      - 若全文没有 `memory:` 顶级段 → 在文件末尾追加最小段
    """
    with open(path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    top_key_re = re.compile(r"^[A-Za-z_][\w\-]*\s*:")
    memory_start_re = re.compile(r"^memory\s*:\s*(#.*)?$")
    sibling_key_re = re.compile(r"^(\s+)[A-Za-z_][\w\-]*\s*:")
    provider_line_re = re.compile(r"^(\s+)provider(\s*):(\s*)(.*)$")

    def infer_indent_from_doc() -> str:
        """从文档中其他顶级 mapping 的首个子键提取缩进字符串。"""
        in_top = False
        for ln in lines:
            if top_key_re.match(ln):
                in_top = True
                continue
            if in_top:
                if not ln.strip() or ln.lstrip().startswith("#"):
                    continue
                m = sibling_key_re.match(ln)
                if m:
                    return m.group(1)
                if top_key_re.match(ln):
                    in_top = True
                    continue
                in_top = False
        return "  "  # 极端情况：整个文件只有 memory: 自己

    # 定位 memory: 顶级段
    mem_idx = -1
    for idx, ln in enumerate(lines):
        if memory_start_re.match(ln):
            mem_idx = idx
            break

    if mem_idx == -1:
        # 全文无 memory 段：直接追加（不存在格式破坏问题）
        indent_str = infer_indent_from_doc()
        if lines and not lines[-1].endswith("\n"):
            lines.append("\n")
        lines.append("memory:\n")
        lines.append(f"{indent_str}provider: {TARGET}\n")
        _atomic_write("".join(lines))
        print(f"updated {path} (appended new memory section)")
        return

    # 圈定 block 范围：[mem_idx+1, end)
    end = len(lines)
    for j in range(mem_idx + 1, len(lines)):
        if top_key_re.match(lines[j]):
            end = j
            break
    block = lines[mem_idx + 1:end]

    # 1) 若已有 provider 行，用相同前缀原位替换该行
    for k, b in enumerate(block):
        m = provider_line_re.match(b)
        if m:
            indent = m.group(1)
            sp_before = m.group(2)
            sp_after = m.group(3) or " "
            # 保留行尾注释（# 后内容）
            tail = m.group(4)
            comment = ""
            ci = tail.find("#")
            if ci >= 0:
                # 简单处理：value 是 # 之前的部分（去除右侧空格），后续保留注释
                comment = "  " + tail[ci:].rstrip("\n")
            new_line = f"{indent}provider{sp_before}:{sp_after}{TARGET}{comment}\n"
            lines[mem_idx + 1 + k] = new_line
            _atomic_write("".join(lines))
            print(f"updated {path} (replaced provider line in-place)")
            return

    # 2) 无 provider 行：拓印同 block 内其他兄弟键的缩进
    sibling_indent = None
    for b in block:
        if not b.strip() or b.lstrip().startswith("#"):
            continue
        m = sibling_key_re.match(b)
        if m:
            sibling_indent = m.group(1)
            break

    if sibling_indent is None:
        # block 内无任何兄弟键（如刚刚新建/只有注释）→ 从文档其它段推断
        sibling_indent = infer_indent_from_doc()

    insert_at = mem_idx + 1
    new_line = f"{sibling_indent}provider: {TARGET}\n"
    lines.insert(insert_at, new_line)
    _atomic_write("".join(lines))
    print(f"updated {path} (inserted provider line)")


if not try_ruamel():
    sys.stderr.write(
        "[memory-tencentdb-ctl:info] ruamel.yaml 未安装，使用最小化原位编辑回退方案 "
        "(pip install ruamel.yaml 可获得最佳保真度)\n"
    )
    fallback_inline_edit()
PYEOF
    log "hermes memory.provider = memory_tencentdb"
}

# ============================================================
# 命令分发
# ============================================================

usage() {
    cat <<'USAGE'
memory-tencentdb-ctl.sh — memory_tencentdb (TDAI) Gateway 管理脚本

运行模式:
  standalone (默认)   Gateway 独立运行；日志落在 $TDAI_DATA_DIR/logs/；不触碰 ~/.hermes
  --hermes            额外做 hermes 集成：日志落 ~/.hermes/logs/memory_tencentdb/，
                      config llm 同步写 ~/.hermes/env.d/memory-tencentdb-llm.sh，
                      并开放 enable-hermes-memory 子命令
                      （也可通过 MEMORY_TENCENTDB_MODE=hermes 全局生效）

常用:
  memory-tencentdb-ctl start                        启动 Gateway
  memory-tencentdb-ctl stop                         停止 Gateway
  memory-tencentdb-ctl restart                      重启 Gateway
  memory-tencentdb-ctl status                       查看状态
  memory-tencentdb-ctl health                       健康检查 (/health)
  memory-tencentdb-ctl logs [out|err|all] [N=200]   滚动查看日志

配置 (默认只写 $TDAI_DATA_DIR/tdai-gateway.json，即 ~/.memory-tencentdb/memory-tdai/tdai-gateway.json；
      --hermes 时 LLM 额外写 env.d):
  memory-tencentdb-ctl config llm --api-key K --base-url U --model M [--restart]
  memory-tencentdb-ctl config embedding --provider P --api-key K --base-url U \
                                        --model M --dimensions D [--proxy-url U] [--restart]
  memory-tencentdb-ctl config embedding --provider none           # 关闭 embedding
  memory-tencentdb-ctl config vdb --url U --api-key K --database D \
                                  [--username root] [--alias A] [--ca-pem /path] \
                                  [--embedding-model bge-large-zh] [--no-set-backend] [--restart]
  memory-tencentdb-ctl config vdb-off [--purge-creds] [--restart]
                                                # 切回本地 sqlite 存储；默认保留 tcvdb 凭据
                                                # （仅改 storeBackend），加 --purge-creds 才清除凭据
  memory-tencentdb-ctl config postgres --database D --user U [--password P] \
                                       [--host 127.0.0.1] [--port 5432] [--schema agent_memory] \
                                       [--ssl|--no-ssl] [--pool-max 5] [--statement-timeout-ms 10000] \
                                       [--text-config simple|jieba] \
                                       [--vector-index hnsw|ivfflat|diskann|none] \
                                       [--use-vector-scale|--no-vector-scale] \
                                       [--no-set-backend] [--restart]
                                                # 配置 PostgreSQL(pgvector) 后端并切到 storeBackend=postgres
                                                # 配置项含义见 docs/design/postgres-backend.md 第 8 节
  memory-tencentdb-ctl config show                                 # 打印配置（apiKey 已脱敏）

Hermes 集成 (需 --hermes):
  memory-tencentdb-ctl --hermes enable-hermes-memory
                                                    设置 ~/.hermes/config.yaml 的 memory.provider；
                                                    优先 ruamel.yaml round-trip（保留注释/格式），
                                                    未安装时降级为最小化原位行编辑（缩进自动从既有键拓印）。

全局选项:
  --hermes / --standalone   切换运行模式（默认 standalone）
  --dry-run                 预演所有写操作，不真正落盘
  -h, --help                显示本帮助

关键环境变量:
  MEMORY_TENCENTDB_MODE                      standalone | hermes （等价于 --hermes / --standalone）
  MEMORY_TENCENTDB_GATEWAY_HOST / _PORT      Gateway 监听地址 (default 127.0.0.1:8420)
  MEMORY_TENCENTDB_GATEWAY_CMD               自定义启动命令（否则走 $TDAI_INSTALL_DIR）
  MEMORY_TENCENTDB_LOG_DIR                   覆盖日志目录
  MEMORY_TENCENTDB_ROOT                      统一根目录（默认 ~/.memory-tencentdb）
  TDAI_INSTALL_DIR / TDAI_DATA_DIR           插件源码 / 数据目录
                                             （默认分别位于 $MEMORY_TENCENTDB_ROOT 之下）
USAGE
}

# 拆掉全局 flag
ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)    DRY_RUN=1; shift ;;
        --hermes)     MODE="hermes"; shift ;;
        --standalone) MODE="standalone"; shift ;;
        -h|--help)    usage; exit 0 ;;
        *) ARGS+=("$1"); shift ;;
    esac
done
set -- "${ARGS[@]:-}"

# 根据 MODE 初始化日志 / PID 路径
_apply_mode_paths

[[ $# -ge 1 ]] || { usage; exit 1; }

SUB="$1"; shift || true
case "$SUB" in
    start)    cmd_start "$@" ;;
    stop)     cmd_stop "$@" ;;
    restart)  cmd_restart "$@" ;;
    status)   cmd_status "$@" ;;
    health)   cmd_health "$@" ;;
    logs)     cmd_logs "$@" ;;
    config)
        [[ $# -ge 1 ]] || die "config 需要子命令: llm | embedding | vdb | vdb-off | postgres | show" 1
        SECTION="$1"; shift || true
        case "$SECTION" in
            llm)       cmd_config_llm "$@" ;;
            embedding) cmd_config_embedding "$@" ;;
            vdb)       cmd_config_vdb "$@" ;;
            vdb-off)   cmd_config_vdb_off "$@" ;;
            postgres)  cmd_config_postgres "$@" ;;
            show)      cmd_config_show "$@" ;;
            *) die "未知 config 子命令: $SECTION" 1 ;;
        esac
        ;;
    enable-hermes-memory) cmd_enable_hermes_memory "$@" ;;
    *) usage; die "未知命令: $SUB" 1 ;;
esac
