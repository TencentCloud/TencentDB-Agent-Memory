#!/bin/bash
# Knowledge Service container entrypoint.
# Maps CLI flags → env vars (env wins if already set), validates, then starts node.
set -euo pipefail

DATA_DIR="${KNOWLEDGE_DATA_DIR:-/app/data}"
DB_PATH="${KNOWLEDGE_DB_PATH:-/app/data/knowledge.db}"
PORT="${PORT:-8421}"
SKIP_LLM_CHECK=0
REQUIRE_TMC=0

show_help() {
  cat <<'EOF'
Knowledge Service (team-knowledge) — pull and run with CLI flags (no .env file needed)

Usage:
  docker run -d -p 8421:8421 -v team-knowledge-data:/app/data IMAGE [OPTIONS]

Required:
  --public-url URL       Agent-reachable API base (must include /v3)
                         e.g. http://203.0.113.10:8421/v3

LLM routing:
  --llm-mode MODE        proxy (default) | custom
                         proxy  → wiki ingest 走 context_proxy（TMC 推送的 binding），
                                  无需下面的直连凭据
                         custom → 直连自带 OpenAI 兼容端点，需 --llm-key/--llm-base-url

Only for --llm-mode custom (BYO direct endpoint):
  --llm-key KEY
  --llm-base-url URL     e.g. https://api.openai.com/v1

Recommended (TMC on same host / compose network):
  --tmc-callback URL     TMC root, e.g. http://203.0.113.10:8123
                         (ingest ready → POST .../api/v1/knowledge/status-callback)

Optional:
  --llm-model NAME       Default: gpt-4o-mini
  --port N               Default: 8421
  --data-dir PATH        Default: /app/data
  --code-graph-only      Do not require LLM (wiki ingest will fail)
  --require-tmc          Fail if --tmc-callback / TMC_CALLBACK_URL missing
  --help                 Show this help

Same settings via environment (-e), flags override unset env:
  KNOWLEDGE_PUBLIC_BASE_URL, TMC_CALLBACK_URL,
  LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_MODE,
  PORT, KNOWLEDGE_DATA_DIR, KNOWLEDGE_DB_PATH

Examples:
  # Full (wiki + code-graph + TMC callback)
  docker run -d --name team-knowledge -p 8421:8421 -v team-knowledge-data:/app/data \\
    csighub.tencentyun.com/<ns>/team-knowledge:latest \\
    --public-url http://203.0.113.10:8421/v3 \\
    --tmc-callback http://203.0.113.10:8123 \\
    --llm-key "$LLM_API_KEY" \\
    --llm-base-url https://api.example.com/v1

  # Code-graph only
  docker run -d --name team-knowledge -p 8421:8421 -v team-knowledge-data:/app/data IMAGE \\
    --public-url http://203.0.113.10:8421/v3 --code-graph-only
EOF
}

normalize_public_url() {
  local url="${1%/}"
  case "$url" in
    */v3) echo "$url" ;;
    *) echo "$url/v3" ;;
  esac
}

set_if_empty() {
  local var="$1"
  local val="$2"
  if [[ -z "${!var:-}" ]]; then
    export "$var=$val"
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h)
        show_help
        exit 0
        ;;
      --public-url)
        set_if_empty KNOWLEDGE_PUBLIC_BASE_URL "$(normalize_public_url "$2")"
        shift 2
        ;;
      --public-url=*)
        set_if_empty KNOWLEDGE_PUBLIC_BASE_URL "$(normalize_public_url "${1#*=}")"
        shift
        ;;
      --tmc-callback)
        set_if_empty TMC_CALLBACK_URL "${2%/}"
        shift 2
        ;;
      --tmc-callback=*)
        set_if_empty TMC_CALLBACK_URL "${1#*=}"
        TMC_CALLBACK_URL="${TMC_CALLBACK_URL%/}"
        export TMC_CALLBACK_URL
        shift
        ;;
      --llm-key)
        set_if_empty LLM_API_KEY "$2"
        shift 2
        ;;
      --llm-key=*)
        set_if_empty LLM_API_KEY "${1#*=}"
        shift
        ;;
      --llm-base-url)
        set_if_empty LLM_BASE_URL "$2"
        shift 2
        ;;
      --llm-base-url=*)
        set_if_empty LLM_BASE_URL "${1#*=}"
        shift
        ;;
      --llm-model)
        set_if_empty LLM_MODEL "$2"
        shift 2
        ;;
      --llm-model=*)
        set_if_empty LLM_MODEL "${1#*=}"
        shift
        ;;
      --llm-mode)
        set_if_empty LLM_MODE "$2"
        shift 2
        ;;
      --llm-mode=*)
        set_if_empty LLM_MODE "${1#*=}"
        shift
        ;;
      --port)
        PORT="$2"
        shift 2
        ;;
      --port=*)
        PORT="${1#*=}"
        shift
        ;;
      --data-dir)
        DATA_DIR="$2"
        shift 2
        ;;
      --data-dir=*)
        DATA_DIR="${1#*=}"
        shift
        ;;
      --code-graph-only)
        SKIP_LLM_CHECK=1
        shift
        ;;
      --require-tmc)
        REQUIRE_TMC=1
        shift
        ;;
      start)
        shift
        ;;
      *)
        echo "error: unknown argument: $1" >&2
        echo "Run with --help for usage." >&2
        exit 1
        ;;
    esac
  done
}

