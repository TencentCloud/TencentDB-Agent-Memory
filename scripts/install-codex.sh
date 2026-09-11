#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
AGENTS_PATH="${HOME}/.codex/AGENTS.md"
CODEX_DIR="${HOME}/.codex"
TDAI_MEMORY_DIR="${HOME}/.codex/tdai-memory"
USER_ID="${TDAI_USER_ID:-codex}"
GATEWAY_URL="${TDAI_GATEWAY_URL:-http://127.0.0.1:8420}"
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
PLUGIN_ID="tdai-memory@tdai-memory-local"
MCP_SERVER_NAME="tdai-memory"
MCP_TOOL_MEMORY_SEARCH="tdai_memory_search"
MCP_TOOL_CONVERSATION_SEARCH="tdai_conversation_search"

usage() {
  cat <<'USAGE'
Usage: scripts/install-codex.sh [options]

Install TencentDB Agent Memory for Codex:
  - editable-install shared Python adapter packages
  - register and install the Codex plugin from this repo
  - create or update AGENTS.md under ~/.codex by default
  - write bundled plugin hooks to plugins/tdai-memory/hooks/hooks.json
  - remove legacy tdai-memory entries from ~/.codex/hooks.json
  - configure tdai-memory MCP tool approval policy in ~/.codex/config.toml

Options:
  --agents-path PATH        AGENTS.md path to create/update (default: ~/.codex/AGENTS.md)
  --workspace PATH          Deprecated alias for --agents-path PATH/AGENTS.md
  --user-id VALUE           Memory user id (default: $TDAI_USER_ID or codex)
  --gateway-url URL         Gateway URL (default: http://127.0.0.1:8420)
  --gateway-auto-start 0|1  Whether hooks/MCP should auto-start Gateway (default: 1)
  --data-dir PATH           Gateway memory data dir (default: ~/.codex/tdai-memory/data)
  --gateway-config PATH     Gateway config path (default: ~/.codex/tdai-memory/tdai-gateway.yaml)
  --hook-log PATH           Hook diagnostic JSONL log path (default: ~/.codex/tdai-memory/logs/hooks.jsonl)
  --gateway-runtime-dir PATH Runtime pid/heartbeat dir (default: ~/.codex/tdai-memory/runtime)
  --gateway-log-dir PATH    Gateway/watchdog log dir (default: ~/.codex/tdai-memory/logs)
  --gateway-idle-timeout N  Stop hook-started Gateway after N idle seconds (default: 600; 0 disables)
  --gateway-watchdog-interval N
                            Idle watchdog polling interval in seconds (default: 30)
  -h, --help                Show this help
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

update_agents_md() {
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
  tmp_file="$(mktemp)"
  escaped_data_dir="$(yaml_double_quote "${data_dir}")"

  mkdir -p \
    "${data_dir}/conversations" \
    "${data_dir}/records" \
    "${data_dir}/scene_blocks" \
    "${data_dir}/.metadata"

  cat > "${tmp_file}" <<EOF
server:
  host: "127.0.0.1"
  port: 8420
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
  local target="${REPO_ROOT}/plugins/tdai-memory/hooks/hooks.json"
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
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": $(json_string "${session_start_command}"),
            "timeout": 60,
            "statusMessage": "Starting TDAI memory Gateway"
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
            "timeout": 30,
            "statusMessage": "Prefetching TDAI memory"
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
            "timeout": 60,
            "statusMessage": "Capturing TDAI memory turn"
          }
        ]
      }
    ]
  }
}
EOF

  write_file_if_changed "${target}" "${tmp_file}"
}

cleanup_legacy_root_plugin_hooks() {
  local target="${REPO_ROOT}/plugins/tdai-memory/hooks.json"
  if [[ ! -f "${target}" ]]; then
    printf 'absent\n'
    return
  fi

  if head -n 1 "${target}" | grep -Fq "# Generated by scripts/install-codex.sh"; then
    rm -f "${target}"
    printf 'removed\n'
    return
  fi

  printf 'kept\n'
}

