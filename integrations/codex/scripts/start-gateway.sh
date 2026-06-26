#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
export TDAI_HOME="${TDAI_HOME:-$HOME/.memory-tencentdb}"
export TDAI_SRC="${TDAI_SRC:-$HOME/Downloads/TencentDB-Agent-Memory}"

if [[ -f "$TDAI_HOME/gateway.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$TDAI_HOME/gateway.env"
  set +a
fi

export TDAI_GATEWAY_HOST="${TDAI_GATEWAY_HOST:-127.0.0.1}"
export TDAI_GATEWAY_PORT="${TDAI_GATEWAY_PORT:-8420}"
export TDAI_DATA_DIR="${TDAI_DATA_DIR:-$TDAI_HOME/memory-tdai}"
export TDAI_LLM_BASE_URL="${TDAI_LLM_BASE_URL:-https://api.lkeap.cloud.tencent.com/v1}"
export TDAI_LLM_MODEL="${TDAI_LLM_MODEL:-deepseek-v3.2}"
export TDAI_LLM_API_KEY="${TDAI_LLM_API_KEY:-${OPENAI_API_KEY:-}}"

cd "$TDAI_SRC"
exec node --import tsx src/gateway/server.ts
