#!/usr/bin/env bash
set -euo pipefail

# ─── Knowledge Service 启动脚本 ───
# 自动处理 Node 版本、pnpm、better-sqlite3 编译等兼容性问题

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

NODE_VERSION="22.19.0"
NODE_PATH="/codev/opt/nodejs/${NODE_VERSION}/bin"
PYTHON_BIN="/usr/bin/python3.8"

echo "========================================"
echo "  Knowledge Service 启动脚本"
echo "========================================"

# ── Step 1: 检查/切换 Node 版本 ──
echo "[1/5] 检查 Node.js 版本..."
if [ ! -x "${NODE_PATH}/node" ]; then
  echo "  错误: 未找到 Node.js ${NODE_VERSION} (${NODE_PATH})"
  echo "  请先安装 Node.js ${NODE_VERSION}"
  exit 1
fi

export PATH="${NODE_PATH}:$PATH"
echo "  Node: $(node -v) ($(which node))"
echo "  npm:  $(npm -v)"

# ── Step 2: 安装 pnpm（如需要） ──
echo "[2/5] 检查 pnpm..."
if ! command -v pnpm &>/dev/null; then
  echo "  安装 pnpm@9.15.0..."
  npm install -g pnpm@9.15.0 2>&1 | tail -1
fi
echo "  pnpm: $(pnpm --version)"

# ── Step 3: 安装依赖 ──
echo "[3/5] 安装依赖..."
if [ ! -d "node_modules" ]; then
  PYTHON="${PYTHON_BIN}" npm_config_python="${PYTHON_BIN}" pnpm install --ignore-scripts
fi

# ── Step 4: 验证/准备 better-sqlite3 ──
# v13 起 better-sqlite3 在 npm 包内自带预编译二进制（N-API，跨 Node 大版本），
# 安装后通常可直接加载，无需本机编译；仅当平台/glibc 无匹配预编译时才回退源码编译。
echo "[4/5] 验证 better-sqlite3..."
if node -e "require('better-sqlite3')(':memory:')" &>/dev/null; then
  echo "  better-sqlite3 预编译二进制加载成功"
else
  echo "  预编译二进制不可用，尝试源码编译..."
  # `|| true` guard: under `set -e`, a failing require.resolve would abort
  # before the friendly error below is reached.
  BETTER_SQLITE3_DIR="$(node -p "require('path').dirname(require.resolve('better-sqlite3/package.json'))" 2>/dev/null)" || BETTER_SQLITE3_DIR=""
  BINDING_GYP="${BETTER_SQLITE3_DIR}/binding.gyp"

  if [ -z "${BETTER_SQLITE3_DIR}" ] || [ ! -f "${BINDING_GYP}" ]; then
    echo "  错误: 无法定位 better-sqlite3 包，请先执行 pnpm install"
    exit 1
  fi

  # Patch GCC 8.5 不支持 -std=c++20
  if grep -q -- "-std=c++20" "${BINDING_GYP}"; then
    sed -i "s/-std=c++20/-std=c++2a/g" "${BINDING_GYP}"
    echo "  Patched binding.gyp: -std=c++20 → -std=c++2a"
  fi

  # 手动编译
  cd "${BETTER_SQLITE3_DIR}"
  PYTHON="${PYTHON_BIN}" npm_config_python="${PYTHON_BIN}" \
    npx node-gyp rebuild --python="${PYTHON_BIN}" 2>&1 | grep -E "(gyp info ok|error|Error)" || true
  cd "$SCRIPT_DIR"

  if node -e "require('better-sqlite3')(':memory:')" &>/dev/null; then
    echo "  better-sqlite3 源码编译成功"
  else
    echo "  错误: better-sqlite3 不可用（预编译加载失败且源码编译失败）"
    exit 1
  fi
fi

# ── Step 5: 启动服务 ──
echo "[5/5] 启动 Knowledge 服务..."
echo "  端口: ${PORT:-8421}"
echo "  数据目录: ${KNOWLEDGE_DATA_DIR:-~/.memory-tencentdb/knowledge}"
echo "========================================"
echo ""

pnpm run dev
