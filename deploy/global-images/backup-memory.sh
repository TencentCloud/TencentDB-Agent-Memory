#!/usr/bin/env bash
# ============================================================
# 备份 / 恢复 TencentDB-Agent-Memory 本地数据
# ------------------------------------------------------------
# 数据实际存放在 Docker volume（Linux 盘）：
#   tdai-memory-core-data → /var/lib/docker/volumes/tdai-memory-core-data/_data
# 宿主机（Windows）不能直接按路径访问，必须经 docker 导出。
#
# 用法：
#   ./backup-memory.sh                      # 备份到 ./backups/<时间戳>/
#   ./backup-memory.sh /path/to/dir         # 指定备份目录
#   ./backup-memory.sh --restore <备份目录>  # 从备份恢复
# ============================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Git-Bash 会把 /c/... 自动转成 C:\...；docker cp / docker run -v 需要 Windows 路径，
# 但 MSYS2_ARG_CONV_EXCL="*" 又会关掉自动转换。这里两边都要照顾：
#   * 容器内路径（/tmp/x）必须保持原样 → 用 MSYS2_ARG_CONV_EXCL
#   * 宿主机路径必须转成 Windows 形式 → 显式 cygpath
export MSYS2_ARG_CONV_EXCL="*"

CONTAINER=tdai-memory-core
PROXY=tdai-proxy
VOLUME=tdai-memory-core-data
STAMP="$(date +%Y%m%d-%H%M%S)"

to_win() { cygpath -w "$1" 2>/dev/null || echo "$1"; }

# ── 参数解析：--restore <dir> / --keep <N> / --keep=N / <dir> ──
MODE="backup"
POSITIONAL=()
KEEP=7
while [[ $# -gt 0 ]]; do
  case "$1" in
    --restore) MODE="restore"; shift ;;
    --keep=*)  KEEP="${1#--keep=}"; shift ;;
    --keep)    shift; KEEP="${1:-7}"; [[ $# -gt 0 ]] && shift ;;
    -h|--help) MODE="help"; shift ;;
    *)         POSITIONAL+=("$1"); shift ;;
  esac
done
[[ "$KEEP" =~ ^[0-9]+$ ]] || KEEP=7

BACKUP_ROOT="$SCRIPT_DIR/backups"

prune_backups() {
  [[ -d "$BACKUP_ROOT" ]] || return 0
  local keep="$1" dir base
  # 只清理符合 <时间戳> 命名的目录，不动其它文件
  mapfile -t dirs < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended       -regex '.*/[0-9]{8}-[0-9]{6}' -printf '%T@ %p
' 2>/dev/null | sort -rn | cut -d' ' -f2-)
  local total="${#dirs[@]}"
  (( total <= keep )) && return 0
  for (( i = keep; i < total; i++ )); do
    dir="${dirs[$i]}"
    base="$(basename "$dir")"
    rm -rf "$dir" && echo "  [prune] 删除旧备份 $base"
  done
}

# ───────────────────────── 恢复 ─────────────────────────
if [[ "$MODE" == "help" ]]; then
  cat <<EOF
用法：
  ./backup-memory.sh [--dir <目录>] [--keep <N>]
  ./backup-memory.sh --restore <备份目录>

选项：
  --dir <目录>   指定备份输出目录（默认 ./backups/<时间戳>）
  --keep <N>     保留最近 N 份备份并清理旧的（默认 7）
  --restore      从备份恢复（覆盖 volume 全部数据）
EOF
  exit 0
fi

if [[ "$MODE" == "restore" ]]; then
  SRC="${POSITIONAL[0]:?用法: ./backup-memory.sh --restore <备份目录>}"
  [[ -d "$SRC" ]] || { echo "[error] 备份目录不存在: $SRC" >&2; exit 1; }
  SRC_WIN="$(to_win "$SRC")"
  echo "▶ 从备份恢复：$SRC"
  read -r -p "  确认覆盖 volume $VOLUME 的全部数据？输入 yes 继续: " ans
  [[ "$ans" == "yes" ]] || { echo "  已取消"; exit 1; }

  docker run --rm -v "$VOLUME":/dst -v "$SRC_WIN":/src:ro alpine \
    sh -c "rm -rf /dst/* && cp -a /src/. /dst/ && echo '  已写回 volume'"
  echo "  [ok] 数据已恢复，请重启容器：bash start-memory-core.sh"
  exit 0
