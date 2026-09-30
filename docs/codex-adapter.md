# Codex CLI Adapter

Connects OpenAI Codex CLI to TencentDB-Agent-Memory over MCP stdio.

```
┌─────────────────────────────────────────┐
│       CodexMcpServer                    │
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
│  │  CodexHostAdapter               │   │
│  │  (session key: env or UUID)     │   │
│  └──────────┬──────────────────────┘   │
└─────────────┼───────────────────────────┘
              ▼
        ┌───────────┐
        │ TdaiCore  │
        └───────────┘
```

Both classes together are under 40 lines — everything else comes from
`McpServerBase` and `McpHostAdapterBase`.

## Install

```bash
npm install -g @tencentdb-agent-memory/memory-tencentdb
```

## Configure

Codex CLI reads MCP servers from `~/.codex/config.toml`:

```toml
[mcp_servers]

[mcp_servers.tdai-memory]
command = "tdai-codex-mcp"

[mcp_servers.tdai-memory.env]
TDAI_DATA_DIR = "~/.tdai/codex"
TDAI_LLM_BASE_URL = "https://api.deepseek.com/v1"
TDAI_LLM_API_KEY = "sk-..."
TDAI_LLM_MODEL = "deepseek-chat"
```

See [`bin/env-common.ts`](../bin/env-common.ts) for every supported variable.

## Capture is explicit

Codex CLI has no Stop-hook equivalent, so nothing captures turns automatically.
The model must call `tdai_memory_capture` itself. Instruct it in
`~/.codex/instructions.md`:

```markdown
## Memory

At the start of each task, call `tdai_memory_recall` with the user's request
to load relevant prior context.

After completing a substantive exchange, call `tdai_memory_capture` with the
user's message and your response.

When the user ends the conversation, call `tdai_session_end` to flush pending
extraction pipelines.
```

Capture reliability therefore depends on the model following instructions —
the same tier as Cursor, and weaker than Claude Code's hook-driven capture.

## Session keys

Codex CLI does not currently expose a per-session environment variable. The
adapter resolves the session key in this order:

```
explicit session_key tool arg  →  CODEX_SESSION_ID  →  process-stable UUID
```

With the UUID fallback, each server restart begins a new session. Set
`TDAI_SESSION_KEY` to a fixed value for continuity across restarts:

```toml
[mcp_servers.tdai-memory.env]
TDAI_SESSION_KEY = "my-project-main"
```

## Verify

```bash
TDAI_LLM_BASE_URL=https://api.deepseek.com/v1 \
TDAI_LLM_API_KEY=sk-... \
TDAI_LLM_MODEL=deepseek-chat \
npx tdai-codex-mcp
```

The server logs `[mcp] MCP server started — listening on stdin` and waits for
JSON-RPC. Send `{"jsonrpc":"2.0","id":1,"method":"tools/list"}` to confirm all
five tools are advertised.

## Tool reference

Identical across all MCP platforms — see
[claude-code-adapter.md](claude-code-adapter.md#tool-reference) for request
shapes.

## Comparison with the other MCP platforms

| Aspect | Claude Code | Cursor | **Codex CLI** |
|---|---|---|---|
| Server binary | `tdai-claude-code-mcp` | `tdai-cursor-mcp` | `tdai-codex-mcp` |
| Config file | `.claude/settings.json` | `~/.cursor/mcp.json` | `~/.codex/config.toml` |
| Config format | JSON | JSON | TOML |
| Capture trigger | Stop hook (automatic) | LLM tool call | LLM tool call |
| Capture reliability | High | LLM-dependent | LLM-dependent |
| Session env var | `CLAUDE_CODE_SESSION_ID` | `TDAI_SESSION_KEY` | none (UUID fallback) |
| Instruction file | `CLAUDE.md` | Cursor Rule | `~/.codex/instructions.md` |

See [architecture.md](architecture.md) for the full cross-platform picture.
