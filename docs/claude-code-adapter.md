# Claude Code Adapter

This document describes how to integrate TencentDB-Agent-Memory with **Claude Code** using the MCP (Model Context Protocol) server adapter.

## Architecture

```
Claude Code (Agent)
      │
      │  MCP JSON-RPC / stdio
      ▼
┌─────────────────────────────────────────┐
│       ClaudeCodeMcpServer               │
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
│  │  ClaudeCodeHostAdapter          │   │
│  │  (session key from env/UUID)    │   │
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

1. Claude calls `tdai_memory_recall` → MCP server drains any pending hook captures → TdaiCore queries L1 memories + L3 persona → Claude injects context
2. Claude converses with the user
3. **Capture — pick one mode (do not use both):**
   - **Automatic (Stop hook):** Claude Code fires the hook → `tdai-capture-hook` appends to `hook-queue.jsonl` → MCP server drains the queue on next recall or every 30 s in the background
   - **Manual (explicit tool call):** Claude calls `tdai_memory_capture` → TdaiCore records L0 + schedules pipelines

> **Warning — do not enable both modes at once.** If the Stop hook is active and CLAUDE.md also instructs Claude to call `tdai_memory_capture`, every turn is written twice. TdaiCore deduplicates at the L1 level, not L0, so duplicate raw records accumulate. Choose one mode and stick to it.

## Prerequisites

- Node.js ≥ 18
- An OpenAI-compatible LLM endpoint (OpenAI, DeepSeek, local vLLM, etc.)
- Claude Code ≥ 1.x with MCP support

## Quick Start

### 1. Install the package

```bash
npm install -g @tencentdb-agent-memory/memory-tencentdb
# or from source:
cd TencentDB-Agent-Memory && npm install
```

### 2. Add the MCP server and Stop hook to Claude Code

Edit `~/.claude/settings.json` (or `.claude/settings.json` in your project).
Add both the MCP server and the Stop hook so captures happen automatically:

```json
{
  "mcpServers": {
    "tdai-memory": {
      "command": "tdai-claude-code-mcp",
      "env": {
        "TDAI_DATA_DIR": "/Users/you/.tdai",
        "TDAI_LLM_BASE_URL": "https://api.openai.com/v1",
        "TDAI_LLM_API_KEY": "sk-your-key",
        "TDAI_LLM_MODEL": "gpt-4o"
      }
    }
  },
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "TDAI_DATA_DIR=/Users/you/.tdai tdai-capture-hook"
      }]
    }]
  }
}
```

> **Why `TDAI_DATA_DIR` in the hook command?**
> The Stop hook runs as a separate shell process and does not inherit `mcpServers.env`.
> Prefix the command with the env var, or `export TDAI_DATA_DIR=...` in your shell profile.
> Both must point to the **same directory** so the hook queue is visible to the MCP server.

When running from source, use full paths:

```json
{
  "mcpServers": {
    "tdai-memory": {
      "command": "node",
      "args": ["/path/to/TencentDB-Agent-Memory/bin/tdai-claude-code-mcp.mjs"],
      "env": {
        "TDAI_DATA_DIR": "/Users/you/.tdai",
        "TDAI_LLM_BASE_URL": "https://api.openai.com/v1",
        "TDAI_LLM_API_KEY": "sk-your-key",
        "TDAI_LLM_MODEL": "gpt-4o"
      }
    }
  },
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "TDAI_DATA_DIR=/Users/you/.tdai node /path/to/TencentDB-Agent-Memory/bin/tdai-capture-hook.mjs"
      }]
    }]
  }
}
```

### 3. Add memory instructions to CLAUDE.md

Create or update `.claude/CLAUDE.md` in your project. Choose the template that
matches your capture mode.

**Automatic mode (Stop hook active — recommended):**

```markdown
## Memory

You have access to a persistent memory system via the `tdai-memory` MCP tools.
Turns are captured automatically via the Stop hook — do NOT call
`tdai_memory_capture` (it would create duplicate records).

**At the start of every conversation turn**, call `tdai_memory_recall` with the
user's message as the query. Inject the returned context into your reasoning
before responding.

Use `tdai_memory_search` when the user asks about past decisions, preferences,
or any topic where historical knowledge would help.

Use `tdai_conversation_search` to find specific past exchanges when
`tdai_memory_search` doesn't return sufficient results.
```

**Manual mode (no Stop hook):**

```markdown
## Memory

You have access to a persistent memory system via the `tdai-memory` MCP tools.

**At the start of every conversation turn**, call `tdai_memory_recall` with the
user's message as the query. Inject the returned context into your reasoning
before responding.

**After producing your final response**, call `tdai_memory_capture` with both
the user's message and your response. Use the same `session_key` across the
entire conversation (you can use `CLAUDE_CODE_SESSION_ID` from your environment
or any stable string).

Use `tdai_memory_search` when the user asks about past decisions, preferences,
or any topic where historical knowledge would help.

