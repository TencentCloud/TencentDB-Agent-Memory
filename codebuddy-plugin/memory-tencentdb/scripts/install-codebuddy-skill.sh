#!/usr/bin/env bash
#
# install-codebuddy-skill.sh — 安装 memory-tencentdb Skill 到 CodeBuddy。
#
# 范围（二选一，决定记忆是跨项目共享还是按项目隔离）：
#   --user            安装到 ~/.codebuddy/skills/memory-tencentdb         （跨项目共享，session_key=codebuddy:global）
#   --project [path]  安装到 <workspace>/.codebuddy/skills/memory-tencentdb（按项目隔离，session_key=codebuddy:proj:<hash>）
#                     默认 workspace = 当前目录，可用 --workspace <path> 指定
#
# 安装动作：
#   1. 复制（或 --link 软链）Skill 源目录到目标 skills 目录
#   2. 写入 scripts/.session-scope（最终 session_key）
#   3. 写入 scripts/.gateway-ctl-path（仓库内 memory-tencentdb-ctl.sh 绝对路径，供 gateway-up.sh 定位）
#   4. 交互式或参数式引导把 PostgreSQL / LLM / Embedding 配置写入 tdai-gateway.json
#
# 两种使用方式：
#   A. 交互式（默认）：直接运行，按提示逐步填写 PG/LLM/Embedding 配置
#      bash install-codebuddy-skill.sh --user
#   B. 命令行传参（CI/脚本）：
#      PostgreSQL: --pg-database --pg-user [--pg-password] [--pg-host] [--pg-port] [--pg-schema]
#                  [--pg-ssl] [--pg-vector-index hnsw|ivfflat|diskann|none] [--pg-text-config simple|jieba]
#      LLM:        --llm-base-url --llm-api-key --llm-model
#      Embedding:  --emb-provider --emb-base-url --emb-api-key --emb-model --emb-dimensions
#
# 其它：
#   --non-interactive  即使未传配置参数也不进入交互（静默跳过配置引导）
#   --restart          配置写完后重启 Gateway 使其生效
#   --link             用软链代替复制（开发时方便，改源码即时生效）
#   --dry-run          预演，不落盘
#   --uninstall        卸载（移除目标 skills 目录下的 memory-tencentdb）
#   -h, --help         帮助

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC="$(cd "$SCRIPT_DIR/.." && pwd)"                 # codebuddy-plugin/memory-tencentdb
REPO_ROOT="$(cd "$SKILL_SRC/../.." && pwd)"               # 仓库根
CTL_SRC="$REPO_ROOT/scripts/memory-tencentdb-ctl.sh"
SKILL_NAME="memory-tencentdb"

DRY_RUN=0
USE_LINK=0
DO_UNINSTALL=0
SCOPE=""             # user | project
WORKSPACE=""
RESTART=0
NON_INTERACTIVE=0
STORE_BACKEND=""     # sqlite | postgres | ""（未选）

# 配置直通
PG_DB="" PG_USER="" PG_PASSWORD="" PG_HOST="" PG_PORT="" PG_SCHEMA="" PG_SSL=0 PG_VIDX="" PG_TEXTCFG=""
LLM_BASE="" LLM_KEY="" LLM_MODEL=""
EMB_PROVIDER="" EMB_BASE="" EMB_KEY="" EMB_MODEL="" EMB_DIM=""

