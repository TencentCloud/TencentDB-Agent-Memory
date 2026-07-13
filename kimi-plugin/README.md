# Kimi Code CLI Plugin — TencentDB Agent Memory

This directory contains the Kimi Code CLI plugin manifest for TencentDB Agent Memory.

The plugin starts an MCP server that forwards memory tool calls to the TDAI Gateway over HTTP.

## Prerequisites

1. The TDAI Gateway must be running. See the main project README for startup instructions.
   Default URL: `http://127.0.0.1:8420`.
2. If your gateway requires authentication, set `TDAI_GATEWAY_API_KEY` in the environment.

## Installation

In your Kimi Code CLI configuration, add the MCP server:

```json
{
  "mcpServers": {
    "memory-tencentdb": {
      "command": "node",
      "args": ["/path/to/package/bin/kimicode-memory-mcp.mjs"],
      "env": {
        "TDAI_GATEWAY_URL": "http://127.0.0.1:8420"
      }
    }
  }
}
```

If authentication is enabled:

```json
{
  "mcpServers": {
    "memory-tencentdb": {
      "command": "node",
      "args": ["/path/to/package/bin/kimicode-memory-mcp.mjs"],
      "env": {
        "TDAI_GATEWAY_URL": "http://127.0.0.1:8420",
        "TDAI_GATEWAY_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Provided Tools

- `tdai_recall` — recall relevant memory context for the current session.
- `tdai_capture` — capture a user/assistant exchange into memory.
- `tdai_memory_search` — search across stored memories.
- `tdai_conversation_search` — search across stored conversations.
- `tdai_session_end` — signal the end of a session.
