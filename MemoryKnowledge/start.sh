#!/usr/bin/env bash
set -euo pipefail

# ─── Knowledge Service Startup Script ───
# Portable local launcher using standard Node.js and npm workflows.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================"
echo "  Knowledge Service Launcher"
echo "========================================"

# ── Step 1: Verify Node.js and npm ──
echo "[1/4] Checking Node.js runtime..."
if ! command -v node >/dev/null 2>&1; then
  echo "  Error: 'node' executable not found in PATH."
  echo "  Please install Node.js >= 22 (engines: >=22.0.0)."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "  Error: 'npm' executable not found in PATH."
  echo "  Please ensure npm is installed alongside Node.js."
  exit 1
fi

NODE_VER="$(node -v | sed 's/^v//')"
NODE_MAJOR="$(echo "$NODE_VER" | cut -d. -f1)"
echo "  Node: $(node -v) ($(command -v node))"
echo "  npm:  $(npm -v) ($(command -v npm))"

if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "  Error: Node.js version must be >= 22 (current: $NODE_VER)"
  exit 1
fi

# ── Step 2: Verify dependencies ──
echo "[2/4] Verifying dependencies..."
if [ ! -d "node_modules" ]; then
  echo "  node_modules not found. Running npm ci..."
  npm ci
else
  echo "  node_modules present."
fi

# ── Step 3: Build verification (if needed) ──
echo "[3/4] Checking build artifacts..."
MODE="${1:-${NODE_ENV:-dev}}"
if [ "$MODE" = "prod" ] || [ "$MODE" = "production" ] || [ ! -f "dist/server.mjs" ]; then
  if [ ! -f "dist/server.mjs" ]; then
    echo "  dist/server.mjs not found. Running npm run build..."
    npm run build
  else
    echo "  dist/server.mjs present."
  fi
fi

# ── Step 4: Start service ──
PORT="${PORT:-8421}"
DATA_DIR="${KNOWLEDGE_DATA_DIR:-${HOME}/.memory-tencentdb/knowledge}"
echo "[4/4] Starting Knowledge Service..."
echo "  Mode:     $MODE"
echo "  Port:     $PORT"
echo "  Data Dir: $DATA_DIR"
echo "========================================"
echo ""

if [ "$MODE" = "prod" ] || [ "$MODE" = "production" ]; then
  exec node bin/server.mjs
else
  exec npm run dev
fi
