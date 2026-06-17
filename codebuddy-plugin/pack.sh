#!/usr/bin/env bash
#
# pack.sh — 打包 memory-tencentdb Skill + T-A-M Gateway 为一个可分发的 zip。
#
# 输出:
#   dist/memory-tencentdb-skill-v<version>.zip
#
# 包含两部分:
#   memory-tencentdb/    Skill 文件（解压到 CodeBuddy skills 目录即可用）
#   tam-gateway/         T-A-M Gateway 运行时（解压到 ~/.memory-tencentdb/）
#
# 用法:
#   bash pack.sh           # 从当前 git tag / package.json 获取版本号
#   bash pack.sh -o out    # 输出到指定目录
#   bash pack.sh -v 1.0.0  # 指定版本号

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_SRC="$REPO_ROOT/codebuddy-plugin/memory-tencentdb"
OUT_DIR="$REPO_ROOT/dist"
VERSION=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -o) OUT_DIR="$2"; shift 2 ;;
        -v) VERSION="$2"; shift 2 ;;
        *) echo "用法: bash pack.sh [-o out_dir] [-v version]"; exit 1 ;;
    esac
done

if [[ -z "$VERSION" ]]; then
    VERSION=$(python3 -c "import json; print(json.load(open('$REPO_ROOT/package.json')).get('version','0.0.0'))" 2>/dev/null) || VERSION="0.0.0"
fi

ZIP_NAME="memory-tencentdb-skill-v${VERSION}.zip"
BUILD_DIR="$REPO_ROOT/.pack-tmp"
STAGING="$BUILD_DIR/staging"
SKILL_STAGING="$STAGING/memory-tencentdb"
GW_STAGING="$STAGING/tam-gateway"

