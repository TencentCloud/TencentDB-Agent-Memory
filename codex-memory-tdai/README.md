# memory-tdai (Codex plugin)

Bridges [TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory)
into the OpenAI **Codex CLI** via its hooks + MCP extension system. Uses the
**sidecar HTTP** pattern: the `TdaiGateway` (already part of this repo) serves
memory over REST, and this plugin's hooks call it at lifecycle events.

## Layout

```
.codex-plugin/plugin.json   # plugin manifest
hooks/hooks.json            # SessionStart / UserPromptSubmit / Stop hooks
.mcp.json                   # MCP server (search tools)
scripts/
  health.sh                 # SessionStart  -> GET  /health
  recall.sh                 # UserPromptSubmit -> POST /recall   (inject context)
  capture.sh                # Stop          -> POST /capture  (fire-and-forget)
skills/memory-usage/SKILL.md
mcp-bridge.js               # stdio MCP server -> /search/*
```

## Requirements

- A running `TdaiGateway` on `http://127.0.0.1:8420`
  (override via `TDAI_GATEWAY_URL`).
- Codex feature flag in `~/.codex/config.toml`:
  ```toml
  [features]
  codex_hooks = true
  ```

## Install (local marketplace)

```
codex plugin marketplace add <this-repo>
codex plugin install memory-tdai
```

Trust the bundled hooks via `/hooks` when prompted. The MCP server exposes
`search_memories` and `search_conversations`.