# ─── 颜色 ───
if [[ -t 1 ]]; then
    BOLD='\033[1m'
    DIM='\033[2m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    CYAN='\033[0;36m'
    RED='\033[0;31m'
    NC='\033[0m'
else
    BOLD='' DIM='' GREEN='' YELLOW='' CYAN='' RED='' NC=''
fi

log()   { printf '%b[install]%b %s\n' "$GREEN" "$NC" "$*"; }
warn()  { printf '%b[install:warn]%b %s\n' "$YELLOW" "$NC" "$*" >&2; }
err()   { printf '%b[install:error]%b %s\n' "$RED" "$NC" "$*" >&2; }
header(){ printf '\n%b%b═══ %s ═══%b\n' "$BOLD" "$CYAN" "$*" "$NC"; }
prompt(){ printf '%b%s%b' "$BOLD" "$*" "$NC"; }
hint()  { printf '%b%s%b' "$DIM" "$*" "$NC"; }
die()   { err "$*"; exit 1; }

usage() { sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# ─── 交互输入辅助 ───
is_interactive() {
    [[ $NON_INTERACTIVE -eq 0 && -t 0 && -t 1 ]]
}

# 读取非空值，提供默认值，返回在 REPLY 中
# ask VAR_NAME "提示文字" [默认值]
ask() {
    local var="$1" prompt_text="$2" default="${3:-}"
    local hint_text=""
    if [[ -n "$default" ]]; then
        hint_text=" [${DIM}${default}${NC}]"
    fi
    while true; do
        prompt "  $prompt_text${hint_text}: "
        IFS= read -r REPLY || { echo; return 1; }
        if [[ -z "$REPLY" && -n "$default" ]]; then
            REPLY="$default"
        fi
        if [[ -n "$REPLY" ]]; then break; fi
        err "此项不能为空"
    done
}

# 读取密码（不回显），可选；返回在 REPLY 中
ask_secret() {
    local prompt_text="$1"
    prompt "  $prompt_text（输入不显示）: "
    IFS= read -rs REPLY || { echo; return 1; }
    echo
}

# 读取可选值（允许留空跳过）
# ask_opt VAR_NAME "提示文字" [默认值]  -> 结果在 REPLY
ask_opt() {
    local var="$1" prompt_text="$2" default="${3:-}"
    local hint_text=""
    if [[ -n "$default" ]]; then
        hint_text=" [${DIM}${default}${NC}]"
    fi
    prompt "  $prompt_text${hint_text}: "
    IFS= read -r REPLY || { echo; return 1; }
    if [[ -z "$REPLY" && -n "$default" ]]; then
        REPLY="$default"
    fi
}

# 读取 Yes/No，默认 Yes
ask_yn() {
    local prompt_text="$1"
    while true; do
        prompt "  $prompt_text ${DIM}(Y/n)${NC}: "
        IFS= read -r REPLY
        REPLY="${REPLY:-y}"
        case "${REPLY,,}" in
            y|yes|是) return 0 ;;
            n|no|否)  return 1 ;;
            *) err "请输入 y 或 n" ;;
        esac
    done
}

# 从选项中选择，默认第一项
# ask_select VAR "标题" "选项1" "选项2" ...
ask_select() {
    local var="$1" title="$2"; shift 2
    local options=("$@")
    local i default=1

    echo
    prompt "  $title\n"
    for i in "${!options[@]}"; do
        printf "    ${BOLD}%d${NC}) %s\n" $((i+1)) "${options[$i]}"
    done
    while true; do
        prompt "  请选择 ${DIM}(1-${#options[@]}，默认 1)${NC}: "
        IFS= read -r REPLY
        REPLY="${REPLY:-1}"
        if [[ "$REPLY" =~ ^[0-9]+$ && "$REPLY" -ge 1 && "$REPLY" -le ${#options[@]} ]]; then
            REPLY="${options[$((REPLY-1))]}"
            return 0
        fi
        err "请输入 1-${#options[@]}"
    done
}

# ─── 交互式收集配置 ───
interactive_scope() {
    header "安装范围"
    echo
    cat <<'EOF'
  请选择记忆的共享范围：

  1) 用户级（跨项目共享）
     安装到 ~/.codebuddy/skills/memory-tencentdb
     所有项目共享同一份记忆

  2) 项目级（按项目隔离）
     安装到当前项目 .codebuddy/skills/memory-tencentdb
     不同项目记忆互不干扰
EOF
    echo
    while true; do
        prompt "  请选择 ${DIM}(1/2)${NC}: "
        IFS= read -r REPLY
        case "${REPLY:-1}" in
            1) SCOPE="user"; break ;;
            2)
                SCOPE="project"
                prompt "  项目路径 ${DIM}(默认当前目录)${NC}: "
                IFS= read -r REPLY
                WORKSPACE="${REPLY:-$PWD}"
                break
                ;;
            *) err "请输入 1 或 2" ;;
        esac
    done
    echo
}