log()   { printf '\033[0;32m[pack]\033[0m %s\n' "$*"; }
warn()  { printf '\033[0;33m[pack:warn]\033[0m %s\n' "$*" >&2; }
die()   { printf '\033[0;31m[pack:error]\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() { rm -rf "$BUILD_DIR"; }
trap cleanup EXIT

# ─── 阶段 1: 复制 Skill 文件 ───
log "阶段 1/3: 复制 Skill 文件…"
rm -rf "$STAGING" && mkdir -p "$SKILL_STAGING/scripts" "$SKILL_STAGING/references"

cp "$SKILL_SRC/SKILL.md"   "$SKILL_STAGING/"
cp "$SKILL_SRC/README.md"  "$SKILL_STAGING/"
cp "$SKILL_SRC/scripts/memory-client.mjs" "$SKILL_STAGING/scripts/"
cp "$SKILL_SRC/scripts/gateway-up.sh"     "$SKILL_STAGING/scripts/"
cp "$SKILL_SRC/references/configuration.md"   "$SKILL_STAGING/references/"
cp "$SKILL_SRC/references/troubleshooting.md" "$SKILL_STAGING/references/"
chmod +x "$SKILL_STAGING/scripts/memory-client.mjs" "$SKILL_STAGING/scripts/gateway-up.sh"

log "  Skill: $(find "$SKILL_STAGING" -type f | wc -l | tr -d ' ') 文件"

# ─── 阶段 2: 复制 T-A-M Gateway 运行时 ───
log "阶段 2/3: 复制 Gateway 运行时…"
rm -rf "$GW_STAGING" && mkdir -p "$GW_STAGING/scripts" "$GW_STAGING/bin"

# package.json（去除 devDependencies/openclaw 插件字段，保留运行时依赖）
python3 -c "
import json
pkg = json.load(open('$REPO_ROOT/package.json'))
pkg.pop('devDependencies', None)
pkg.pop('scripts', None)
pkg.pop('openclaw', None)
pkg.pop('files', None)
pkg.pop('keywords', None)
pkg['scripts'] = {'postinstall': 'echo \"T-A-M Gateway 已就绪\"'}
json.dump(pkg, open('$GW_STAGING/package.json', 'w'), indent=2, ensure_ascii=False)
"

# src/ 目录（全量，排除测试文件）
rsync -a --exclude='*.test.ts' --exclude='*.spec.ts' \
    --exclude='__tests__/' --exclude='*.test.js' \
    "$REPO_ROOT/src/" "$GW_STAGING/src/"

# ctl.sh（核心运维脚本）
cp "$REPO_ROOT/scripts/memory-tencentdb-ctl.sh" "$GW_STAGING/scripts/"
cp "$REPO_ROOT/scripts/README.memory-tencentdb-ctl.md" "$GW_STAGING/scripts/" 2>/dev/null || true

# bin/ 目录（CLI 入口 .mjs）
cp "$REPO_ROOT/bin/"*.mjs "$GW_STAGING/bin/" 2>/dev/null || true

# index.ts（tsx 入口依赖）
cp "$REPO_ROOT/index.ts" "$GW_STAGING/"

# 确保可执行
chmod +x "$GW_STAGING/scripts/memory-tencentdb-ctl.sh"

# 打包 node_modules 要排除的列表（供用户在自己的机器上 npm install）
cat > "$GW_STAGING/.npm-install-note" <<'EOF'
解压后请在此目录执行:
  npm install --no-audit --no-fund
或
  npm install --production --no-audit --no-fund
EOF

log "  Gateway: $(find "$GW_STAGING" -type f | wc -l | tr -d ' ') 文件"

# ─── 阶段 3: 注入独立安装脚本 ───
log "阶段 3/3: 注入独立安装脚本…"

cat > "$STAGING/install.sh" <<'INSTALL_SCRIPT'
#!/usr/bin/env bash
#
# install.sh — memory-tencentdb Skill 独立安装脚本（与打包 zip 配套使用）
#
# 用法：
#   在解压后的目录运行:
#     bash install.sh
#   或指定 Skill 安装范围:
#     bash install.sh --user          # 用户级（跨项目共享记忆）
#     bash install.sh --project       # 项目级（当前目录 .codebuddy/skills）
#
# 环境要求：
#   - Node.js >= 20
#   - npm（或其他包管理器）

set -euo pipefail

# 使用 $0 而非 BASH_SOURCE，兼容 sh / bash 两种运行方式
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"  # 确保在解压目录中执行

SKILL_SRC="$SCRIPT_DIR/memory-tencentdb"
GW_SRC="$SCRIPT_DIR/tam-gateway"
GW_INSTALL_DIR="${MEMORY_TENCENTDB_ROOT:-$HOME/.memory-tencentdb}/tdai-memory-openclaw-plugin"

SCOPE=""
PROJECT_WORKSPACE=""
DRY_RUN=0
NON_INTERACTIVE=0
RESTART=0

# ─── 颜色（使用 %b 强制解析反斜杠转义，兼容 sh/bash）───
if [[ -t 1 ]]; then
    BLD='\033[1m'; DIM='\033[2m'; GRN='\033[0;32m'; YLW='\033[0;33m'
    CYN='\033[0;36m'; RED='\033[0;31m'; NC='\033[0m'
else
    BLD='' DIM='' GRN='' YLW='' CYN='' RED='' NC=''
fi
log()   { printf '%b[install]%b %s\n' "$GRN" "$NC" "$*"; }
warn()  { printf '%b[install:warn]%b %s\n' "$YLW" "$NC" "$*" >&2; }
err()   { printf '%b[install:error]%b %s\n' "$RED" "$NC" "$*" >&2; }
header(){ printf '\n%b%b═══ %s ═══%b\n' "$BLD" "$CYN" "$*" "$NC"; }
prompt(){ printf '%b%s%b' "$BLD" "$*" "$NC"; }
hint()  { printf '%b%s%b' "$DIM" "$*" "$NC"; }
die()   { err "$*"; exit 1; }
is_tty() { [[ $NON_INTERACTIVE -eq 0 && -t 0 && -t 1 ]]; }

# ─── 参数解析 ───
while [[ $# -gt 0 ]]; do
    case "$1" in
        --user)             SCOPE="user"; shift ;;
        --project)
            SCOPE="project"
            [[ $# -ge 2 && "${2:-}" != --* ]] && { PROJECT_WORKSPACE="$2"; shift 2; } || shift
            ;;
        --workspace)        PROJECT_WORKSPACE="$2"; shift 2 ;;
        --dry-run)          DRY_RUN=1; shift ;;
        --non-interactive)  NON_INTERACTIVE=1; shift ;;
        --restart)          RESTART=1; shift ;;
        --help|-h)
            echo "用法: bash install.sh [--user|--project] [--dry-run] [--non-interactive] [--restart]"
            exit 0 ;;
        *) die "未知参数: $1" ;;
    esac
