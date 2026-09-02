# Memory (TencentDB) — Whale plugin

Bridges [TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory)
into **Whale** via its hooks + MCP extension system, using the **sidecar HTTP**
pattern (the `TdaiGateway` REST server already in this repo).

## Layout

```
whale-plugin.toml           # plugin manifest
hooks.toml                  # SessionStart / UserPromptSubmit / Stop / SessionEnd hooks
mcp.json                    # MCP server (search tools)
adapter.js                  # Whale platform descriptor (TDAI Adapter SDK)
scripts/
  health.js                 # SessionStart  -> GET  /health
  recall.js                 # UserPromptSubmit -> POST /recall   (inject context)
  capture.js                # Stop          -> POST /capture
  session-end.js            # SessionEnd    -> POST /session/end (flush)
commands/memory.md          # /memory-tencentdb:memory slash command
rules/memory-hint.md        # injected at session start
mcp-bridge.js               # stdio MCP server -> /search/*
vendor/tdai-sdk/            # vendored TDAI Adapter SDK (sync: npm run build:adapters)
```

All scripts are zero-dependency Node.js thin shims over the shared
[TDAI Adapter SDK](../sdk/tdai-adapter-sdk/README.md); the vendored copy under
`vendor/tdai-sdk/` keeps this directory independently distributable.

## Requirements

- A running `TdaiGateway` on `http://127.0.0.1:8420`
  (override via `TDAI_GATEWAY_URL`; optional Bearer auth via `TDAI_GATEWAY_API_KEY`).

## Install

```
whale plugin install ./whale-memory-tdai
whale plugin enable memory-tencentdb
```

Whale plugins are disabled by default after install. The MCP server exposes
`search_memories` and `search_conversations`.