# ─── 依赖检测与安装 ───
# 检测 T-A-M 项目依赖是否就绪；缺失时交互式引导 npm install
check_deps_installed() {
    local pkg_json="$REPO_ROOT/package.json"
    local nm_dir="$REPO_ROOT/node_modules"

    if [[ -d "$nm_dir" ]]; then
        log "项目依赖已就绪（node_modules 存在）"
        return 0
    fi

    if [[ ! -f "$pkg_json" ]]; then
        warn "未找到 package.json: $pkg_json"
        return 1
    fi

    # 根据 lock 文件推断包管理器
    local pm="npm"
    local install_cmd="npm install --no-audit --no-fund"
    if [[ -f "$REPO_ROOT/pnpm-lock.yaml" ]]; then
        pm="pnpm"; install_cmd="pnpm install"
    elif [[ -f "$REPO_ROOT/yarn.lock" ]]; then
        pm="yarn"; install_cmd="yarn install"
    elif [[ -f "$REPO_ROOT/bun.lockb" ]]; then
        pm="bun"; install_cmd="bun install"
    fi

    warn "项目依赖未安装（node_modules 缺失）"
    hint "  Gateway 须依赖项目 node_modules 才能启动。\n"
    hint "  将执行: cd $REPO_ROOT && $install_cmd\n"

    if ! is_interactive; then
        hint "  请手动运行: cd $REPO_ROOT && $install_cmd\n"
        return 1
    fi

    prompt "  是否现在安装依赖？ ${DIM}(Y/n)${NC}: "
    IFS= read -r REPLY
    REPLY="${REPLY:-y}"
    if [[ "${REPLY,,}" != y && "${REPLY,,}" != yes && "${REPLY,,}" != 是 ]]; then
        warn "跳过依赖安装，Gateway 将无法启动。稍后请手动:"
        hint "  cd $REPO_ROOT && $install_cmd\n"
        return 1
    fi

    # 检查 node
    if ! command -v node >/dev/null 2>&1; then
        err "未找到 node 命令，请先安装 Node.js 20+"
        return 1
    fi

    if ! command -v "$pm" >/dev/null 2>&1; then
        err "未找到 $pm 命令，请先安装"
        return 1
    fi

    if [[ $DRY_RUN -eq 1 ]]; then
        log "[dry-run] would run: cd $REPO_ROOT && $install_cmd"
        return 0
    fi

    log "正在安装项目依赖（$pm）…"
    log "目录: $REPO_ROOT"
    if (cd "$REPO_ROOT" && $install_cmd); then
        log "依赖安装成功"
        return 0
    else
        err "依赖安装失败，请手动运行: cd $REPO_ROOT && $install_cmd"
        return 1
    fi
}

# ─── 存储后端选择 ───
interactive_storage() {
    header "存储后端"
    echo
    cat <<'EOF'
  请选择记忆存储后端：

  1) SQLite（本地文件，零依赖，开箱即用）
     数据存储在本地 SQLite + sqlite-vec，无需外部服务

  2) PostgreSQL（pgvector，需 PG 服务）
     支持多用户共享记忆，需要已安装 pgvector 扩展

  3) 跳过（稍后手动配置）
EOF
    echo
    while true; do
        prompt "  请选择 ${DIM}(1/2/3)${NC}: "
        IFS= read -r REPLY
        case "${REPLY:-1}" in
            1) STORE_BACKEND="sqlite";  log "选择 SQLite（本地存储）"; echo; return 0 ;;
            2) STORE_BACKEND="postgres"; interactive_pg_config; echo; return 0 ;;
            3) STORE_BACKEND=""; log "跳过存储配置"; echo; return 0 ;;
            *) err "请输入 1、2 或 3" ;;
        esac
    done
}

# 仅在选了 PG 后才调用
interactive_pg_config() {
    log "配置 PostgreSQL 连接…"
    hint "  需要已安装 pgvector 扩展。\n"
    ask PG_DB   "数据库名" "postgres"
    PG_DB="$REPLY"
    ask PG_USER "用户名"   "postgres"
    PG_USER="$REPLY"
    ask_secret "密码（为空则无密码）"
    PG_PASSWORD="$REPLY"
    ask PG_HOST "主机地址" "127.0.0.1"
    PG_HOST="$REPLY"
    ask PG_PORT "端口"     "5432"
    PG_PORT="$REPLY"
    ask PG_SCHEMA "Schema" "agent_memory"
    PG_SCHEMA="$REPLY"
    ask PG_TEXTCFG "中文分词（simple=英文默认 / jieba=中文需pg_jieba扩展）" "simple"
    PG_TEXTCFG="$REPLY"

    # 高级选项
    echo
    prompt "  是否配置高级选项（向量索引/SSL）？ ${DIM}(y/N)${NC}: "
    IFS= read -r REPLY
    if [[ "${REPLY,,}" == y || "${REPLY,,}" == yes ]]; then
        ask_select PG_VIDX "向量索引类型：" "hnsw" "ivfflat" "diskann" "none"
        PG_VIDX="$REPLY"
        if ask_yn "启用 SSL？"; then PG_SSL=1; fi
    fi

    log "PostgreSQL: ${PG_USER}@${PG_HOST}:${PG_PORT}/${PG_DB}$([[ -n "$PG_PASSWORD" ]] && echo ' ***')"
}