done

# 校验源文件存在
[[ -d "$SKILL_SRC" ]] || die "Skill 源目录缺失: $SKILL_SRC（请确保在解压后的目录中运行 bash install.sh）"
[[ -d "$GW_SRC" ]]   || die "Gateway 源目录缺失: $GW_SRC（请确保在解压后的目录中运行 bash install.sh）"

echo
printf '%b%b╔══════════════════════════════════════════╗%b\n' "$BLD" "$CYN" "$NC"
printf '%b%b║  T-A-M Memory Skill — 全量安装          ║%b\n' "$BLD" "$CYN" "$NC"
printf '%b%b╚══════════════════════════════════════════╝%b\n' "$BLD" "$CYN" "$NC"

# ─── 1. 安装 Gateway ───
header "安装 Gateway 运行时"

if [[ -d "$GW_INSTALL_DIR/node_modules" ]]; then
    log "Gateway 已安装在 $GW_INSTALL_DIR"
else
    log "安装 Gateway 到 $GW_INSTALL_DIR"
    if [[ $DRY_RUN -eq 1 ]]; then
        log "[dry-run] mkdir -p $GW_INSTALL_DIR && cp -R $GW_SRC/* -> $GW_INSTALL_DIR/"
        log "[dry-run] cd $GW_INSTALL_DIR && npm install --no-audit --no-fund"
    else
        [[ -d "$GW_SRC" ]] || die "Gateway 源目录缺失: $GW_SRC（请确保在解压后的目录中运行 install.sh）"
        mkdir -p "$(dirname "$GW_INSTALL_DIR")"
        rm -rf "$GW_INSTALL_DIR"
        cp -R "$GW_SRC" "$GW_INSTALL_DIR"
        chmod +x "$GW_INSTALL_DIR/scripts/memory-tencentdb-ctl.sh"

        log "安装 Node.js 依赖（npm install）…"
        if (cd "$GW_INSTALL_DIR" && npm install --no-audit --no-fund --omit=dev); then
            log "依赖安装成功"
        else
            warn "依赖安装失败，请手动: cd $GW_INSTALL_DIR && npm install"
        fi
    fi
fi

CTL_PATH="$GW_INSTALL_DIR/scripts/memory-tencentdb-ctl.sh"
[[ -f "$CTL_PATH" ]] || warn "ctl.sh 缺失: $CTL_PATH"

# ─── 2. 安装 Skill ───
header "安装 Skill"

if [[ -z "$SCOPE" ]]; then
    if is_tty; then
        echo "请选择 Skill 安装范围："
        echo "  1) 用户级（跨项目共享记忆 → ~/.codebuddy/skills/）"
        echo "  2) 项目级（当前项目隔离 → .codebuddy/skills/）"
        while true; do
            prompt "  选择 (1/2): "
            IFS= read -r REPLY
            case "${REPLY}" in
                1) SCOPE="user"; break ;;
                2) SCOPE="project"; break ;;
                *) err "请输入 1 或 2" ;;
            esac
        done
    else
        die "请用 --user 或 --project 指定安装范围"
    fi
fi

if [[ "$SCOPE" == "user" ]]; then
    DEST="$HOME/.codebuddy/skills/memory-tencentdb"
    SESSION_KEY="codebuddy:global"
else
    WS="${PROJECT_WORKSPACE:-$PWD}"
    DEST="$WS/.codebuddy/skills/memory-tencentdb"
    WS_HASH=$(printf '%s' "$WS" | python3 -c 'import hashlib,sys; print(hashlib.sha1(sys.stdin.read().encode()).hexdigest()[:12])')
    SESSION_KEY="codebuddy:proj:$WS_HASH"
fi

log "Skill → $DEST"
log "session_key: $SESSION_KEY"

if [[ $DRY_RUN -eq 1 ]]; then
    log "[dry-run] mkdir -p $(dirname "$DEST") && cp -R $SKILL_SRC -> $DEST"
    log "[dry-run] write .session-scope = $SESSION_KEY"
    log "[dry-run] write .gateway-ctl-path = $CTL_PATH"
