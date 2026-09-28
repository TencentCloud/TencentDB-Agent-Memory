#!/usr/bin/env bash
# OpenClaw + memory-tencentdb（原 memory-tdai）诊断数据导出脚本
# 注：插件已更名为 memory-tencentdb，但数据目录始终为 memory-tdai（代码硬编码）
# 用法: bash export-diagnostic.sh [输出目录]
# 默认输出到 ~/Downloads/openclaw-diagnostic-<timestamp>/

set -euo pipefail

# ── 参数 ──
OUTPUT_BASE="${1:-$HOME/Downloads}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
EXPORT_DIR="${OUTPUT_BASE}/openclaw-diagnostic-${TIMESTAMP}"
ARCHIVE_PATH="${EXPORT_DIR}.tar.gz"

# ── OpenClaw 工作目录探测 ──
if [ -n "${OPENCLAW_STATE_DIR:-}" ]; then
  STATE_DIR="$OPENCLAW_STATE_DIR"
elif [ -d "$HOME/.openclaw" ]; then
  STATE_DIR="$HOME/.openclaw"
elif [ -d "$HOME/.clawdbot" ]; then
  STATE_DIR="$HOME/.clawdbot"
else
  echo "❌ 未找到 OpenClaw 工作目录 (~/.openclaw 或 ~/.clawdbot)"
  exit 1
fi

echo "📂 OpenClaw 工作目录: $STATE_DIR"
echo "📦 导出目录: $EXPORT_DIR"

