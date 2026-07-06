# Claude Code Adapter — MCP stdio Memory Server

> 中文版本见 [README_CN.md](./README_CN.md)。
> Built on the [Adapter SDK](../../adapter-sdk/README.md) · Compared with other platforms in
> [PLATFORM-COMPARISON.md](../../../docs/adapters/PLATFORM-COMPARISON.md)

`TdaiMcpServer` exposes the TDAI memory engine to Claude Code (or any MCP client) as five tools
over the MCP **stdio** transport. Hand-rolled protocol (initialize / ping / tools-list /
tools-call subset of spec rev 2025-06-18) — zero new dependencies, matching the repo's
zero-framework Gateway ethos.

## Tools

| Tool | Maps to | Purpose |
| --- | --- | --- |
| `memory_recall` | `MemoryClient.recall` | Load persona/scene/memory context for a query |
| `memory_capture` | `MemoryClient.capture` | Save one user+assistant turn into memory |
| `memory_search` | `MemoryClient.searchMemories` | Search L1 structured memories (type/scene filters) |
| `conversation_search` | `MemoryClient.searchConversations` | Search raw L0 dialogue history |
| `memory_session_end` | `MemoryClient.endSession` | Flush this session's pipeline buffers |

All tools accept an optional `session_key` overriding the server default. `limit` is clamped to
1..20 (default 5), identical to the OpenClaw tool registrations.

## Setup

### 1. Start the memory backend

The default transport is `http` — run the Gateway first:

```bash
npm run gateway          # TdaiGateway on http://127.0.0.1:8420
```

(Or set `TDAI_ADAPTER_TRANSPORT=in-process` to embed the engine in the MCP server process —
no gateway needed; the store lives under `TDAI_DATA_DIR`.)

### 2. Register with Claude Code

Project-scoped `.mcp.json`:

```json
{
  "mcpServers": {
    "tdai-memory": {
      "command": "node",
      "args": ["--import", "tsx", "/absolute/path/to/repo/src/adapters/claude-code/main.ts"],
      "env": {
        "TDAI_GATEWAY_URL": "http://127.0.0.1:8420",
        "TDAI_SESSION_KEY": "claude-code:my-project"
      }
    }
  }
}
```

CLI equivalent:

```bash
claude mcp add tdai-memory \
  --env TDAI_GATEWAY_URL=http://127.0.0.1:8420 \
  -- node --import tsx /absolute/path/to/repo/src/adapters/claude-code/main.ts
```

### 3. Verify

Inside Claude Code run `/mcp` — `tdai-memory` should list 5 tools. Or smoke-test by hand:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | npm run -s adapter:claude-code
```

## Environment variables

| Variable | Meaning | Default |
| --- | --- | --- |
| `TDAI_ADAPTER_TRANSPORT` | `http` \| `in-process` | `http` |
| `TDAI_GATEWAY_URL` | gateway URL (http transport) | `http://127.0.0.1:8420` |
| `TDAI_GATEWAY_API_KEY` | Bearer token if the gateway enforces auth | unset |
| `TDAI_ADAPTER_TIMEOUT_MS` | per-request timeout toward the gateway | `10000` |
| `TDAI_SESSION_KEY` | default memory session | `claude-code:<cwd basename>` |
| `TDAI_USER_ID` | reserved — sent with recall/capture requests but currently ignored by the engine (single-user) | `default_user` |

## Optional: hook-based auto-capture

Tool-based capture depends on the model choosing to call `memory_capture`. To make capture
automatic (OpenClaw-style), add a Claude Code **Stop hook** that posts the last exchange to the
Gateway when a response finishes. In `~/.claude/settings.json` (or project
`.claude/settings.json`):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.transcript_path' | xargs -I{} sh -c 'jq -rs '\''[.[] | select(.type==\"user\" or .type==\"assistant\")] | .[-2:] | {user_content: (map(select(.type==\"user\"))[-1].message.content // \"\" | if type==\"array\" then (map(select(.type==\"text\").text)|join(\" \")) else . end), assistant_content: (map(select(.type==\"assistant\"))[-1].message.content // \"\" | if type==\"array\" then (map(select(.type==\"text\").text)|join(\" \")) else . end), session_key: \"claude-code:hook\"}'\'' {} | curl -s -X POST \"$TDAI_GATEWAY_URL/capture\" -H \"Content-Type: application/json\" -d @-'"
          }
        ]
      }
    ]
  }
}
```

**Honest limits of this recipe:** the Stop-hook payload and transcript JSONL schema are Claude
Code implementation details that may evolve; text extraction above handles the common
string/array content shapes but not every block type; and capture-on-Stop is best-effort (no
retry/breaker like the Hermes provider). That is why this is documented as an *optional recipe*
rather than shipped as code the adapter depends on — the supported write path is the
`memory_capture` tool.

## Design notes

- **stderr-only logging.** stdout carries protocol lines exclusively; corrupting it is the
  classic stdio-MCP failure mode. `main.ts` builds a stderr logger; the server never `console.log`s.
- **Version negotiation** echoes any of `2025-06-18 / 2025-03-26 / 2024-11-05` and otherwise
  answers with the newest supported revision.
- **Tool errors vs protocol errors.** Engine/transport failures return `isError: true` results
  (the model can see and react); only unknown tools/malformed requests produce JSON-RPC errors.
- **`conversation_search` does not default `session_key`** — there it is a filter, and
  defaulting it would silently hide other sessions' history.