else
    [[ -d "$SKILL_SRC" ]] || die "Skill 源目录缺失: $SKILL_SRC（请确保在解压后的目录中运行 install.sh）"
    mkdir -p "$(dirname "$DEST")"
    rm -rf "$DEST"
    cp -R "$SKILL_SRC" "$DEST"
    chmod +x "$DEST/scripts/memory-client.mjs" "$DEST/scripts/gateway-up.sh"

    printf '%s\n' "$SESSION_KEY" > "$DEST/scripts/.session-scope"
    printf '%s\n' "$CTL_PATH" > "$DEST/scripts/.gateway-ctl-path"
    chmod 644 "$DEST/scripts/.session-scope" "$DEST/scripts/.gateway-ctl-path"
fi

# ─── 3. 配置 PG/LLM/Embedding ───
header "配置 PostgreSQL / LLM / Embedding"

run_ctl() {
    if [[ ! -f "$CTL_PATH" ]]; then warn "ctl.sh 不可用"; return 0; fi
    local extra=(); [[ $DRY_RUN -eq 1 ]] && extra+=(--dry-run)
    bash "$CTL_PATH" "${extra[@]}" "$@" 2>&1 | sed 's/^/  [ctl] /'
}

if is_tty; then
    # 存储后端选择
    echo
    echo "  请选择记忆存储后端："
    echo "    1) SQLite（本地文件，零依赖，开箱即用）"
    echo "    2) PostgreSQL（pgvector，需 PG 服务）"
    echo "    3) 跳过（稍后手动配置）"
    while true; do
        printf '%b  选择 %b(1/2/3)%b: ' "$BLD" "$DIM" "$NC"
        IFS= read -r REPLY; REPLY="${REPLY:-1}"
        case "$REPLY" in
            1)
                log "存储后端 → SQLite（本地）"
                run_ctl config vdb-off
                break
                ;;
            2)
                printf '%b数据库名 %b[postgres]%b: '    "$BLD" "$DIM" "$NC"; IFS= read -r PG_DB;   PG_DB="${PG_DB:-postgres}"
                printf '%b用户名   %b[postgres]%b: '    "$BLD" "$DIM" "$NC"; IFS= read -r PG_USER; PG_USER="${PG_USER:-postgres}"
                printf '%b密码（不显示）%b: '              "$BLD" "$NC"         ; IFS= read -rs PG_PWD; echo
                printf '%b主机     %b[127.0.0.1]%b: '   "$BLD" "$DIM" "$NC"; IFS= read -r PG_HOST; PG_HOST="${PG_HOST:-127.0.0.1}"
                printf '%b端口     %b[5432]%b: '         "$BLD" "$DIM" "$NC"; IFS= read -r PG_PORT; PG_PORT="${PG_PORT:-5432}"
                printf '%bSchema   %b[agent_memory]%b: ' "$BLD" "$DIM" "$NC"; IFS= read -r PG_SCHEMA; PG_SCHEMA="${PG_SCHEMA:-agent_memory}"
                printf '%b中文分词 %b[simple/jieba]%b: ' "$BLD" "$DIM" "$NC"; IFS= read -r PG_TEXTCFG; PG_TEXTCFG="${PG_TEXTCFG:-simple}"
                hint "  simple=英文分词（默认），jieba=中文分词（需 pg_jieba 扩展）\n"
                args=(config postgres --database "$PG_DB" --user "$PG_USER" --host "$PG_HOST" --port "$PG_PORT" --schema "$PG_SCHEMA" --text-config "$PG_TEXTCFG")
                [[ -n "$PG_PWD" ]] && args+=(--password "$PG_PWD")
                run_ctl "${args[@]}"
                break
                ;;
            3) warn "跳过存储配置"; break ;;
            *) err "请输入 1、2 或 3" ;;
        esac
    done

    # LLM
    echo
    printf '%b是否配置 LLM（记忆提取必需）？ %b(Y/n/skip)%b: ' "$BLD" "$DIM" "$NC"
    IFS= read -r REPLY; REPLY="${REPLY:-y}"
    case "${REPLY,,}" in
        skip|s|n|no|否) warn "跳过 LLM 配置，稍后可运行: bash $CTL_PATH config llm ..." ;;
        *)
            printf '%bAPI Base URL%b: ' "$BLD" "$NC"; IFS= read -r LLM_URL
            printf '%bAPI Key（不显示）%b: ' "$BLD" "$NC"; IFS= read -rs LLM_KEY; echo
            printf '%b模型 %b[gpt-4o-mini]%b: ' "$BLD" "$DIM" "$NC"; IFS= read -r LLM_MODEL; LLM_MODEL="${LLM_MODEL:-gpt-4o-mini}"
            run_ctl config llm --api-key "$LLM_KEY" --base-url "$LLM_URL" --model "$LLM_MODEL"
            ;;
    esac

    # Embedding
    echo
    printf '%b是否配置 Embedding（向量召回必需）？ %b(Y/n/skip/none)%b: ' "$BLD" "$DIM" "$NC"
    IFS= read -r REPLY; REPLY="${REPLY:-y}"
    case "${REPLY,,}" in
        skip|s|n|no|否) warn "跳过 Embedding 配置" ;;
        none) run_ctl config embedding --provider none ;;
        *)
            printf '%b服务商%b: ' "$BLD" "$NC"; IFS= read -r EMB_PROV
            printf '%bAPI Base URL%b: ' "$BLD" "$NC"; IFS= read -r EMB_URL
            printf '%bAPI Key（不显示）%b: ' "$BLD" "$NC"; IFS= read -rs EMB_KEY; echo
            printf '%b模型 %b[text-embedding-3-small]%b: ' "$BLD" "$DIM" "$NC"; IFS= read -r EMB_MODEL; EMB_MODEL="${EMB_MODEL:-text-embedding-3-small}"
            printf '%b维度 %b[1536]%b: ' "$BLD" "$DIM" "$NC"; IFS= read -r EMB_DIM; EMB_DIM="${EMB_DIM:-1536}"
            run_ctl config embedding --provider "$EMB_PROV" --api-key "$EMB_KEY" --base-url "$EMB_URL" --model "$EMB_MODEL" --dimensions "$EMB_DIM"
            ;;
    esac
