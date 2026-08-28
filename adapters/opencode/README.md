# TencentDB Agent Memory — OpenCode Adapter

This adapter integrates [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) into [OpenCode](https://opencode.ai), exposing explicit memory recall tools to the OpenCode coding agent via the Model Context Protocol (MCP).

### Scope & Capabilities

- **Explicit Recall & Search:** Exposes `tdai_memory_search` (atomic memory search via `/v3/atomic/search`) and `tdai_conversation_search` (raw dialogue search via `/v3/conversation/search`).
- **No Background Capture:** This MCP adapter is an on-demand search surface. It does **not** automatically hook OpenCode `session.idle` events to capture transcripts in the background, nor does it perform automatic system prompt injection.

---

## Prerequisites

| Requirement | Version |
|---|---|
| [OpenCode](https://opencode.ai/docs) | >= 0.1.0 |
| TencentDB Agent Memory Gateway | Running locally (default port `8420`) |
| Node.js | >= 22.16.0 |

> **Start the Gateway first.**
> Follow the [Quick Start](https://github.com/TencentCloud/TencentDB-Agent-Memory#quick-start) to launch the memory gateway before proceeding.

---

## Installation

### Step 1 — Configure the MCP server in `opencode.json`

Add the TencentDB memory MCP server to your OpenCode configuration (`~/.config/opencode/opencode.json`):

```jsonc
{
  "mcp": {
    "tdai-memory": {
      "type": "stdio",
      "command": "node",
      "args": ["<path-to-this-adapter>/mcp-server.mjs"],
      "env": {
        "TDAI_GATEWAY_URL": "http://localhost:8420",
        "TDAI_MEMORY_API_KEY": "your-user-key",
        "TDAI_MEMORY_SERVICE_ID": "default",
        "TDAI_TEAM_ID": "default",
        "TDAI_AGENT_ID": "opencode",
        "TDAI_USER_ID": "default"
      }
    }
  }
}
```

Replace `<path-to-this-adapter>` with the absolute path to this directory, and `your-user-key` with your user/business key.

### Step 2 — Add memory instructions via OpenCode Rules

Create or append to `AGENTS.md` in your project root (or `~/.config/opencode/AGENTS.md` globally):

```markdown
## Memory Instructions

You have access to two TencentDB memory tools:
- `tdai_memory_search`: Search long-term atomic memory (L1/L2) for relevant facts, conventions, or past decisions
- `tdai_conversation_search`: Search raw past conversation history (L0)

Before starting any task, call `tdai_memory_search` with the task description to recall relevant context.
```

### Step 3 — Verify

Start OpenCode and run `/tools` — you should see `tdai_memory_search` and `tdai_conversation_search` listed.

---

## How It Works

The adapter is a thin MCP stdio server that proxies tool calls to the TencentDB Agent Memory v3 Gateway HTTP API with tenant isolation parameters.

```
OpenCode session
  |
  +-- [tool call] tdai_memory_search("task description")
  |     --> POST /v3/atomic/search { team_id, agent_id, user_id, query, limit }
  |     <-- returns ranked atomic memory records
  |
  +-- [tool call] tdai_conversation_search("keyword")
        --> POST /v3/conversation/search { team_id, agent_id, user_id, query, limit }
        <-- returns matching conversation excerpts
```

---

## Configuration Reference

| Environment Variable | Default | Description |
|---|---|---|
| `TDAI_GATEWAY_URL` | `http://localhost:8420` | Memory gateway base URL |
| `TDAI_MEMORY_API_KEY` | `""` | User or business API key (sent via `Authorization: Bearer <key>`) |
| `TDAI_MEMORY_SERVICE_ID` | `default` | Service / space identifier (sent via `x-tdai-service-id`) |
| `TDAI_AGENT_ID` | `opencode` | Agent identifier for memory scoping |
| `TDAI_TEAM_ID` | `default` | Team identifier for memory scoping |
| `TDAI_USER_ID` | `default` | User identifier for memory scoping |
| `TDAI_TASK_ID` | `""` | Optional task identifier for memory scoping |
| `TDAI_RECALL_LIMIT` | `5` | Max memory items to recall per search |
| `TDAI_TIMEOUT_MS` | `5000` | HTTP request timeout in milliseconds |

---

## Running Tests

```bash
node --test adapters/opencode/tests/mcp-server.test.mjs
```

Tests run against a mock gateway verifying the v3 contract — no external services required.

---

## Related

- [Issue #926 — Adapters Wanted](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/926)
- [OpenCode MCP Server Docs](https://opencode.ai/docs/mcp-servers)
- [MCP Protocol Specification](https://modelcontextprotocol.io)