interactive_llm() {
    header "LLM 配置（L1 结构化记忆提取必需）"
    echo
    hint "  LLM 用于从对话中提取结构化记忆，需要兼容 OpenAI API 的服务。\n\n"

    prompt "  是否现在配置 LLM？ ${DIM}(Y/n/skip=跳过)${NC}: "
    IFS= read -r REPLY
    REPLY="${REPLY:-y}"
    case "${REPLY,,}" in
        skip|s) log "跳过 LLM 配置，稍后可手动运行:"; hint "  bash $CTL_SRC config llm ...\n"; echo; return 0 ;;
        n|no|否) log "跳过 LLM 配置"; echo; return 0 ;;
    esac

    ask LLM_BASE "API Base URL（兼容 OpenAI 协议）"
    LLM_BASE="$REPLY"
    ask_secret "API Key"
    LLM_KEY="$REPLY"
    ask LLM_MODEL "模型名" "gpt-4o-mini"
    LLM_MODEL="$REPLY"

    log "LLM: ${LLM_MODEL} @ ${LLM_BASE}"
    echo
}

interactive_embedding() {
    header "Embedding 配置（向量召回必需）"
    echo
    hint "  Embedding 用于将文本转为向量进行语义检索。\n"
    hint "  可输入 'none' 关闭 Embedding（仅使用关键词检索），\n"
    hint "  或输入服务商名配置完整参数。\n\n"

    prompt "  是否现在配置 Embedding？ ${DIM}(Y/n/skip=跳过/none=关闭)${NC}: "
    IFS= read -r REPLY
    REPLY="${REPLY:-y}"
    case "${REPLY,,}" in
        skip|s) log "跳过 Embedding 配置，稍后可手动运行:"; hint "  bash $CTL_SRC config embedding ...\n"; echo; return 0 ;;
        n|no|否) log "跳过 Embedding 配置"; echo; return 0 ;;
        none)
            EMB_PROVIDER="none"
            log "Embedding: none（仅关键词检索）"
            echo
            return 0
            ;;
    esac

    ask EMB_PROVIDER "服务商名（如 openai / qwen / zhipu）"
    EMB_PROVIDER="$REPLY"
    ask EMB_BASE "API Base URL"
    EMB_BASE="$REPLY"
    ask_secret "API Key"
    EMB_KEY="$REPLY"
    ask EMB_MODEL "模型名" "text-embedding-3-small"
    EMB_MODEL="$REPLY"
    ask EMB_DIM  "向量维度" "1536"
    EMB_DIM="$REPLY"

    log "Embedding: ${EMB_PROVIDER}/${EMB_MODEL} (${EMB_DIM}d) @ ${EMB_BASE}"
    echo
}

