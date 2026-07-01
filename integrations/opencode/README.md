# OpenCode Adapter

This directory provides the OpenCode adapter for `memory-tencentdb`.

OpenCode uses the same Gateway-centered strategy as the Codex and Claude Code adapters:

- MCP exposes explicit memory search tools.
- A project-local OpenCode plugin maps chat/session events to Gateway recall, capture, and session flush calls.
- Platform-specific behavior stays in this directory. The memory core still lives behind the Gateway and `TdaiCore`.

## Capabilities

- Explicit memory search tools exposed over MCP:
  - `memory_tencentdb_memory_search`
  - `memory_tencentdb_conversation_search`
- `chat.message` performs pre-prompt recall and injects a synthetic `<relevant-memories>` text part into the outgoing message.
- `message.updated` and `message.part.updated` collect assistant output for the current session.
- `session.idle` / completed assistant messages capture the reconstructed user/assistant turn.
- If the plugin cannot reconstruct a complete turn, it calls `/session/end` instead of writing partial memory.

## Files

- `opencode.json.example`: OpenCode config example using `deepseek/deepseek-v4-flash` and the memory MCP server.
- `plugin.js`: OpenCode plugin implementation.
- `../../src/integrations/shared/mcp-server.ts`: shared MCP-to-Gateway bridge.
- `../../src/integrations/shared/gateway-client.ts`: shared HTTP client helpers for the Gateway contract.
- `../../bin/memory-tencentdb-mcp.mjs`: thin Node wrapper for the MCP implementation.

## Setup

1. Start the memory Gateway.

```bash
memory-tencentdb-gateway
```

When developing from this repository, running the source server also works.

```bash
pnpm exec tsx src/gateway/server.ts
```

2. Make the adapter binaries available.

Install the package globally, link it during local development, or point the MCP command directly at this repository's `bin/memory-tencentdb-mcp.mjs`.

```bash
pnpm link --global
```

3. Copy the plugin into an OpenCode plugin directory.

For a project-local setup:

```bash
mkdir -p .opencode/plugins
cp integrations/opencode/plugin.js .opencode/plugins/memory-tencentdb.js
```

OpenCode loads JavaScript or TypeScript files in `.opencode/plugins/` automatically at startup.

4. Merge `opencode.json.example` into the project `opencode.json`.

If you already have a model/provider config, keep that config and merge only the `mcp` entry.

5. Configure the Gateway location if needed.

```bash
export MEMORY_TENCENTDB_GATEWAY_URL="http://127.0.0.1:8420"
export MEMORY_TENCENTDB_OPENCODE_AUDIT_LOG=".opencode/memory-tencentdb-audit.jsonl"
```

## Notes

OpenCode's stable MCP surface is used for explicit retrieval. The plugin adds automatic lifecycle behavior where OpenCode exposes enough message/session information.

Complete turn capture depends on seeing both the user prompt and the completed assistant message. When that is not available, the plugin flushes the session instead of persisting an incomplete turn.

The example pins `deepseek/deepseek-v4-flash` because the issue #235 proof run used DeepSeek V4 Flash as the OpenCode model. Users can replace it with any OpenCode model ID that is configured locally.
