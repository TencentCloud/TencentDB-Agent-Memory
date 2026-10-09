# Cursor Adapter

This document describes how to integrate TencentDB-Agent-Memory with **Cursor** using the MCP (Model Context Protocol) server adapter.

## Architecture

```
Cursor (Composer / Agent)
      │
      │  MCP JSON-RPC / stdio
      ▼
┌─────────────────────────────────────────┐
│       CursorMcpServer                   │
│  ┌──────────────────────────────────┐   │
│  │  MCP Tools exposed:              │   │
│  │  • tdai_memory_recall            │   │
│  │  • tdai_memory_capture           │   │
│  │  • tdai_memory_search            │   │
│  │  • tdai_conversation_search      │   │
│  │  • tdai_session_end              │   │
│  └──────────────────────────────────┘   │
│             │                           │
│  ┌──────────▼──────────────────────┐   │
│  │  CursorHostAdapter              │   │
│  │  (session key: env or UUID)     │   │
│  └──────────┬───────────────────────┘   │
│             │                           │
│  ┌──────────▼───────────────────────┐   │
│  │  TdaiCore                        │   │
│  │  L0 capture → L1 extraction      │   │
│  │  L2 scene   → L3 persona         │   │
│  └──────────┬────────────────────────┘   │
│             │                           │
│  ┌──────────▼────────────────────────┐   │
│  │  SQLite-vec / TencentDB VectorDB  │   │
│  └───────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

**Data flow** (per conversation turn):

1. Cursor calls `tdai_memory_recall` → TdaiCore queries L1 memories + L3 persona → context injected
2. Cursor converses with the user
3. Cursor calls `tdai_memory_capture` → TdaiCore records L0 + schedules pipelines

> **No Stop hook.** Cursor does not provide a post-response hook equivalent to Claude Code's Stop hook, so all captures must be triggered explicitly via the `tdai_memory_capture` tool. Include the capture instruction in your Cursor Rule.

## Session identity

Cursor runs one MCP server per workspace (not per conversation). The default session key is a **UUID stable for the lifetime of the server process** — all conversations within one Cursor window share a session until the server restarts.

For stricter isolation you can:
- **Per-project key**: Set `TDAI_SESSION_KEY` in the MCP server env to a fixed string (e.g. `my-project-2026`). All conversations in that project share this key across restarts.
- **Per-conversation key**: Instruct Cursor (via the Rule below) to generate a timestamp-based key at the start of each conversation and pass it on every tool call.

## Quick Start

### 1. Install the package

```bash
npm install -g @tencentdb-agent-memory/memory-tencentdb
# or from source:
cd TencentDB-Agent-Memory && npm install
```

### 2. Add the MCP server to Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project-scoped):

```json
{
  "mcpServers": {
    "tdai-memory": {
      "command": "tdai-cursor-mcp",
      "env": {
        "TDAI_DATA_DIR": "/Users/you/.tdai/cursor",
        "TDAI_LLM_BASE_URL": "https://api.openai.com/v1",
        "TDAI_LLM_API_KEY": "sk-your-key",
        "TDAI_LLM_MODEL": "gpt-4o"
      }
    }
  }
}
```

When running from source, use full paths:

```json
{
  "mcpServers": {
    "tdai-memory": {
      "command": "node",
      "args": ["/path/to/TencentDB-Agent-Memory/bin/tdai-cursor-mcp.mjs"],
      "env": {
        "TDAI_DATA_DIR": "/Users/you/.tdai/cursor",
        "TDAI_LLM_BASE_URL": "https://api.openai.com/v1",
        "TDAI_LLM_API_KEY": "sk-your-key",
        "TDAI_LLM_MODEL": "gpt-4o"
      }
    }
  }
}
```

After saving, open the Cursor Settings → MCP panel and verify the server shows a green status dot.

### 3. Add a Cursor Rule

Create `.cursor/rules/memory.mdc` in your project:

```markdown
---
description: Persistent memory via TencentDB-Agent-Memory
alwaysApply: true
---

## Memory

You have access to a persistent memory system via the `tdai-memory` MCP tools.

**At the start of every conversation**, call `tdai_memory_recall` with the
user's first message as the query. Inject the returned context into your
reasoning before responding.

**After producing your final response**, call `tdai_memory_capture` with both
the user's message and your response. Pass a stable `session_key` for this
conversation — use the format `cursor-{YYYYMMDD-HHMMSS}` (generate it once at
the start of the conversation and reuse it for all subsequent tool calls).

Use `tdai_memory_search` when the user asks about past decisions, preferences,
or any topic where historical knowledge would help.