interactive_review() {
    header "配置汇总"
    echo
    printf "  ${BOLD}安装范围${NC}\n"
    if [[ "$SCOPE" == "user" ]]; then
        printf "    用户级（跨项目共享 → ~/.codebuddy/skills/memory-tencentdb）\n"
    else
        printf "    项目级（按项目隔离 → %s/.codebuddy/skills/memory-tencentdb）\n" "${WORKSPACE:-$PWD}"
    fi
    echo
    printf "  ${BOLD}存储后端${NC}\n"
    if [[ "$STORE_BACKEND" == "sqlite" ]]; then
        printf "    SQLite（本地文件，零依赖）\n"
    elif [[ "$STORE_BACKEND" == "postgres" ]]; then
        printf "    PostgreSQL: %s@%s:%s/%s$([[ -n "$PG_PASSWORD" ]] && echo ' ***')\n" "$PG_USER" "$PG_HOST" "$PG_PORT" "$PG_DB"
        [[ -n "$PG_VIDX" ]] && printf "    向量索引: %s\n" "$PG_VIDX"
        [[ $PG_SSL -eq 1 ]] && printf "    SSL: 启用\n"
        [[ -n "$PG_TEXTCFG" ]] && printf "    分词器: %s\n" "$PG_TEXTCFG"
    else
        printf "    ${DIM}（未配置）${NC}\n"
    fi
    echo
    printf "  ${BOLD}LLM${NC}\n"
    if [[ -n "$LLM_MODEL" ]]; then
        printf "    %s @ %s\n" "$LLM_MODEL" "$LLM_BASE"
    else
        printf "    ${DIM}（未配置）${NC}\n"
    fi
    echo
    printf "  ${BOLD}Embedding${NC}\n"
    if [[ "$EMB_PROVIDER" == "none" ]]; then
        printf "    已关闭（仅关键词检索）\n"
    elif [[ -n "$EMB_MODEL" ]]; then
        printf "    %s/%s (%sd) @ %s\n" "$EMB_PROVIDER" "$EMB_MODEL" "$EMB_DIM" "$EMB_BASE"
    else
        printf "    ${DIM}（未配置）${NC}\n"
    fi
    echo
    ask_select _final "下一步操作：" "确认安装" "重新选择存储后端" "重新填写 LLM" "重新填写 Embedding" "取消退出"
    case "$REPLY" in
        "重新选择存储后端")   interactive_storage; interactive_review ;;
        "重新填写 LLM")       interactive_llm;  interactive_review ;;
        "重新填写 Embedding") interactive_embedding; interactive_review ;;
        "取消退出")           log "已取消"; exit 0 ;;
    esac
}

# ─── 参数解析 ───
while [[ $# -gt 0 ]]; do
    case "$1" in
        --user)             SCOPE="user"; shift ;;
        --project)
            SCOPE="project"
            if [[ $# -ge 2 && "${2:-}" != --* ]]; then WORKSPACE="$2"; shift 2; else shift; fi
            ;;
        --workspace)           WORKSPACE="$2"; shift 2 ;;
        --link)                USE_LINK=1; shift ;;
        --dry-run)             DRY_RUN=1; shift ;;
        --uninstall)           DO_UNINSTALL=1; shift ;;
        --restart)             RESTART=1; shift ;;
        --non-interactive)     NON_INTERACTIVE=1; shift ;;
        --pg-database)         PG_DB="$2"; shift 2 ;;
        --pg-user)             PG_USER="$2"; shift 2 ;;
        --pg-password)         PG_PASSWORD="$2"; shift 2 ;;
        --pg-host)             PG_HOST="$2"; shift 2 ;;
        --pg-port)             PG_PORT="$2"; shift 2 ;;
        --pg-schema)           PG_SCHEMA="$2"; shift 2 ;;
        --pg-ssl)              PG_SSL=1; shift ;;
        --pg-vector-index)     PG_VIDX="$2"; shift 2 ;;
        --pg-text-config)      PG_TEXTCFG="$2"; shift 2 ;;
        --llm-base-url)        LLM_BASE="$2"; shift 2 ;;
        --llm-api-key)         LLM_KEY="$2"; shift 2 ;;
        --llm-model)           LLM_MODEL="$2"; shift 2 ;;
        --emb-provider)        EMB_PROVIDER="$2"; shift 2 ;;
        --emb-base-url)        EMB_BASE="$2"; shift 2 ;;
        --emb-api-key)         EMB_KEY="$2"; shift 2 ;;
        --emb-model)           EMB_MODEL="$2"; shift 2 ;;
        --emb-dimensions)      EMB_DIM="$2"; shift 2 ;;
        -h|--help)             usage; exit 0 ;;
        *) die "未知参数: $1（-h 查看帮助）" ;;
    esac
done

# ─── 判断是否进入交互模式 ───
HAS_CONFIG_ARGS=0
if [[ -n "$PG_DB" || -n "$LLM_BASE" || -n "$EMB_PROVIDER" ]]; then
    HAS_CONFIG_ARGS=1
fi

