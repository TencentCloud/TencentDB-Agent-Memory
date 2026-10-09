#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLAUDE_DIR="${HOME}/.claude"
CLAUDE_MD_PATH="${CLAUDE_DIR}/CLAUDE.md"
TDAI_MEMORY_DIR="${CLAUDE_DIR}/tdai-memory"
USER_ID="${TDAI_USER_ID:-claude-code}"
GATEWAY_URL="${TDAI_GATEWAY_URL:-http://127.0.0.1:8421}"
GATEWAY_AUTO_START="${TDAI_GATEWAY_AUTO_START:-1}"
DATA_DIR="${TDAI_DATA_DIR:-${TDAI_MEMORY_DIR}/data}"
GATEWAY_CONFIG="${TDAI_GATEWAY_CONFIG:-${TDAI_MEMORY_DIR}/tdai-gateway.yaml}"
HOOK_LOG="${TDAI_HOOK_LOG:-${TDAI_MEMORY_DIR}/logs/hooks.jsonl}"
GATEWAY_RUNTIME_DIR="${TDAI_GATEWAY_RUNTIME_DIR:-${TDAI_MEMORY_DIR}/runtime}"
GATEWAY_LOG_DIR="${TDAI_GATEWAY_LOG_DIR:-${TDAI_MEMORY_DIR}/logs}"
GATEWAY_IDLE_TIMEOUT="${TDAI_GATEWAY_IDLE_TIMEOUT_SECONDS:-600}"
GATEWAY_WATCHDOG_INTERVAL="${TDAI_GATEWAY_WATCHDOG_INTERVAL_SECONDS:-30}"
START_MARKER="<!-- TDAI_MEMORY_START -->"
END_MARKER="<!-- TDAI_MEMORY_END -->"
MARKER_PREFIX="TDAI_MEMORY_HOOK_MARKER="
PLUGIN_DIR="${REPO_ROOT}/plugins/tdai-memory-claude-code"
PLUGIN_ID="tdai-memory-claude-code@tdai-memory-local"
MCP_SERVER_NAME="tdai-memory"