Use `tdai_conversation_search` to find specific past exchanges when
`tdai_memory_search` doesn't return sufficient results.
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TDAI_DATA_DIR` | No | `~/.tdai/cursor` | Storage directory for all memory data |
| `TDAI_LLM_BASE_URL` | **Yes** | — | OpenAI-compatible API base URL |
| `TDAI_LLM_API_KEY` | **Yes** | — | API key for the LLM endpoint |
| `TDAI_LLM_MODEL` | **Yes** | — | Model name (e.g. `gpt-4o`, `deepseek-chat`) |
| `TDAI_LLM_MAX_TOKENS` | No | `8192` | Max output tokens for extraction pipelines |
| `TDAI_LLM_TIMEOUT_MS` | No | `120000` | LLM request timeout in milliseconds |
| `TDAI_LLM_DISABLE_THINKING` | No | — | Disable reasoning tokens: `vllm`, `deepseek`, `anthropic`, … |
| `TDAI_USER_ID` | No | `default_user` | Reserved — recorded but **not yet used to scope storage** |
| `TDAI_SESSION_KEY` | No | UUID per process | Fixed session key for cross-session continuity |
| `TDAI_MEMORY_CONFIG` | No | — | JSON string with `MemoryTdaiConfig` overrides |
| `TDAI_API_KEY` | No | — | Bearer token to authenticate MCP clients |

## MCP Tools Reference

### `tdai_memory_recall`

Retrieve relevant memories before a conversation turn.

```json
{
  "query": "the user's current message",
  "session_key": "cursor-20260125-143000"
}
```

Returns formatted memory context (L1 episodic facts + L3 persona) ready to inject into the system prompt.

### `tdai_memory_capture`

Record a completed conversation turn.

```json
{
  "user_text": "How do I set up authentication?",
  "assistant_text": "You can use JWT tokens with the following steps...",
  "session_key": "cursor-20260125-143000"
}
```

Returns capture metrics. Background L1/L2/L3 extraction runs asynchronously.

### `tdai_memory_search`

Search L1 structured memories with filters.

```json
{
  "query": "user's preferred coding style",
  "limit": 5,
  "type": "episodic",
  "scene": "coding"
}
```

`type` can be `persona`, `episodic`, or `instruction`. `scene` is a topic label.

### `tdai_conversation_search`

Search raw L0 conversation history.

```json
{
  "query": "database migration last week",
  "limit": 5,
  "session_key": "cursor-20260125-143000"
}
```

Omit `session_key` to search across all sessions.

### `tdai_session_end`

Flush pending L1/L2/L3 extraction pipelines so this session's memories become
durable immediately instead of waiting for the background scheduler.

```json
{
  "session_key": "cursor-20260125-143000"
}
```

Omit `session_key` to use the session key from the environment. Call this when
the user says goodbye or explicitly ends the conversation.

## Comparison: Claude Code vs Cursor Adapters

| Aspect | **Claude Code MCP** | **Cursor MCP** |
|---|---|---|
| Server binary | `tdai-claude-code-mcp` | `tdai-cursor-mcp` |
| Config location | `.claude/settings.json` | `~/.cursor/mcp.json` |
| Memory instructions | `.claude/CLAUDE.md` | `.cursor/rules/memory.mdc` |
| Session ID source | `CLAUDE_CODE_SESSION_ID` env | `TDAI_SESSION_KEY` or UUID per process |
| Automatic capture | Stop hook (`tdai-capture-hook`) | Not available — explicit only |
| Capture mode | Automatic (hook) or explicit (tool) | Explicit tool call only |
| Default data dir | `~/.tdai/claude-code` | `~/.tdai/cursor` |
| Host type | `claude-code` | `cursor` |

The Cursor adapter inherits all MCP infrastructure from `McpServerBase` and adds no platform-specific logic — the only difference is the session key strategy and the absence of Stop hook support.

## Troubleshooting

**Server does not appear in Cursor Settings → MCP**: Check that `tsx` is installed (`npm ls tsx`) and all required env vars are set. Verify the `.cursor/mcp.json` is valid JSON.

**No memories returned**: The first few turns only write to L0. L1 extraction runs after `pipeline.everyNConversations` turns (default: 5). Use `tdai_conversation_search` for immediate access to raw history.

**Sessions not persisting across restarts**: Set `TDAI_SESSION_KEY` to a fixed value (e.g. your project name) in the MCP server env. Without it, the server generates a new UUID on each restart.

**High latency on recall**: Set `recall.timeoutMs` to a lower value via `TDAI_MEMORY_CONFIG` to cap the maximum wait time. Keyword-only strategy (`recall.strategy: "keyword"`) is faster when embedding is not needed.