if [[ $DO_UNINSTALL -eq 0 ]]; then
    # 范围未指定 → 交互选择
    if [[ -z "$SCOPE" ]]; then
        if is_interactive; then
            interactive_scope
        else
            die "必须指定安装范围：--user 或 --project [path]"
        fi
    fi

    # 已传配置参数 → 跳过交互；未传且可交互 → 进入向导
    if [[ $HAS_CONFIG_ARGS -eq 0 ]]; then
        if is_interactive; then
            echo
            printf "${BOLD}${CYAN}╔══════════════════════════════════════════╗${NC}\n"
            printf "${BOLD}${CYAN}║  TencentDB Agent Memory — 安装向导      ║${NC}\n"
            printf "${BOLD}${CYAN}╚══════════════════════════════════════════╝${NC}\n"
            echo
            hint "  本向导将引导你完成 Skill 安装及 PG/LLM/Embedding 配置。\n"
            hint "  若某项尚未准备好，可输入 skip 跳过，稍后手动配置。\n"
            hint "  密码类输入不会回显，按回车确认。\n\n"

            # 第一步：检查并安装项目依赖
            check_deps_installed
            echo

            interactive_storage
            interactive_llm
            interactive_embedding
            interactive_review
        fi
    else
        # 命令行传参模式：静默检查依赖
        check_deps_installed || true
    fi
fi

[[ -n "$SCOPE" ]] || die "必须指定安装范围：--user 或 --project [path]"

USER_HOME="${HOME:-$(eval echo "~$(whoami)")}"

# ─── 解析目标目录 + session_key ───
if [[ "$SCOPE" == "user" ]]; then
    DEST_BASE="$USER_HOME/.codebuddy/skills"
    SESSION_KEY="codebuddy:global"
else
    local_ws="${WORKSPACE:-$PWD}"
    [[ -d "$local_ws" ]] || die "workspace 不存在: $local_ws"
    WS_ABS="$(cd "$local_ws" && pwd)"
    DEST_BASE="$WS_ABS/.codebuddy/skills"
    # 由工作区绝对路径稳定派生短哈希
    WS_HASH="$(printf '%s' "$WS_ABS" | python3 -c 'import hashlib,sys; print(hashlib.sha1(sys.stdin.read().encode()).hexdigest()[:12])')"
    SESSION_KEY="codebuddy:proj:$WS_HASH"
fi
DEST="$DEST_BASE/$SKILL_NAME"

# ─── 卸载 ───
if [[ $DO_UNINSTALL -eq 1 ]]; then
    if [[ -e "$DEST" || -L "$DEST" ]]; then
        if [[ $DRY_RUN -eq 1 ]]; then
            log "[dry-run] would remove $DEST"
        else
            rm -rf "$DEST"
            log "已卸载: $DEST"
        fi
    else
        log "未发现已安装的 Skill: $DEST"
    fi
    exit 0
fi

# ─── 安装 ───
echo
header "开始安装"
echo
log "范围      : $SCOPE"
log "源目录    : $SKILL_SRC"
log "目标目录  : $DEST"
log "session_key: $SESSION_KEY"
[[ -f "$CTL_SRC" ]] || warn "未找到 ctl.sh: $CTL_SRC（gateway 自启动将不可用）"

if [[ $DRY_RUN -eq 1 ]]; then
    log "[dry-run] would mkdir -p $DEST_BASE"
    if [[ $USE_LINK -eq 1 ]]; then
        log "[dry-run] would symlink $DEST -> $SKILL_SRC"
    else
        log "[dry-run] would copy $SKILL_SRC -> $DEST"
    fi
    log "[dry-run] would write $DEST/scripts/.session-scope = $SESSION_KEY"
    log "[dry-run] would write $DEST/scripts/.gateway-ctl-path = $CTL_SRC"
else
    mkdir -p "$DEST_BASE"
    rm -rf "$DEST" 2>/dev/null || true
    if [[ $USE_LINK -eq 1 ]]; then
        ln -s "$SKILL_SRC" "$DEST"
        log "已软链 Skill -> $DEST"
    else
        cp -R "$SKILL_SRC" "$DEST"
        log "已复制 Skill -> $DEST"
    fi
    printf '%s\n' "$SESSION_KEY" > "$DEST/scripts/.session-scope"
    chmod 0644 "$DEST/scripts/.session-scope"
    if [[ -f "$CTL_SRC" ]]; then
        printf '%s\n' "$CTL_SRC" > "$DEST/scripts/.gateway-ctl-path"
        chmod 0644 "$DEST/scripts/.gateway-ctl-path"
    fi
    chmod +x "$DEST/scripts/gateway-up.sh" "$DEST/scripts/memory-client.mjs" 2>/dev/null || true
