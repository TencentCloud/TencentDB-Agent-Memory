# Codex Adapter

The Codex adapter is a local STDIO MCP server backed by the existing TDAI
Gateway. It exposes recall, capture, L1 search, L0 search, and session flush
without duplicating the memory engine.

## Prerequisites

1. Node.js 22.16 or newer.
2. A healthy Gateway at `http://127.0.0.1:8420`.
3. The published package, or a local build of this repository.

The zero-key path supports L0 capture and conversation search. Set
`TDAI_LLM_API_KEY`, `TDAI_LLM_BASE_URL`, and `TDAI_LLM_MODEL` on the Gateway
to enable L1–L3 extraction.

## Published-package configuration

Add this to `~/.codex/config.toml`, or to `.codex/config.toml` in a trusted
project:

```toml
[mcp_servers.tencentdb_memory]
command = "npx"
args = [
  "-y",
  "--package",
  "@tencentdb-agent-memory/memory-tencentdb",
  "memory-tencentdb-mcp"
]
env = { TDAI_GATEWAY_URL = "http://127.0.0.1:8420" }
env_vars = ["TDAI_GATEWAY_API_KEY", "TDAI_CODEX_SESSION_KEY"]
startup_timeout_sec = 20
tool_timeout_sec = 60
required = false
default_tools_approval_mode = "writes"
```

For a local checkout, replace `command` and `args` with:

```toml
command = "node"
args = ["/absolute/path/to/TencentDB-Agent-Memory/dist/memory-tencentdb-mcp.mjs"]
```

Restart the Codex client after editing configuration. Use `/mcp` in the TUI,
or the MCP servers settings page in the app/IDE, to confirm the server and its
five tools are connected.

## Tools

| Tool | Class | Purpose |
|---|---|---|
| `memory_recall` | read | Recall relevant memory before work |
| `memory_search` | read | Search structured L1 memory |
| `conversation_search` | read | Search raw L0 conversation evidence |
| `memory_capture` | write | Save a completed exchange |
| `memory_session_end` | write, idempotent | Flush one session |

The default session key is `codex:` plus the first 12 hexadecimal characters
of a SHA-256 digest of the working directory. The absolute path is not sent to
the Gateway. Set `TDAI_CODEX_SESSION_KEY` or pass `session_key` to a tool when
another grouping is required.

## Security and remote Gateways

- Loopback is the default and requires no explicit opt-in.
- Set `TDAI_GATEWAY_API_KEY` when the Gateway uses Bearer authentication.
- Non-loopback URLs are rejected unless `TDAI_GATEWAY_ALLOW_REMOTE=true`.
- Gateway URLs containing embedded usernames or passwords are always rejected.
- Keep `default_tools_approval_mode = "writes"` so recall/search stay
  frictionless while capture/flush retain the host's write approval boundary.

## Local verification

```bash
npm install
npm run build
curl http://127.0.0.1:8420/health
node dist/memory-tencentdb-mcp.mjs
```

The last command speaks MCP JSON-RPC on stdin/stdout. Normal diagnostics are
sent only to stderr.