else
    warn "非交互模式，跳过配置引导。请手动运行:"
    hint "  bash $CTL_PATH config postgres --database D --user U ...\n"
    hint "  bash $CTL_PATH config llm --api-key K --base-url U --model M\n"
    hint "  bash $CTL_PATH config embedding --provider P --api-key K --base-url U --model M --dimensions D\n"
fi

# ─── 4. 重启 ───
if [[ $RESTART -eq 1 ]]; then
    run_ctl restart
fi

# ─── 完成 ───
if [[ "$SCOPE" == "user" ]]; then
    SD="用户级（跨项目共享）"
else
    SD="项目级（按项目隔离）"
fi

cat <<EOF

${BLD}${GRN}╔══════════════════════════════════════════╗
║  ✔  安装完成                             ║
╚══════════════════════════════════════════╝${NC}

  记忆范围   : ${SD} (session_key=${SESSION_KEY})
  Skill 路径 : $DEST
  Gateway    : $GW_INSTALL_DIR

  后续步骤:
    1. 确保 Gateway 在线:  bash $DEST/scripts/gateway-up.sh
    2. 健康检查:           node $DEST/scripts/memory-client.mjs health
    3. 配置详情:           $DEST/references/configuration.md
    4. 如未配 PG/LLM/Embedding，请按上面提示补齐
EOF
INSTALL_SCRIPT

chmod +x "$STAGING/install.sh"
log "  安装脚本: staging/install.sh"

# ─── 阶段 4: 打包 ───
log "打包 $ZIP_NAME …"
mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/$ZIP_NAME"

cd "$STAGING"
zip -qr "$OUT_DIR/$ZIP_NAME" .

# 统计
SKILL_COUNT=$(find "$SKILL_STAGING" -type f | wc -l | tr -d ' ')
GW_COUNT=$(find "$GW_STAGING" -type f | wc -l | tr -d ' ')
ZIP_SIZE=$(du -h "$OUT_DIR/$ZIP_NAME" | cut -f1)

log "完成: $OUT_DIR/$ZIP_NAME ($ZIP_SIZE)"
log "  Skill 文件: $SKILL_COUNT"
log "  Gateway 文件: $GW_COUNT"
log "  安装脚本: staging/install.sh"
log ""
log "使用方式:"
log "  unzip $ZIP_NAME -d /tmp/tam-skill"
log "  cd /tmp/tam-skill && bash install.sh --user"
