#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLAUDE_DIR="${HOME}/.claude"
CLAUDE_MD_PATH="${CLAUDE_DIR}/CLAUDE.md"
TDAI_MEMORY_DIR="${CLAUDE_DIR}/tdai-memory"
USER_ID="${TDAI_USER_ID:-claude-code}"
GATEWAY_URL="${TDAI_GATEWAY_URL:-http://127.0.0.1:8421}"
HOOK_LOG="${TDAI_HOOK_LOG:-${TDAI_MEMORY_DIR}/logs/hooks.jsonl}"
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
  --hook-log PATH             Hook diagnostic JSONL log path (default: ~/.claude/tdai-memory/logs/hooks.jsonl)
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

json_escape_path() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "${value}"
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

build_hook_command() {
  local marker="$1"
  local command="$2"
  printf '%s%s TDAI_GATEWAY_URL=%s TDAI_USER_ID=%s TDAI_HOOK_LOG=%s PYTHONPATH=%s python3 -m tdai_memory_cli.hook %s' \
    "${MARKER_PREFIX}" \
    "${marker}" \
    "$(shell_quote "${GATEWAY_URL}")" \
    "$(shell_quote "${USER_ID}")" \
    "$(shell_quote "${HOOK_LOG}")" \
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
  "description": "TencentDB Agent Memory agent hooks for Claude Code",
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
    --hook-log)
      HOOK_LOG="$2"
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
HOOK_LOG="$(normalize_path "${HOOK_LOG}")"

echo "Installing shared Python adapter packages..."
python3 -m pip install --user --no-build-isolation -e "${REPO_ROOT}/packages/tdai-memory-mcp" -e "${REPO_ROOT}/packages/tdai-memory-cli"

echo "Writing Claude Code plugin config..."
mkdir -p "$(dirname "${HOOK_LOG}")"
CLAUDE_MD_UPDATE="$(update_claude_md "${CLAUDE_MD_PATH}")"
PLUGIN_MCP_UPDATE="$(write_plugin_mcp)"
PLUGIN_HOOKS_UPDATE="$(write_plugin_hooks)"

echo "Registering Claude Code marketplace..."
claude plugin marketplace add "${REPO_ROOT}"

echo "Installing Claude Code plugin..."
claude plugin uninstall "${PLUGIN_ID}" >/dev/null 2>&1 || true
claude plugin install "${PLUGIN_ID}" --scope user

echo "claude_md: ${CLAUDE_MD_UPDATE} ${CLAUDE_MD_PATH}"
echo "plugin_mcp: ${PLUGIN_MCP_UPDATE} ${PLUGIN_DIR}/.mcp.json"
echo "plugin_hooks: ${PLUGIN_HOOKS_UPDATE} ${PLUGIN_DIR}/hooks/hooks.json"
echo "plugin_id: ${PLUGIN_ID}"
echo "TDAI memory files:"
echo "  gateway url   : ${GATEWAY_URL}"
echo "  hook log      : ${HOOK_LOG}"
echo "TencentDB Agent Memory Claude Code install complete."