fi

# ───────────────────────── 备份 ─────────────────────────
DEST="${POSITIONAL[0]:-$SCRIPT_DIR/backups/$STAMP}"
mkdir -p "$DEST"
DEST_WIN="$(to_win "$DEST")"

echo "▶ 备份 memory-core 数据 → $DEST"

# 1) WAL checkpoint：把 WAL 合并进主库，减小导出体积、保证一致性
echo "  [1/3] WAL checkpoint"
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  docker exec "$CONTAINER" node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('/data/tdai-memory/vectors.db');
    try { console.log('    checkpoint:', JSON.stringify(db.prepare('pragma wal_checkpoint(TRUNCATE)').get())); }
    catch (e) { console.log('    skipped:', e.message); }
    db.close();
  " 2>/dev/null | grep -v Experimental || true
else
  echo "    ($CONTAINER 未运行，跳过)"
fi

# 2) 导出整个 volume（SQLite 主库 + WAL + profiles/sessions/records/skills 等）
echo "  [2/3] 导出 volume $VOLUME"
docker run --rm -v "$VOLUME":/src:ro -v "$DEST_WIN":/dst alpine \
  tar czf /dst/data.tar.gz -C /src . 2>/dev/null
echo "    -> $DEST/data.tar.gz ($(du -h "$DEST/data.tar.gz" | cut -f1))"

# 3) 导出 proxy 的 SQLite（会话绑定 / 注入缓存）
#    用 node:sqlite 的 VACUUM INTO 做一致性快照：不需停服务，也不依赖 sqlite3 CLI
echo "  [3/3] 导出 proxy 数据"
if docker ps --format '{{.Names}}' | grep -qx "$PROXY"; then
  docker exec "$PROXY" sh -c "rm -f /tmp/proxy-snap.db" 2>/dev/null || true
  docker exec "$PROXY" node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('/data/tdai-memory-proxy/proxy.db');
    try { db.prepare(\"VACUUM INTO '/tmp/proxy-snap.db'\").run(); console.log('    snapshot ok'); }
    catch (e) { console.log('    snapshot failed: ' + e.message); }
    db.close();
  " 2>/dev/null | grep -v Experimental || true
  docker cp "$PROXY":/tmp/proxy-snap.db "$DEST_WIN/proxy.db" >/dev/null 2>&1 \
    && echo "    -> $DEST/proxy.db (VACUUM INTO 一致性快照)" \
    || echo "    (proxy 数据导出跳过)"
  docker exec "$PROXY" sh -c "rm -f /tmp/proxy-snap.db" 2>/dev/null || true
else
  echo "    ($PROXY 未运行，跳过)"
fi

# 4) 附带配置与密钥（仅本机，不入库 —— backups/ 已在 .gitignore）
cp .env.example "$DEST_WIN/.env.example" 2>/dev/null || true
cp .admin-key "$DEST_WIN/.admin-key" 2>/dev/null || true

cat > "$DEST_WIN/RESTORE.txt" <<EOF
恢复到本机：
  cd $SCRIPT_DIR
  bash backup-memory.sh --restore "$DEST"

或手工恢复：
  docker run --rm -v $VOLUME:/dst -v "$(to_win "$DEST")":/src:ro alpine \\
    sh -c "rm -rf /dst/* && cp -a /src/. /dst/"
  bash start-memory-core.sh
EOF

echo
echo "[ok] 备份完成 -> $DEST"
ls -la "$DEST" | tail -8

# 5) 清理旧备份（保留最近 KEEP 份）
prune_backups "$KEEP"
echo "  保留策略：最近 $KEEP 份（目录 $BACKUP_ROOT）"