Use `tdai_conversation_search` to find specific past exchanges when
`tdai_memory_search` doesn't return sufficient results.
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TDAI_DATA_DIR` | No | `~/.tdai/claude-code` | Storage directory for all memory data |
| `TDAI_LLM_BASE_URL` | **Yes** | — | OpenAI-compatible API base URL |
| `TDAI_LLM_API_KEY` | **Yes** | — | API key for the LLM endpoint |
| `TDAI_LLM_MODEL` | **Yes** | — | Model name (e.g. `gpt-4o`, `deepseek-chat`) |
| `TDAI_LLM_MAX_TOKENS` | No | `8192` | Max output tokens for extraction pipelines |
| `TDAI_LLM_TIMEOUT_MS` | No | `120000` | LLM request timeout in milliseconds |
| `TDAI_LLM_DISABLE_THINKING` | No | — | Disable reasoning tokens: `vllm`, `deepseek`, `anthropic`, … |
| `TDAI_USER_ID` | No | `default_user` | Reserved — recorded but **not yet used to scope storage** |
| `TDAI_SESSION_KEY` | No | `CLAUDE_CODE_SESSION_ID` or UUID | Default session key |
| `TDAI_MEMORY_CONFIG` | No | — | JSON string with `MemoryTdaiConfig` overrides |
| `TDAI_API_KEY` | No | — | Bearer token to authenticate MCP clients |

## MCP Tools Reference

### `tdai_memory_recall`

Retrieve relevant memories before a conversation turn.

```json
{
  "query": "the user's current message",
  "session_key": "my-session-123"
}
```

Returns formatted memory context (L1 episodic facts + L3 persona) ready to inject into the system prompt.

### `tdai_memory_capture`

Record a completed conversation turn.

```json
{
  "user_text": "How do I set up authentication?",
  "assistant_text": "You can use JWT tokens with the following steps...",
  "session_key": "my-session-123",
  "session_id": "optional-sub-session"
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
  "session_key": "my-session-123"
}
```

Omit `session_key` to search across all sessions.

### `tdai_session_end`

Flush pending L1/L2/L3 extraction pipelines so this session's memories become
durable immediately instead of waiting for the background scheduler.

```json
{
  "session_key": "my-session-123"
}
```

Omit `session_key` to use `CLAUDE_CODE_SESSION_ID`. Call this when the user says
goodbye or explicitly ends the conversation.

## Comparison: OpenClaw vs Hermes vs MCP Adapters

| Aspect | OpenClaw Plugin | Hermes Provider | **Claude Code MCP** | **Cursor MCP** |
|---|---|---|---|---|
| Language | TypeScript | Python | TypeScript | TypeScript |
| Transport | In-process SDK hooks | HTTP Gateway | MCP stdio JSON-RPC | MCP stdio JSON-RPC |
| Recall trigger | `before_prompt_build` hook | `prefetch()` call | `tdai_memory_recall` tool | `tdai_memory_recall` tool |
| Capture trigger | `agent_end` hook | `sync_turn()` call | Stop hook (auto) or tool | `tdai_memory_capture` tool |
| Session ID source | OpenClaw session key | Hermes session kwargs | `CLAUDE_CODE_SESSION_ID` env | `TDAI_SESSION_KEY` or UUID |
| Infrastructure | None (in-process) | Separate HTTP process | None (subprocess per session) | None (one server per workspace) |
| Config format | `openclaw.plugin.json` | `plugin.yaml` + env | `.claude/settings.json` | `~/.cursor/mcp.json` |
| LLM runner | `OpenClawLLMRunner` | `StandaloneLLMRunner` | `StandaloneLLMRunner` | `StandaloneLLMRunner` |

The key architectural difference is that Claude Code uses the MCP protocol (JSON-RPC over stdio) rather than an in-process SDK or an HTTP intermediary. The adapter exposes the same five TdaiCore operations (`recall`, `capture`, `search_memories`, `search_conversations`, `session_end`) as MCP tools that Claude can call within its reasoning loop. Those five operations live in a single transport-neutral facade (`MemoryOperations`) shared with the HTTP adapters, so both transports always expose the same capability set.

## Implementation Details

### File structure

```
src/adapters/claude-code/
├── index.ts           # Barrel re-exports
├── types.ts           # ClaudeCodeHostAdapterOptions, ClaudeCodeMcpServerOptions
├── host-adapter.ts    # ClaudeCodeHostAdapter (implements HostAdapter)
└── mcp-server.ts      # ClaudeCodeMcpServer (MCP JSON-RPC stdio server)

bin/
├── tdai-claude-code-mcp.ts   # TypeScript entry: reads env vars, starts server
└── tdai-claude-code-mcp.mjs  # Thin launcher: runs .ts via tsx
```

### Session key strategy

Claude Code sets `CLAUDE_CODE_SESSION_ID` in the environment for each session. The adapter reads this variable automatically as the default session key, so the same key is used consistently across all tool calls within one conversation — no manual key management required.

### LLM runner

The adapter reuses `StandaloneLLMRunnerFactory` (same as the Gateway/Hermes adapter), which calls any OpenAI-compatible API. This means L1/L2/L3 extraction pipelines work identically to the Gateway adapter.

### Adding embedding support

Embedding-based recall requires an embedding provider. Add to `TDAI_MEMORY_CONFIG`:

```json
{
  "embedding": {
    "provider": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "model": "text-embedding-3-small",
    "dimensions": 1536
  },
  "recall": {
    "strategy": "hybrid"
  }
}
```

## Troubleshooting

**Server does not start**: Check that `tsx` is installed (`npm ls tsx`) and that all required env vars are set.

**No memories returned**: The first few turns only write to L0. L1 extraction runs after `pipeline.everyNConversations` turns (default: 5). Use `tdai_conversation_search` for immediate access to raw history.

**High latency on recall**: Set `recall.timeoutMs` to a lower value via `TDAI_MEMORY_CONFIG` to cap the maximum wait time. Keyword-only strategy (`recall.strategy: "keyword"`) is faster when embedding is not needed.
