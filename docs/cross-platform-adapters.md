# Cross-Platform Adapters

TencentDB Agent Memory keeps the memory engine host-neutral. Platform-specific
code should translate host lifecycle events into `TdaiCore` calls, or reuse the
Gateway HTTP API when the platform cannot run the core in-process.

## Architecture

![Cross-platform adapter architecture](./assets/cross-platform-adapters.svg)

## Core Engine Boundary

`TdaiCore` is the stable integration boundary for in-process hosts:

| Core method | Capability | Existing host mapping |
| --- | --- | --- |
| `handleBeforeRecall()` | Recall relevant memories before a model turn | OpenClaw `before_prompt_build`, Hermes/Gateway `/recall` |
| `handleTurnCommitted()` | Capture a completed user/assistant turn | OpenClaw `agent_end`, Hermes/Gateway `/capture` |
| `searchMemories()` | Search L1 structured memories | `tdai_memory_search`, Gateway `/search/memories` |
| `searchConversations()` | Search L0 raw conversation history | `tdai_conversation_search`, Gateway `/search/conversations` |
| `handleSessionEnd()` | Flush session-scoped buffered work | Hermes/Gateway `/session/end` |

Hosts that can provide a `HostAdapter` and `LLMRunnerFactory` can call
`TdaiCore` directly. Hosts that cannot link this package in-process should use
the Gateway and implement a thin client adapter.

## Existing Adapter Patterns

| Adapter | Runtime shape | Data flow | When to use |
| --- | --- | --- | --- |
| OpenClaw plugin | In-process TypeScript plugin | OpenClaw hooks/tools -> `OpenClawHostAdapter` -> `TdaiCore` | Host exposes plugin lifecycle hooks and an embedded LLM runner |
| Hermes Provider | Python provider + Node.js sidecar | Hermes lifecycle/tools -> Provider HTTP client -> Gateway -> `StandaloneHostAdapter` -> `TdaiCore` | Host cannot run the TypeScript core in-process or prefers process isolation |
| MCP stdio adapter | MCP tool server + Gateway | MCP client tool call -> `memory-tencentdb-mcp` -> Gateway -> `TdaiCore` | Claude Code, Codex, or any MCP-capable client that can launch a stdio server |

## MCP Adapter

The MCP adapter is a new cross-platform integration layer. It exposes the
Gateway as MCP tools without depending on OpenClaw or Hermes APIs.

### Tools

| MCP tool | Gateway endpoint | Purpose |
| --- | --- | --- |
| `memory_tencentdb_health` | `GET /health` | Check Gateway availability |
| `memory_tencentdb_recall` | `POST /recall` | Retrieve memory context for the current task |
| `memory_tencentdb_capture` | `POST /capture` | Write a completed user/assistant turn |
| `memory_tencentdb_memory_search` | `POST /search/memories` | Search structured memories |
| `memory_tencentdb_conversation_search` | `POST /search/conversations` | Search raw conversation history |
| `memory_tencentdb_session_end` | `POST /session/end` | Flush a session |

### Build

```bash
npm run build:mcp-adapter
```

The package-level build also includes the MCP adapter:

```bash
npm run build
```

### Run

Start or auto-manage the Gateway separately, then launch the MCP adapter:

```bash
memory-tencentdb-mcp
```

For local source checkouts:

```bash
npm run memory-tencentdb-mcp
```

### Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `MEMORY_TENCENTDB_GATEWAY_URL` | `http://127.0.0.1:8420` | Full Gateway URL. Overrides host/port. |
| `MEMORY_TENCENTDB_GATEWAY_HOST` | `127.0.0.1` | Gateway host when URL is unset. |
| `MEMORY_TENCENTDB_GATEWAY_PORT` | `8420` | Gateway port when URL is unset. |
| `MEMORY_TENCENTDB_GATEWAY_API_KEY` | unset | Optional Bearer token sent to the Gateway. |
| `TDAI_GATEWAY_API_KEY` | unset | Fallback Bearer token name, shared with Gateway config. |
| `MEMORY_TENCENTDB_MCP_SESSION_KEY` | `mcp-default` | Default session key used by recall/capture/session_end. |
| `MEMORY_TENCENTDB_MCP_TIMEOUT_MS` | `10000` | Gateway request timeout in milliseconds. |

### Example MCP Client Entry

```json
{
  "mcpServers": {
    "memory-tencentdb": {
      "command": "memory-tencentdb-mcp",
      "env": {
        "MEMORY_TENCENTDB_GATEWAY_URL": "http://127.0.0.1:8420",
        "MEMORY_TENCENTDB_MCP_SESSION_KEY": "codex-main"
      }
    }
  }
}
```

## Adapter Implementation Checklist

When adding another platform adapter:

1. Decide whether the platform should call `TdaiCore` in-process or talk to
   the Gateway over HTTP.
2. Map platform lifecycle events to `recall`, `capture`, `search`, and
   `session_end`.
3. Preserve `session_key` consistently so L0/L1 records stay scoped to the
   right conversation.
4. Keep authentication at the Gateway boundary when using HTTP.
5. Document startup, configuration, and failure behavior for operators.
