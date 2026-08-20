# TencentDB Agent Memory — OpenCode Adapter

This adapter integrates [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) into [OpenCode](https://opencode.ai), giving the OpenCode coding agent persistent long-term memory across sessions.

Once installed, OpenCode will automatically:
- **Recall** relevant past experiences before each session
- **Capture** conversations and distill them into structured memory (L0 → L1 → L2 → L3)
- **Expose** two read-only search tools: `tdai_memory_search` and `tdai_conversation_search`

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
        "TDAI_ADMIN_KEY": "your-admin-key"
      }
    }
  }
}
```

Replace `<path-to-this-adapter>` with the absolute path to this directory, and `your-admin-key` with your gateway admin key.

### Step 2 — Add memory instructions via OpenCode Rules

Create or append to `AGENTS.md` in your project root (or `~/.config/opencode/AGENTS.md` globally):

```markdown
## Memory Instructions

You have access to two memory tools:
- `tdai_memory_search`: Search long-term memory for relevant facts, preferences, or context
- `tdai_conversation_search`: Search raw past conversation history

Before starting any task, call `tdai_memory_search` with the task description to recall relevant context.
```

### Step 3 — Verify

Start OpenCode and run `/tools` — you should see `tdai_memory_search` and `tdai_conversation_search` listed.

---

## How It Works

The adapter is a thin MCP stdio server that proxies tool calls to the TencentDB Agent Memory gateway HTTP API. All memory extraction and storage (L0→L3 pipeline) is handled by the gateway.

```
OpenCode session
  |
  +-- [tool call] tdai_memory_search("task description")
  |     --> GET /v3/memory/recall { query, limit }
  |     <-- returns ranked memory snippets
  |
  +-- [tool call] tdai_conversation_search("keyword")
        --> GET /v3/conversation/search { query, limit }
        <-- returns matching conversation excerpts
```

---

## Configuration Reference

| Environment Variable | Default | Description |
|---|---|---|
| `TDAI_GATEWAY_URL` | `http://localhost:8420` | Memory gateway base URL |
| `TDAI_ADMIN_KEY` | _(required)_ | Gateway admin API key |
| `TDAI_AGENT_ID` | `opencode` | Agent identifier for memory scoping |
| `TDAI_TEAM_ID` | `default` | Team identifier for memory scoping |
| `TDAI_USER_ID` | `default` | User identifier for memory scoping |
| `TDAI_RECALL_LIMIT` | `5` | Max memory items to recall per search |
| `TDAI_TIMEOUT_MS` | `5000` | HTTP request timeout in milliseconds |

---

## Running Tests

```bash
node --test adapters/opencode/tests/mcp-server.test.mjs
```

Tests run against a fake gateway — no external services required.

---

## Related

- [Issue #926 — Adapters Wanted](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/926)
- [OpenCode MCP Server Docs](https://opencode.ai/docs/mcp-servers)
- [MCP Protocol Specification](https://modelcontextprotocol.io)