# Guard against directory traversal in output path
case "$EXPORT_DIR" in
  /|/..|../*) echo "❌ Unsafe output path. Aborting."; exit 1 ;;
esac
mkdir -p "$EXPORT_DIR"

# ── 1. 收集环境信息 ──
echo "🔍 收集环境信息..."
{
  echo "=== 导出时间 ==="
  date -Iseconds 2>/dev/null || date
  echo ""
  echo "=== 系统信息 ==="
  echo "OS: $(uname -a)"
  echo "Node: $(node --version 2>/dev/null || echo 'not found')"
  echo "pnpm: $(pnpm --version 2>/dev/null || echo 'not found')"
  echo ""
  echo "=== OpenClaw 版本 ==="
  openclaw --version 2>/dev/null || pnpm openclaw --version 2>/dev/null || echo "(unknown)"
  echo ""
  echo "=== 工作目录 ==="
  echo "STATE_DIR: $STATE_DIR"
  echo ""
  echo "=== 目录结构 ==="
  ls -la "$STATE_DIR/" 2>/dev/null || echo "(empty)"
  echo ""
  echo "=== memory-tdai 目录结构 ==="
  ls -laR "$STATE_DIR/memory-tdai/" 2>/dev/null || echo "(not found)"
  echo ""
  echo "=== 磁盘占用 ==="
  du -sh "$STATE_DIR/memory-tdai/"* 2>/dev/null || echo "(not found)"
} > "$EXPORT_DIR/env-info.txt" 2>&1

# ── 2. 收集 OpenClaw 日志 ──
echo "📋 收集 OpenClaw 日志..."
mkdir -p "$EXPORT_DIR/logs"

# 网关日志 (~/.openclaw/logs/)
if [ -d "$STATE_DIR/logs" ]; then
  cp -r "$STATE_DIR/logs/" "$EXPORT_DIR/logs/gateway-logs/" 2>/dev/null || true
fi

# 滚动日志 (/tmp/openclaw/)
TMP_LOG_DIR="/tmp/openclaw"
if [ -d "$TMP_LOG_DIR" ]; then
  mkdir -p "$EXPORT_DIR/logs/rolling-logs"
  # 只取最近 3 个日志文件
  ls -t "$TMP_LOG_DIR"/openclaw-*.log 2>/dev/null | head -3 | while read -r f; do
    # 每个文件只取最后 5000 行，避免过大
    tail -5000 "$f" > "$EXPORT_DIR/logs/rolling-logs/$(basename "$f")" 2>/dev/null || true
  done
fi

# ── 3. 收集记忆插件数据 ──
# 注：数据目录名为 memory-tdai（历史原因，插件更名为 memory-tencentdb 后未改目录名）
echo "🧠 收集记忆插件数据..."
MEMORY_DIR="$STATE_DIR/memory-tdai"
if [ -d "$MEMORY_DIR" ]; then
  mkdir -p "$EXPORT_DIR/memory-tdai"

  # L0 对话记录 (JSONL)
  if [ -d "$MEMORY_DIR/conversations" ]; then
    cp -r "$MEMORY_DIR/conversations/" "$EXPORT_DIR/memory-tdai/conversations/" 2>/dev/null || true
  fi

  # L1 结构化记忆 (JSONL)
  if [ -d "$MEMORY_DIR/records" ]; then
    cp -r "$MEMORY_DIR/records/" "$EXPORT_DIR/memory-tdai/records/" 2>/dev/null || true
  fi

  # L2 场景文件 (Markdown)
  if [ -d "$MEMORY_DIR/scene_blocks" ]; then
    cp -r "$MEMORY_DIR/scene_blocks/" "$EXPORT_DIR/memory-tdai/scene_blocks/" 2>/dev/null || true
  fi

  # L3 用户画像
  [ -f "$MEMORY_DIR/persona.md" ] && cp "$MEMORY_DIR/persona.md" "$EXPORT_DIR/memory-tdai/" 2>/dev/null || true

  # checkpoint + scene_index
  if [ -d "$MEMORY_DIR/.metadata" ]; then
    cp -r "$MEMORY_DIR/.metadata/" "$EXPORT_DIR/memory-tdai/.metadata/" 2>/dev/null || true
  fi

  # SQLite 数据库（用于检查向量/FTS索引状态）
  [ -f "$MEMORY_DIR/vectors.db" ] && cp "$MEMORY_DIR/vectors.db" "$EXPORT_DIR/memory-tdai/" 2>/dev/null || true

  # 备份目录（可选，可能较大）
  if [ -d "$MEMORY_DIR/.backup" ]; then
    cp -r "$MEMORY_DIR/.backup/" "$EXPORT_DIR/memory-tdai/.backup/" 2>/dev/null || true
  fi
else
  echo "  ⚠️ 未找到 memory-tdai 数据目录（memory-tencentdb 插件的数据也存储在此目录）"
fi

# ── 4. 收集 OpenClaw 配置（脱敏） ──
echo "🔧 收集 OpenClaw 配置（已脱敏）..."
CONFIG_FILE="$STATE_DIR/openclaw.json"
if [ -f "$CONFIG_FILE" ]; then
  # 使用 node 脱敏处理配置
  node -e "
    const fs = require('fs');
    const JSON5 = (() => { try { return require('json5'); } catch { return JSON; } })();
    const raw = fs.readFileSync('$CONFIG_FILE', 'utf-8');
    let cfg;
    try { cfg = JSON5.parse(raw); } catch { cfg = JSON.parse(raw); }

    // 递归脱敏函数
    function redact(obj, path) {
      if (!obj || typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map((v, i) => redact(v, path + '[' + i + ']'));
      const result = {};
      for (const [k, v] of Object.entries(obj)) {
        const fullPath = path ? path + '.' + k : k;
        // 脱敏规则：API key、token、password、secret 类字段
        if (/api_?key|token|password|secret|credential/i.test(k) && typeof v === 'string') {
          result[k] = v.length > 0 ? '***REDACTED(' + v.length + 'chars)***' : '';
        }
        // 脱敏 SecretRef 对象
        else if (v && typeof v === 'object' && v.source && v.id && v.provider) {
          result[k] = { source: v.source, provider: v.provider, id: '***REDACTED***' };
        }
        // 整体跳过的顶层敏感块
        else if (['models', 'secrets', 'channels', 'env'].includes(k) && !path) {
          result[k] = '***REDACTED_SECTION(use openclaw config get ' + k + ' to inspect)***';
        }
        // gateway.auth 内的 token/password
        else if (path === 'gateway.auth' && /token|password/i.test(k)) {
          result[k] = typeof v === 'string' ? '***REDACTED***' : v;
        }
        else {
          result[k] = redact(v, fullPath);
        }
      }
      return result;
    }

    const redacted = redact(cfg, '');
    // plugins 已经过递归 redact()，其中 apiKey/token/password/secret 等字段
    // 会被自动脱敏，同时保留 provider/model/enabled 等排查所需的非敏感配置

    fs.writeFileSync('$EXPORT_DIR/openclaw-config-redacted.json', JSON.stringify(redacted, null, 2));
    console.log('  ✅ 配置已脱敏导出');
  " 2>&1 || {
    echo "  ⚠️ Node 脱敏失败，使用 grep 粗略脱敏"
    # 写入敏感模式到临时文件（避免 shell injection via grep -E pattern）
    TEMP_PATTERN=$(mktemp)
    printf '%s\n' \
      'api.?key[[:space:]]*:' \
      'token[[:space:]]*:' \
      'password[[:space:]]*:' \
      'secret[[:space:]]*:' \
      'credential[[:space:]]*:' \
      > "$TEMP_PATTERN"
    grep -v -iE -f "$TEMP_PATTERN" "$CONFIG_FILE" \
      | sed -E 's/"(models|secrets|channels|env)"[[:space:]]*:[[:space:]]*\{[^}]*\}/"__REDACTED_SECTION__"/g' \
      > "$EXPORT_DIR/openclaw-config-redacted.json" 2>/dev/null || true
    rm -f "$TEMP_PATTERN"
  }
else
  echo "  ⚠️ 未找到配置文件"
fi

# ── 5. 收集插件安装信息 ──
echo "🔌 收集插件安装信息..."
if [ -d "$STATE_DIR/extensions" ]; then
  {
    echo "=== 已安装插件 ==="
    ls -la "$STATE_DIR/extensions/" 2>/dev/null
    echo ""
    for ext_dir in "$STATE_DIR/extensions"/*/; do
      [ -d "$ext_dir" ] || continue
      pkg="$ext_dir/node_modules/openclaw/package.json"
      plugin_pkg="$ext_dir/package.json"
      echo "--- $(basename "$ext_dir") ---"
      if [ -f "$plugin_pkg" ]; then
        node -e "const p=require('$plugin_pkg'); console.log('name:', p.name, 'version:', p.version)" 2>/dev/null || true
      fi
    done
  } > "$EXPORT_DIR/plugins-info.txt" 2>&1