fi

# ─── 引导写配置（委托 ctl.sh）───
run_ctl() {
    if [[ ! -f "$CTL_SRC" ]]; then warn "ctl.sh 缺失，跳过配置写入"; return 0; fi
    local extra=(); [[ $DRY_RUN -eq 1 ]] && extra+=(--dry-run)
    bash "$CTL_SRC" "${extra[@]}" "$@"
}

header "写入配置"

# 存储后端
if [[ "$STORE_BACKEND" == "sqlite" ]]; then
    log "存储后端 → SQLite（本地）"
    run_ctl config vdb-off
elif [[ "$STORE_BACKEND" == "postgres" ]]; then
    log "存储后端 → PostgreSQL"
    pg_args=(config postgres --database "$PG_DB" --user "$PG_USER")
    [[ -n "$PG_PASSWORD" ]] && pg_args+=(--password "$PG_PASSWORD")
    [[ -n "$PG_HOST"     ]] && pg_args+=(--host "$PG_HOST")
    [[ -n "$PG_PORT"     ]] && pg_args+=(--port "$PG_PORT")
    [[ -n "$PG_SCHEMA"   ]] && pg_args+=(--schema "$PG_SCHEMA")
    [[ $PG_SSL -eq 1     ]] && pg_args+=(--ssl)
    [[ -n "$PG_VIDX"     ]] && pg_args+=(--vector-index "$PG_VIDX")
    [[ -n "$PG_TEXTCFG"  ]] && pg_args+=(--text-config "$PG_TEXTCFG")
    run_ctl "${pg_args[@]}"
else
    warn "未选择存储后端；稍后请运行:"
    hint "  bash $CTL_SRC config vdb-off     # SQLite\n"
    hint "  bash $CTL_SRC config postgres ...   # PostgreSQL\n"
fi

# LLM（L1 提取必需）
if [[ -n "$LLM_BASE" && -n "$LLM_KEY" && -n "$LLM_MODEL" ]]; then
    log "LLM → tdai-gateway.json"
    run_ctl config llm --api-key "$LLM_KEY" --base-url "$LLM_BASE" --model "$LLM_MODEL"
else
    warn "未提供完整 LLM；稍后请运行:"
    hint "  bash $CTL_SRC config llm ...\n"
fi

# Embedding（向量召回必需）
if [[ -n "$EMB_PROVIDER" ]]; then
    if [[ "$EMB_PROVIDER" == "none" ]]; then
        log "Embedding: none（仅关键词检索）"
        run_ctl config embedding --provider none
    elif [[ -n "$EMB_BASE" && -n "$EMB_KEY" && -n "$EMB_MODEL" && -n "$EMB_DIM" ]]; then
        log "Embedding → tdai-gateway.json"
        run_ctl config embedding --provider "$EMB_PROVIDER" --api-key "$EMB_KEY" \
            --base-url "$EMB_BASE" --model "$EMB_MODEL" --dimensions "$EMB_DIM"
    else
        warn "Embedding 参数不完整；已跳过"
    fi
else
    warn "未提供 Embedding；稍后请运行:"
    hint "  bash $CTL_SRC config embedding ...\n"
fi

# 重启使配置生效
if [[ $RESTART -eq 1 ]]; then
    log "重启 Gateway…"
    run_ctl restart || warn "重启失败，请手动: bash $CTL_SRC restart"
fi

if [[ "$SCOPE" == "user" ]]; then
    SCOPE_DESC="用户级（跨项目共享，session_key=${SESSION_KEY}）"
else
    SCOPE_DESC="项目级（按项目隔离，session_key=${SESSION_KEY}）"
fi

cat <<EOF

${BOLD}${GREEN}╔══════════════════════════════════════════╗
║  ✔  安装完成                             ║
╚══════════════════════════════════════════╝${NC}

  记忆范围：${SCOPE_DESC}

  后续步骤：
    1. 确保 Gateway 在线：  bash "$DEST/scripts/gateway-up.sh"
    2. 健康检查：           node "$DEST/scripts/memory-client.mjs" health
    3. 配置详情见：         $DEST/references/configuration.md
    4. 如未配置 PG/LLM/Embedding，请参照上面 warn 提示补齐。
EOF