cleanup_legacy_hooks() {
  local hooks_path="${CODEX_DIR}/hooks.json"
  if [[ ! -f "${hooks_path}" ]]; then
    printf 'absent\n'
    return
  fi

  node - "${hooks_path}" "${MARKER_PREFIX}" <<'NODE'
const fs = require("fs");
const hooksPath = process.argv[2];
const markerPrefix = process.argv[3];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function entryHasTdaiHook(entry, eventName) {
  if (!isObject(entry) || !Array.isArray(entry.hooks)) return false;
  const marker = `${markerPrefix}${eventName}`;
  return entry.hooks.some((hook) => {
    if (!isObject(hook) || typeof hook.command !== "string") return false;
    return hook.command.startsWith(marker) ||
      hook.command.startsWith(markerPrefix) ||
      hook.command.includes("tdai_memory_cli.hook") ||
      hook.command.includes("codex-plugin/memory-cli") ||
      hook.command.includes("packages/tdai-memory-cli");
  });
}

let payload;
try {
  payload = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
} catch (error) {
  console.error(`Invalid hooks JSON at ${hooksPath}: ${error.message}`);
  process.exit(1);
}

if (!isObject(payload)) {
  console.error(`Invalid hooks JSON at ${hooksPath}: root must be an object`);
  process.exit(1);
}

const before = JSON.stringify(payload);
if (!isObject(payload.hooks)) {
  console.log("unchanged");
  process.exit(0);
}

for (const eventName of Object.keys(payload.hooks)) {
  const entries = payload.hooks[eventName];
  if (!Array.isArray(entries)) continue;
  const filtered = entries.filter((entry) => !entryHasTdaiHook(entry, eventName));
  if (filtered.length > 0) {
    payload.hooks[eventName] = filtered;
  } else {
    delete payload.hooks[eventName];
  }
}

if (Object.keys(payload.hooks).length === 0) {
  delete payload.hooks;
}

if (JSON.stringify(payload) === before) {
  console.log("unchanged");
} else {
  fs.writeFileSync(hooksPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log("cleaned");
}
NODE
}

install_config() {
  local config_path="${CODEX_DIR}/config.toml"
  node - "${config_path}" "${PLUGIN_ID}" "${MCP_SERVER_NAME}" "${MCP_TOOL_MEMORY_SEARCH}" "${MCP_TOOL_CONVERSATION_SEARCH}" <<'NODE'
const fs = require("fs");
const path = require("path");
const configPath = process.argv[2];
const pluginId = process.argv[3];
const mcpServerName = process.argv[4];
const toolNames = process.argv.slice(5);

function tableExists(content, tableName) {
  const header = `[${tableName}]`;
  return content.split(/\r?\n/).some((line) => line.trim() === header);
}

function findTableStart(lines, header) {
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === header) return index;
  }
  return -1;
}

function findTableEnd(lines, start) {
  for (let index = start + 1; index < lines.length; index += 1) {
    const stripped = lines[index].trim();
    if (stripped.startsWith("[") && stripped.endsWith("]")) return index;
  }
  return lines.length;
}

function upsertTableKeys(content, tableName, keys) {
  const lines = content ? content.replace(/\r\n/g, "\n").split("\n") : [];
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const header = `[${tableName}]`;
  const tableStart = findTableStart(lines, header);
  if (tableStart === -1) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(header);
    for (const [key, value] of Object.entries(keys)) {
      lines.push(`${key} = ${value}`);
    }
    return `${lines.join("\n").trim()}\n`;
  }

  const tableEnd = findTableEnd(lines, tableStart);
  const existingKeyLines = new Map();
  for (let index = tableStart + 1; index < tableEnd; index += 1) {
    const stripped = lines[index].trim();
    if (!stripped || stripped.startsWith("#")) continue;
    for (const key of Object.keys(keys)) {
      if (stripped.startsWith(`${key} `) || stripped.startsWith(`${key}=`)) {
        existingKeyLines.set(key, index);
      }
    }
  }

  const missing = [];
  for (const [key, value] of Object.entries(keys)) {
    const line = `${key} = ${value}`;
    if (existingKeyLines.has(key)) {
      lines[existingKeyLines.get(key)] = line;
    } else {
      missing.push(line);
    }
  }
  if (missing.length > 0) {
    lines.splice(tableStart + 1, 0, ...missing);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

const existed = fs.existsSync(configPath);
const original = existed ? fs.readFileSync(configPath, "utf8") : "";
let updated = original;

updated = upsertTableKeys(updated, "features", { hooks: "true" });

const globalTable = `mcp_servers.${mcpServerName}`;
if (tableExists(updated, globalTable)) {
  updated = upsertTableKeys(updated, globalTable, {
    default_tools_approval_mode: '"auto"',
  });
  for (const toolName of toolNames) {
    updated = upsertTableKeys(updated, `${globalTable}.tools.${toolName}`, {
      approval_mode: '"approve"',
    });
  }
}

const pluginTable = `plugins."${pluginId}".mcp_servers.${mcpServerName}`;
updated = upsertTableKeys(updated, pluginTable, {
  enabled: "true",
  default_tools_approval_mode: '"auto"',
});
for (const toolName of toolNames) {
  updated = upsertTableKeys(updated, `${pluginTable}.tools.${toolName}`, {
    approval_mode: '"approve"',
  });
}

if (updated !== original || !existed) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, updated);
  console.log(existed ? "updated" : "created");
} else {
  console.log("unchanged");
}
NODE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agents-path)
      AGENTS_PATH="$2"
      shift 2
      ;;
    --workspace)
      AGENTS_PATH="$2/AGENTS.md"
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