fi

# ── 6. 打包 ──
echo "📦 打包中..."
# Guard: reject archive paths starting with '-' to prevent tar flag injection
# (tar interprets arguments starting with '-' as flags regardless of position)
if [[ "$ARCHIVE_PATH" == -* ]]; then
  echo "❌ Archive path cannot start with '-'. Aborting to prevent tar injection."
  exit 1
fi
cd "$(dirname "$EXPORT_DIR")"
tar -czfP -- "$ARCHIVE_PATH" "$(basename "$EXPORT_DIR")"

# 计算大小
ARCHIVE_SIZE=$(du -sh "$ARCHIVE_PATH" | cut -f1)

echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✅ 诊断数据导出完成"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  📦 压缩包: $ARCHIVE_PATH"
echo "  📏 大小: $ARCHIVE_SIZE"
echo ""
echo "  包含内容:"
echo "    - env-info.txt          — 环境信息、目录结构"
echo "    - logs/                 — OpenClaw 网关日志 + 滚动日志"
echo "    - memory-tdai/          — 记忆插件全量数据 (L0~L3 + SQLite)"
echo "    - openclaw-config-redacted.json — 脱敏后的配置文件"
echo "    - plugins-info.txt      — 插件安装信息"
echo ""
echo "  ⚠️ 安全提示:"
echo "    - 配置文件已自动脱敏（API Key、Token、Password 等已移除）"
echo "    - models/secrets/channels/env 等敏感配置块已整体替换"
echo "    - 记忆数据中可能包含用户对话内容，请确认后再发送"
echo ""
echo "  📤 请手动检查后发送给研发团队"
echo "═══════════════════════════════════════════════════"