validate() {
  local err=0

  if [[ -z "${KNOWLEDGE_PUBLIC_BASE_URL:-}" ]]; then
    echo "error: --public-url is required (Agent/TMC need KNOWLEDGE_PUBLIC_BASE_URL with /v3)" >&2
    err=1
  elif [[ "${KNOWLEDGE_PUBLIC_BASE_URL}" != */v3 ]]; then
    echo "error: --public-url must end with /v3 (got: ${KNOWLEDGE_PUBLIC_BASE_URL})" >&2
    err=1
  fi

  if [[ "$REQUIRE_TMC" -eq 1 && -z "${TMC_CALLBACK_URL:-}" ]]; then
    echo "error: --tmc-callback is required (or set TMC_CALLBACK_URL)" >&2
    err=1
  fi

  # 仅 LLM_MODE=custom（自带端点直连）时才需要 --llm-key/--llm-base-url。
  # 默认 LLM_MODE=proxy：wiki ingest 走 context_proxy（TMC 推送的 llm_binding），
  # 无需容器内的直连凭据。
  if [[ "$SKIP_LLM_CHECK" -eq 0 && "${LLM_MODE:-proxy}" == "custom" ]]; then
    if [[ -z "${LLM_API_KEY:-}" ]]; then
      echo "error: LLM_MODE=custom 需要 --llm-key / LLM_API_KEY (或 --code-graph-only 跳过)" >&2
      err=1
    fi
    if [[ -z "${LLM_BASE_URL:-}" ]]; then
      echo "error: LLM_MODE=custom 需要 --llm-base-url / LLM_BASE_URL (或 --code-graph-only 跳过)" >&2
      err=1
    fi
  fi

  if [[ "$err" -ne 0 ]]; then
    echo >&2
    show_help >&2
    exit 1
  fi

  if [[ -z "${TMC_CALLBACK_URL:-}" ]]; then
    echo "warn: TMC_CALLBACK_URL not set — ingest/sync will not callback TMC" >&2
  fi
  if [[ "$SKIP_LLM_CHECK" -eq 1 ]]; then
    echo "warn: running code-graph-only mode — wiki ingest needs LLM config" >&2
  fi
}

main() {
  parse_args "$@"
  validate

  export PORT
  export KNOWLEDGE_DATA_DIR="$DATA_DIR"
  export KNOWLEDGE_DB_PATH="$DB_PATH"
  export NODE_ENV="${NODE_ENV:-production}"
  export LOG_LEVEL="${LOG_LEVEL:-info}"
  export LLM_MODE="${LLM_MODE:-proxy}"
  export LLM_MODEL="${LLM_MODEL:-gpt-4o-mini}"

  mkdir -p "$KNOWLEDGE_DATA_DIR"

  echo "team-knowledge starting:"
  echo "  listen:      0.0.0.0:${PORT}"
  echo "  data:        ${KNOWLEDGE_DATA_DIR}"
  echo "  public url:  ${KNOWLEDGE_PUBLIC_BASE_URL}"
  echo "  tmc callback:${TMC_CALLBACK_URL:-<none>}"

  exec node dist/server.mjs
}

main "$@"