usage() {
  cat <<'USAGE'
Usage: scripts/install-claude-code.sh [options]

Install TencentDB Agent Memory for Claude Code:
  - editable-install shared Python adapter packages
  - register and install the Claude Code plugin from this repo
  - create or update ~/.claude/CLAUDE.md by default
  - write plugin MCP config to plugins/tdai-memory-claude-code/.mcp.json
  - write plugin hooks to plugins/tdai-memory-claude-code/hooks/hooks.json

Options:
  --claude-md-path PATH       CLAUDE.md path to create/update (default: ~/.claude/CLAUDE.md)
  --user-id VALUE             Memory user id (default: $TDAI_USER_ID or claude-code)
  --gateway-url URL           Gateway URL (default: http://127.0.0.1:8421)
  --gateway-auto-start 0|1    Whether hooks/MCP should auto-start Gateway (default: 1)
  --data-dir PATH             Gateway memory data dir (default: ~/.claude/tdai-memory/data)
  --gateway-config PATH       Gateway config path (default: ~/.claude/tdai-memory/tdai-gateway.yaml)
  --hook-log PATH             Hook diagnostic JSONL log path (default: ~/.claude/tdai-memory/logs/hooks.jsonl)
  --gateway-runtime-dir PATH  Runtime pid/heartbeat dir (default: ~/.claude/tdai-memory/runtime)
  --gateway-log-dir PATH      Gateway/watchdog log dir (default: ~/.claude/tdai-memory/logs)
  --gateway-idle-timeout N    Stop hook-started Gateway after N idle seconds (default: 600; 0 disables)
  --gateway-watchdog-interval N
                              Idle watchdog polling interval in seconds (default: 30)
  -h, --help                  Show this help
USAGE
}

normalize_path() {
  local path="$1"
  case "${path}" in
    "~")
      path="${HOME}"
      ;;
    "~/"*)
      path="${HOME}/${path#~/}"
      ;;
  esac
  if [[ "${path}" != /* ]]; then
    path="${PWD}/${path}"
  fi
  printf '%s\n' "${path}"
}

shell_quote() {
  printf '%q' "$1"
}

json_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "${value}"
}

yaml_double_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "${value}"
}

json_escape_path() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "${value}"
}

gateway_port_from_url() {
  local url="$1"
  local rest
  local host_port
  rest="${url#*://}"
  host_port="${rest%%/*}"
  if [[ "${host_port}" == *:* ]]; then
    printf '%s\n' "${host_port##*:}"
    return
  fi
  printf '8421\n'
}

write_file_if_changed() {
  local target="$1"
  local tmp_file="$2"
  local existed=0
  if [[ -f "${target}" ]]; then
    existed=1
    if cmp -s "${tmp_file}" "${target}"; then
      rm -f "${tmp_file}"
      printf 'unchanged\n'
      return
    fi
  fi

  mkdir -p "$(dirname "${target}")"
  mv "${tmp_file}" "${target}"
  if [[ "${existed}" -eq 1 ]]; then
    printf 'updated\n'
  else
    printf 'created\n'
  fi
}

build_memory_block() {
  cat <<EOF
${START_MARKER}
# memory-tencentdb Memory

Active. User: ${USER_ID}.

Four-layer memory system (L0->L1->L2->L3) with automatic conversation capture,
structured memory extraction, scene blocks, and persona synthesis.

## Memory Tool Usage

When the injected memory context is insufficient, actively retrieve deeper context with:

- \`tdai_memory_search\`: Search structured long-term memories (L1). Use it for user preferences, important historical events, instructions, and durable facts.
- \`tdai_conversation_search\`: Search raw conversation history (L0). Use it for exact wording, timeline details, or to verify structured memory results.

Call limit:
- Use \`tdai_memory_search\` and \`tdai_conversation_search\` at most 3 times total per turn.
- If the first search has no result, try different keywords or switch tools.
- If 3 searches still find nothing, answer from available context and say the information is not in memory.
${END_MARKER}
EOF
}

update_claude_md() {
  local target="$1"
  local block_file
  local output_file
  block_file="$(mktemp)"
  output_file="$(mktemp)"
  build_memory_block > "${block_file}"

  if [[ ! -f "${target}" ]]; then
    mkdir -p "$(dirname "${target}")"
    mv "${block_file}" "${target}"
    rm -f "${output_file}"
    printf 'created\n'
    return
  fi

  if grep -Fq "${START_MARKER}" "${target}" && grep -Fq "${END_MARKER}" "${target}"; then
    awk -v start="${START_MARKER}" -v end="${END_MARKER}" -v block_file="${block_file}" '
      BEGIN {
        while ((getline line < block_file) > 0) {
          block = block line ORS
        }
        close(block_file)
        skipping = 0
        replaced = 0
      }
      index($0, start) && !replaced {
        printf "%s", block
        skipping = 1
        replaced = 1
        next
      }
      skipping && index($0, end) {
        skipping = 0
        next
      }
      !skipping {
        print
      }
    ' "${target}" > "${output_file}"
    rm -f "${block_file}"
    write_file_if_changed "${target}" "${output_file}"
    return
  fi

  {
    sed -e '${/^$/d;}' "${target}"
    printf '\n\n'
    cat "${block_file}"
    printf '\n'
  } > "${output_file}"
  rm -f "${block_file}"
  write_file_if_changed "${target}" "${output_file}" >/dev/null
  printf 'appended\n'
}

write_gateway_config() {
  local target="$1"
  local data_dir="$2"
  local tmp_file
  local escaped_data_dir
  local gateway_port
  tmp_file="$(mktemp)"
  escaped_data_dir="$(yaml_double_quote "${data_dir}")"
  gateway_port="$(gateway_port_from_url "${GATEWAY_URL}")"

  mkdir -p \
    "${data_dir}/conversations" \
    "${data_dir}/records" \
    "${data_dir}/scene_blocks" \
    "${data_dir}/.metadata"

  cat > "${tmp_file}" <<EOF
server:
  host: "127.0.0.1"
  port: ${gateway_port}
  corsOrigins: []

data:
  baseDir: "${escaped_data_dir}"

llm:
  baseUrl: "http://127.0.0.1:11434/v1"
  apiKey: "ollama"
  model: "gemma4:latest"
  maxTokens: 4096
  timeoutMs: 120000
  disableThinking: false

memory:
  timezone: "Asia/Shanghai"
  storeBackend: "sqlite"

  capture:
    enabled: true

  extraction:
    enabled: true
    enableDedup: true
    maxMemoriesPerSession: 20

  pipeline:
    everyNConversations: 1
    enableWarmup: false
    l1IdleTimeoutSeconds: 3
    l2DelayAfterL1Seconds: 2
    l2MinIntervalSeconds: 5
    l2MaxIntervalSeconds: 30
    sessionActiveWindowHours: 24

  recall:
    enabled: true
    strategy: "hybrid"
    maxResults: 5
    scoreThreshold: 0.1
    timeoutMs: 10000

  embedding:
    enabled: true
    provider: "openai"
    baseUrl: "http://127.0.0.1:11434/v1"
    apiKey: "ollama"
    model: "bge-m3:latest"
    dimensions: 1024
    sendDimensions: false
    timeoutMs: 30000
    recallTimeoutMs: 10000
    captureTimeoutMs: 30000

  persona:
    triggerEveryN: 50
    maxScenes: 15

  report:
    enabled: false

  offload:
    enabled: false
EOF

  write_file_if_changed "${target}" "${tmp_file}"
}

build_hook_command() {
  local marker="$1"
  local command="$2"
  printf '%s%s TDAI_GATEWAY_URL=%s TDAI_GATEWAY_AUTO_START=%s TDAI_GATEWAY_CONFIG=%s TDAI_DATA_DIR=%s TDAI_GATEWAY_CWD=%s TDAI_USER_ID=%s TDAI_HOOK_LOG=%s TDAI_GATEWAY_RUNTIME_DIR=%s TDAI_GATEWAY_LOG_DIR=%s TDAI_GATEWAY_IDLE_TIMEOUT_SECONDS=%s TDAI_GATEWAY_WATCHDOG_INTERVAL_SECONDS=%s PYTHONPATH=%s python3 -m tdai_memory_cli.hook %s' \
    "${MARKER_PREFIX}" \
    "${marker}" \
    "$(shell_quote "${GATEWAY_URL}")" \
    "$(shell_quote "${GATEWAY_AUTO_START}")" \
    "$(shell_quote "${GATEWAY_CONFIG}")" \
    "$(shell_quote "${DATA_DIR}")" \
    "$(shell_quote "${REPO_ROOT}")" \
    "$(shell_quote "${USER_ID}")" \
    "$(shell_quote "${HOOK_LOG}")" \
    "$(shell_quote "${GATEWAY_RUNTIME_DIR}")" \
    "$(shell_quote "${GATEWAY_LOG_DIR}")" \
    "$(shell_quote "${GATEWAY_IDLE_TIMEOUT}")" \
    "$(shell_quote "${GATEWAY_WATCHDOG_INTERVAL}")" \
    "$(shell_quote "${REPO_ROOT}/packages/tdai-memory-cli:${REPO_ROOT}/packages/tdai-memory-mcp")" \
    "${command}"
}

write_plugin_hooks() {
  local target="${PLUGIN_DIR}/hooks/hooks.json"
  local tmp_file
  local session_start_command
  local prefetch_command
  local sync_turn_command
  tmp_file="$(mktemp)"
  session_start_command="$(build_hook_command "SessionStart" "session-start")"
  prefetch_command="$(build_hook_command "UserPromptSubmit" "prefetch")"
  sync_turn_command="$(build_hook_command "Stop" "sync-turn")"

  cat > "${tmp_file}" <<EOF
{
  "description": "TencentDB Agent Memory lifecycle hooks for Claude Code",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": $(json_string "${session_start_command}"),
            "timeout": 60
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": $(json_string "${prefetch_command}"),
            "timeout": 30
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": $(json_string "${sync_turn_command}"),
            "timeout": 60
          }
        ]
      }
    ]
  }
}
EOF

  write_file_if_changed "${target}" "${tmp_file}"
}

write_plugin_mcp() {
  local target="${PLUGIN_DIR}/.mcp.json"
  local tmp_file
  tmp_file="$(mktemp)"

  cat > "${tmp_file}" <<EOF
{
  "${MCP_SERVER_NAME}": {
    "command": "python3",
    "args": [
      "-m",
      "tdai_memory_mcp"
    ],
    "env": {
      "PYTHONPATH": "$(json_escape_path "${REPO_ROOT}/packages/tdai-memory-mcp")",
      "TDAI_GATEWAY_URL": "$(json_escape_path "${GATEWAY_URL}")",
      "TDAI_GATEWAY_API_KEY": "",
      "TDAI_GATEWAY_AUTO_START": "$(json_escape_path "${GATEWAY_AUTO_START}")",
      "TDAI_GATEWAY_CONFIG": "$(json_escape_path "${GATEWAY_CONFIG}")",
      "TDAI_DATA_DIR": "$(json_escape_path "${DATA_DIR}")",
      "TDAI_GATEWAY_CWD": "$(json_escape_path "${REPO_ROOT}")",
      "TDAI_GATEWAY_RUNTIME_DIR": "$(json_escape_path "${GATEWAY_RUNTIME_DIR}")",
      "TDAI_GATEWAY_LOG_DIR": "$(json_escape_path "${GATEWAY_LOG_DIR}")",
      "TDAI_GATEWAY_IDLE_TIMEOUT_SECONDS": "$(json_escape_path "${GATEWAY_IDLE_TIMEOUT}")",
      "TDAI_GATEWAY_WATCHDOG_INTERVAL_SECONDS": "$(json_escape_path "${GATEWAY_WATCHDOG_INTERVAL}")",
      "TDAI_SESSION_KEY": "agent:mcp-claude-code",
      "TDAI_USER_ID": "$(json_escape_path "${USER_ID}")"
    }
  }
}
EOF

  write_file_if_changed "${target}" "${tmp_file}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --claude-md-path)
      CLAUDE_MD_PATH="$2"
      shift 2
      ;;
    --user-id)
      USER_ID="$2"
      shift 2
      ;;
    --gateway-url)
      GATEWAY_URL="$2"
      shift 2
      ;;
    --gateway-auto-start)
      GATEWAY_AUTO_START="$2"
      shift 2
      ;;
    --data-dir)
      DATA_DIR="$2"
      shift 2
      ;;
    --gateway-config)
      GATEWAY_CONFIG="$2"
      shift 2
      ;;
    --hook-log)
      HOOK_LOG="$2"
      shift 2
      ;;
    --gateway-runtime-dir)
      GATEWAY_RUNTIME_DIR="$2"
      shift 2
      ;;
    --gateway-log-dir)
      GATEWAY_LOG_DIR="$2"
      shift 2
      ;;
    --gateway-idle-timeout)
      GATEWAY_IDLE_TIMEOUT="$2"
      shift 2
      ;;
    --gateway-watchdog-interval)
      GATEWAY_WATCHDOG_INTERVAL="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

CLAUDE_DIR="$(normalize_path "${CLAUDE_DIR}")"
mkdir -p "${CLAUDE_DIR}"
CLAUDE_MD_PATH="$(normalize_path "${CLAUDE_MD_PATH}")"
DATA_DIR="$(normalize_path "${DATA_DIR}")"
GATEWAY_CONFIG="$(normalize_path "${GATEWAY_CONFIG}")"
HOOK_LOG="$(normalize_path "${HOOK_LOG}")"
GATEWAY_RUNTIME_DIR="$(normalize_path "${GATEWAY_RUNTIME_DIR}")"
GATEWAY_LOG_DIR="$(normalize_path "${GATEWAY_LOG_DIR}")"

echo "Installing shared Python adapter packages..."
python3 -m pip install --user --no-build-isolation -e "${REPO_ROOT}/packages/tdai-memory-mcp" -e "${REPO_ROOT}/packages/tdai-memory-cli"

echo "Writing Claude Code plugin config..."
mkdir -p "$(dirname "${HOOK_LOG}")" "${GATEWAY_RUNTIME_DIR}" "${GATEWAY_LOG_DIR}"
CLAUDE_MD_UPDATE="$(update_claude_md "${CLAUDE_MD_PATH}")"
GATEWAY_CONFIG_UPDATE="$(write_gateway_config "${GATEWAY_CONFIG}" "${DATA_DIR}")"
PLUGIN_MCP_UPDATE="$(write_plugin_mcp)"
PLUGIN_HOOKS_UPDATE="$(write_plugin_hooks)"

echo "Registering Claude Code marketplace..."
claude plugin marketplace add "${REPO_ROOT}"

echo "Installing Claude Code plugin..."
claude plugin uninstall "${PLUGIN_ID}" >/dev/null 2>&1 || true
claude plugin install "${PLUGIN_ID}" --scope user

echo "claude_md: ${CLAUDE_MD_UPDATE} ${CLAUDE_MD_PATH}"
echo "gateway_config: ${GATEWAY_CONFIG_UPDATE} ${GATEWAY_CONFIG}"
echo "memory_data: ready ${DATA_DIR}"
echo "runtime_dir: ready ${GATEWAY_RUNTIME_DIR}"
echo "log_dir: ready ${GATEWAY_LOG_DIR}"
echo "plugin_mcp: ${PLUGIN_MCP_UPDATE} ${PLUGIN_DIR}/.mcp.json"
echo "plugin_hooks: ${PLUGIN_HOOKS_UPDATE} ${PLUGIN_DIR}/hooks/hooks.json"
echo "plugin_id: ${PLUGIN_ID}"
echo "TDAI memory files:"
echo "  gateway config: ${GATEWAY_CONFIG}"
echo "  memory data   : ${DATA_DIR}"
echo "  hook log      : ${HOOK_LOG}"
echo "  runtime dir   : ${GATEWAY_RUNTIME_DIR}"
echo "  gateway logs  : ${GATEWAY_LOG_DIR}"
echo "  idle timeout  : ${GATEWAY_IDLE_TIMEOUT}s"
echo "TencentDB Agent Memory Claude Code install complete."
