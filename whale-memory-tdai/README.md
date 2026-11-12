# Memory (TencentDB) — Whale plugin

Bridges [TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory)
into **Whale** via its hooks + MCP extension system, using the **sidecar HTTP**
pattern (the `TdaiGateway` REST server already in this repo).

## Layout

```
whale-plugin.toml           # plugin manifest
hooks.toml                  # SessionStart / UserPromptSubmit / Stop hooks
mcp.json                    # MCP server (search tools)
scripts/
  health.py                 # SessionStart  -> GET  /health
  recall.py                 # UserPromptSubmit -> POST /recall   (inject context)
  capture.py                # Stop          -> POST /capture  (non-blocking)
commands/memory.md          # /memory-tencentdb:memory slash command
rules/memory-hint.md        # injected at session start
mcp-bridge.js               # stdio MCP server -> /search/*
```

## Requirements

- A running `TdaiGateway` on `http://127.0.0.1:8420`
  (override via `TDAI_GATEWAY_URL`).

## Install

```
whale plugin install ./whale-memory-tdai
whale plugin enable memory-tencentdb
```

Whale plugins are disabled by default after install. The MCP server exposes
`search_memories` and `search_conversations`.