CODEX_DIR="$(normalize_path "${CODEX_DIR}")"
mkdir -p "${CODEX_DIR}"
AGENTS_PATH="$(normalize_path "${AGENTS_PATH}")"
DATA_DIR="$(normalize_path "${DATA_DIR}")"
GATEWAY_CONFIG="$(normalize_path "${GATEWAY_CONFIG}")"
HOOK_LOG="$(normalize_path "${HOOK_LOG}")"
GATEWAY_RUNTIME_DIR="$(normalize_path "${GATEWAY_RUNTIME_DIR}")"
GATEWAY_LOG_DIR="$(normalize_path "${GATEWAY_LOG_DIR}")"

echo "Installing shared Python adapter packages..."
python3 -m pip install --user -e "${REPO_ROOT}/packages/tdai-memory-mcp" -e "${REPO_ROOT}/packages/tdai-memory-cli"

echo "Registering Codex marketplace..."
codex plugin marketplace add "${REPO_ROOT}"

echo "Registering tdai-memory MCP server..."
codex mcp remove tdai-memory >/dev/null 2>&1 || true
codex mcp add tdai-memory \
  --env "PYTHONPATH=${REPO_ROOT}/packages/tdai-memory-mcp" \
  --env "TDAI_GATEWAY_URL=${GATEWAY_URL}" \
  --env "TDAI_GATEWAY_AUTO_START=${GATEWAY_AUTO_START}" \
  --env "TDAI_GATEWAY_CONFIG=${GATEWAY_CONFIG}" \
  --env "TDAI_DATA_DIR=${DATA_DIR}" \
  --env "TDAI_GATEWAY_CWD=${REPO_ROOT}" \
  --env "TDAI_GATEWAY_RUNTIME_DIR=${GATEWAY_RUNTIME_DIR}" \
  --env "TDAI_GATEWAY_LOG_DIR=${GATEWAY_LOG_DIR}" \
  --env "TDAI_GATEWAY_IDLE_TIMEOUT_SECONDS=${GATEWAY_IDLE_TIMEOUT}" \
  --env "TDAI_GATEWAY_WATCHDOG_INTERVAL_SECONDS=${GATEWAY_WATCHDOG_INTERVAL}" \
  --env "TDAI_SESSION_KEY=agent:mcp-codex" \
  --env "TDAI_USER_ID=${USER_ID}" \
  -- python3 -m tdai_memory_mcp

echo "Updating Codex AGENTS.md and plugin hooks..."
mkdir -p "$(dirname "${HOOK_LOG}")" "${GATEWAY_RUNTIME_DIR}" "${GATEWAY_LOG_DIR}"
AGENTS_UPDATE="$(update_agents_md "${AGENTS_PATH}")"
GATEWAY_CONFIG_UPDATE="$(write_gateway_config "${GATEWAY_CONFIG}" "${DATA_DIR}")"
PLUGIN_HOOKS_UPDATE="$(write_plugin_hooks)"
LEGACY_ROOT_PLUGIN_HOOKS_UPDATE="$(cleanup_legacy_root_plugin_hooks)"
LEGACY_HOOKS_UPDATE="$(cleanup_legacy_hooks)"
CONFIG_UPDATE="$(install_config)"

echo "agents_md: ${AGENTS_UPDATE} ${AGENTS_PATH}"
echo "gateway_config: ${GATEWAY_CONFIG_UPDATE} ${GATEWAY_CONFIG}"
echo "memory_data: ready ${DATA_DIR}"
echo "runtime_dir: ready ${GATEWAY_RUNTIME_DIR}"
echo "log_dir: ready ${GATEWAY_LOG_DIR}"
echo "plugin_hooks: ${PLUGIN_HOOKS_UPDATE} ${REPO_ROOT}/plugins/tdai-memory/hooks/hooks.json"
echo "legacy_root_plugin_hooks: ${LEGACY_ROOT_PLUGIN_HOOKS_UPDATE} ${REPO_ROOT}/plugins/tdai-memory/hooks.json"
echo "legacy_hooks_json: ${LEGACY_HOOKS_UPDATE} ${CODEX_DIR}/hooks.json"
echo "config_toml: ${CONFIG_UPDATE} ${CODEX_DIR}/config.toml"

echo "Installing Codex plugin..."
codex plugin remove tdai-memory@tdai-memory-local >/dev/null 2>&1 || true
codex plugin add tdai-memory@tdai-memory-local

echo "TDAI memory files:"
echo "  gateway config: ${GATEWAY_CONFIG}"
echo "  memory data   : ${DATA_DIR}"
echo "  hook log      : ${HOOK_LOG}"
echo "  runtime dir   : ${GATEWAY_RUNTIME_DIR}"
echo "  gateway logs  : ${GATEWAY_LOG_DIR}"
echo "  idle timeout  : ${GATEWAY_IDLE_TIMEOUT}s"
echo "TencentDB Agent Memory Codex install complete."
