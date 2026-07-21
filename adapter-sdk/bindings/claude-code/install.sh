#!/usr/bin/env bash
#
# install.sh — wire the TencentDB Agent Memory Claude Code adapter into a
# Claude Code project (or your global ~/.claude).
#
# It merges:
#   1. hooks (UserPromptSubmit/Stop/SessionEnd) into <target>/.claude/settings.json
#   2. the MCP server into <target>/.mcp.json
#
# Merging is done with Node (already required to run the adapter) so existing
# settings are preserved. Re-running is idempotent.
#
# Usage:
#   ./install.sh [TARGET_DIR]      # default TARGET_DIR = current directory
#
# Prereqs: a running Gateway on :8420 (see repo README "Hermes 2.B" steps for
# how to launch the standalone Gateway), Node >= 22, and `npx tsx` available.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${1:-$(pwd)}"

HOOK_CLI="$HERE/hook-cli.ts"
MCP_SERVER="$HERE/mcp-server.ts"

echo "TencentDB Agent Memory — Claude Code adapter installer"
echo "  adapter dir : $HERE"
echo "  target proj : $TARGET_DIR"
echo

mkdir -p "$TARGET_DIR/.claude"

node - "$TARGET_DIR" "$HOOK_CLI" "$MCP_SERVER" <<'NODE'
const fs = require("fs");
const path = require("path");

const [targetDir, hookCli, mcpServer] = process.argv.slice(2);

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return {}; }
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}
function cmd(mode) {
  return `npx tsx ${hookCli} ${mode}`;
}
function ensureHook(settings, event, command) {
  settings.hooks = settings.hooks || {};
  settings.hooks[event] = settings.hooks[event] || [];
  const already = JSON.stringify(settings.hooks[event]).includes(hookCli);
  if (already) {
    // Refresh path in case it moved.
    settings.hooks[event] = settings.hooks[event].filter(
      (g) => !JSON.stringify(g).includes("hook-cli.ts"),
    );
  }
  settings.hooks[event].push({ hooks: [{ type: "command", command }] });
}

// 1. hooks → .claude/settings.json
const settingsPath = path.join(targetDir, ".claude", "settings.json");
const settings = readJson(settingsPath);
ensureHook(settings, "UserPromptSubmit", cmd("recall"));
ensureHook(settings, "Stop", cmd("capture"));
ensureHook(settings, "SessionEnd", cmd("session-end"));
writeJson(settingsPath, settings);
console.log("✓ hooks written to", settingsPath);

// 2. MCP server → .mcp.json
const mcpPath = path.join(targetDir, ".mcp.json");
const mcp = readJson(mcpPath);
mcp.mcpServers = mcp.mcpServers || {};
mcp.mcpServers["memory-tencentdb"] = {
  command: "npx",
  args: ["tsx", mcpServer],
  env: {
    MEMORY_TENCENTDB_GATEWAY_HOST: "127.0.0.1",
    MEMORY_TENCENTDB_GATEWAY_PORT: "8420",
  },
};
writeJson(mcpPath, mcp);
console.log("✓ MCP server written to", mcpPath);
NODE

echo
echo "Done. Next steps:"
echo "  1. Ensure the Gateway is running:  curl http://127.0.0.1:8420/health"
echo "  2. Restart Claude Code in: $TARGET_DIR"
echo "  3. Approve the 'memory-tencentdb' MCP server when prompted."
echo
echo "Set MEMORY_TENCENTDB_DEBUG=1 to see adapter logs on stderr."
