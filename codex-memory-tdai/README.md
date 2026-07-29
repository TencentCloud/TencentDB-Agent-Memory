# memory-tdai (Codex plugin)

Bridges [TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory)
into the OpenAI **Codex CLI** via its hooks + MCP extension system. Uses the
**sidecar HTTP** pattern: the `TdaiGateway` (already part of this repo) serves
memory over REST, and this plugin's hooks call it at lifecycle events.

## Layout

```
.codex-plugin/plugin.json   # plugin manifest
hooks/hooks.json            # SessionStart / UserPromptSubmit / Stop / SessionEnd hooks
.mcp.json                   # MCP server (search tools)
adapter.js                  # Codex platform descriptor (TDAI Adapter SDK)
scripts/
  health.js                 # SessionStart  -> GET  /health
  recall.js                 # UserPromptSubmit -> POST /recall   (inject context)
  capture.js                # Stop          -> POST /capture  (fire-and-forget)
  session-end.js            # SessionEnd    -> POST /session/end (flush)
skills/memory-usage/SKILL.md
mcp-bridge.js               # stdio MCP server -> /search/*
vendor/tdai-sdk/            # vendored TDAI Adapter SDK (sync: npm run build:adapters)
```

All scripts are zero-dependency Node.js thin shims over the shared
[TDAI Adapter SDK](../sdk/tdai-adapter-sdk/README.md); the vendored copy under
`vendor/tdai-sdk/` keeps this directory independently distributable.

## Requirements

- Node.js on PATH (hook scripts and the MCP bridge are zero-dependency
  Node — no bash/jq/curl needed, works on Windows/macOS/Linux).
- A running `TdaiGateway` on `http://127.0.0.1:8420`
  (override via `TDAI_GATEWAY_URL`; optional Bearer auth via `TDAI_GATEWAY_API_KEY`).
- Codex feature flag in `~/.codex/config.toml`:
  ```toml
  [features]
  codex_hooks = true
  ```

## Install (local marketplace)

```
codex plugin marketplace add <this-repo>
codex plugin add memory-tdai
```

To remove the plugin, include the marketplace name:

```
codex plugin remove memory-tdai@tencentdb-local
```

Trust the bundled hooks via `/hooks` when prompted. The MCP server exposes
`search_memories` and `search_conversations`.
