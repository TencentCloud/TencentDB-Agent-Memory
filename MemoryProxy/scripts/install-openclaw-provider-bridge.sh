#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_DIR="$PROXY_DIR/openclaw-provider-bridge"
OPENCLAW_CONFIG_FILE="${OPENCLAW_CONFIG_FILE:-$HOME/.openclaw/openclaw.json}"

: "${TDAI_TEAM_ID:?Set TDAI_TEAM_ID to the Memory Team id}"
: "${TDAI_AGENT_ID:?Set TDAI_AGENT_ID to the Memory Agent id}"

export MEMORY_PROXY_URL="${MEMORY_PROXY_URL:-http://127.0.0.1:8096}"
export MEMORY_PROXY_INSTANCE_ID="${MEMORY_PROXY_INSTANCE_ID:-default}"
export MEMORY_PROXY_MODEL_ID="${MEMORY_PROXY_MODEL_ID:-default}"
export OPENCLAW_AGENT_ID="${OPENCLAW_AGENT_ID:-main}"
export OPENCLAW_CONFIG_FILE

command -v node >/dev/null || { echo "node is required (Node.js 22+)" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required" >&2; exit 1; }
command -v openclaw >/dev/null || { echo "openclaw CLI is required" >&2; exit 1; }

node -e 'const major=Number(process.versions.node.split(".")[0]);if(major<22){console.error("Node.js 22+ is required");process.exit(1)}'

cd "$PLUGIN_DIR"
npm install --no-audit --no-fund
npm run build
openclaw plugins install -l --force --accept-capabilities "$PLUGIN_DIR"

node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const file = process.env.OPENCLAW_CONFIG_FILE;
fs.mkdirSync(path.dirname(file), { recursive: true });
let root = {};
if (fs.existsSync(file)) root = JSON.parse(fs.readFileSync(file, "utf8"));
root.plugins ??= {};
root.plugins.entries ??= {};
const existing = root.plugins.entries["memory-proxy-bridge"] ?? {};
const config = existing.config ?? {};
config.proxyUrl = process.env.MEMORY_PROXY_URL;
config.instanceId = process.env.MEMORY_PROXY_INSTANCE_ID;
config.api = "openai-completions";
config.agentMappings ??= {};
config.agentMappings[process.env.OPENCLAW_AGENT_ID] = {
  teamId: process.env.TDAI_TEAM_ID,
  memoryAgentId: process.env.TDAI_AGENT_ID,
};
config.models = [{
  id: process.env.MEMORY_PROXY_MODEL_ID,
  name: process.env.MEMORY_PROXY_MODEL_ID,
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 32000,
}];
root.plugins.entries["memory-proxy-bridge"] = { ...existing, enabled: true, config };
root.gateway ??= {};
root.gateway.mode ??= "local";
root.models ??= {};
root.models.mode ??= "merge";
root.models.providers ??= {};
const providerId = "memory-proxy";
const modelId = process.env.MEMORY_PROXY_MODEL_ID;
const proxyBaseUrl = process.env.MEMORY_PROXY_URL.replace(/\/+$/, "");
const provider = root.models.providers[providerId] ?? {};
const providerModels = Array.isArray(provider.models) ? provider.models : [];
const configuredModel = {
  id: modelId,
  name: modelId,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000,
};
root.models.providers[providerId] = {
  ...provider,
  baseUrl: `${proxyBaseUrl}/openclaw/${encodeURIComponent(process.env.MEMORY_PROXY_INSTANCE_ID)}/v1`,
  apiKey: { source: "env", provider: "default", id: "MEMORY_PROXY_API_KEY" },
  api: config.api,
  models: [...providerModels.filter((model) => model?.id !== modelId), configuredModel],
};
root.agents ??= {};
root.agents.defaults ??= {};
root.agents.defaults.model ??= {};
root.agents.defaults.model.primary = `${providerId}/${modelId}`;
const temp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(temp, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temp, file);
console.log(`Updated ${file}`);
NODE

echo "Installed memory-proxy-bridge for OpenClaw agent '$OPENCLAW_AGENT_ID'."
if [[ -z "${MEMORY_PROXY_API_KEY:-}" ]]; then
  echo "Before starting OpenClaw: export MEMORY_PROXY_API_KEY='sk-mem-...'"
else
  echo "MEMORY_PROXY_API_KEY is set for this shell (it was not written to config)."
fi
