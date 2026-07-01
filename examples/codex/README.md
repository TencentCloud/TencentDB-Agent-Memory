# Codex Adapter Example

This example connects Codex to TencentDB Agent Memory through the shared Adapter
SDK.

Codex has two documented extension points that map to memory features:

- MCP servers expose model-callable tools.
- Hooks run at lifecycle points such as `UserPromptSubmit` and `Stop`.

This example uses both:

| Codex surface | Entry | Memory capability |
| --- | --- | --- |
| MCP stdio server | `memory-tencentdb-mcp` | health, recall, capture, L1 memory search, L0 conversation search, session flush |
| Codex hooks | `node /absolute/path/to/examples/codex/hooks-adapter/memory-tencentdb-codex-hook.mjs` | automatic recall before a prompt and automatic capture after a completed turn |

The MCP server is the package-provided integration surface. The hook adapter is
an optional reference implementation that lives entirely under this example. It
uses the shared Adapter SDK and the Gateway HTTP boundary to demonstrate
automatic recall/capture for Codex lifecycle events.

## Prerequisites

Build and start the Gateway first:

```bash
npm run build
TDAI_GATEWAY_PORT=8420 npx tsx src/gateway/server.ts
```

The Gateway needs its normal LLM configuration, for example `TDAI_LLM_BASE_URL`,
`TDAI_LLM_API_KEY`, and `TDAI_LLM_MODEL`, or an equivalent
`tdai-gateway.yaml` / `tdai-gateway.json`.

Build the optional Codex hook reference adapter if you want automatic
recall/capture in addition to MCP tools:

```bash
npx tsc -p examples/codex/hooks-adapter/tsconfig.json
```

## Configure Codex

Copy the relevant sections from [`config.toml`](./config.toml) into
`~/.codex/config.toml`, or into a trusted project-scoped `.codex/config.toml`.

The MCP section registers the full memory tool surface:

```toml
[mcp_servers.memory-tencentdb]
command = "memory-tencentdb-mcp"
startup_timeout_sec = 10
tool_timeout_sec = 60
default_tools_approval_mode = "auto"

[mcp_servers.memory-tencentdb.env]
MEMORY_TENCENTDB_GATEWAY_URL = "http://127.0.0.1:8420"
MEMORY_TENCENTDB_MCP_SESSION_KEY = "codex-main"
```

The hook section adds automatic lifecycle mapping:

```toml
[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "node /absolute/path/to/TencentDB-Agent-Memory/examples/codex/hooks-adapter/memory-tencentdb-codex-hook.mjs"
timeout = 15
statusMessage = "Recalling TencentDB Agent Memory"

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "node /absolute/path/to/TencentDB-Agent-Memory/examples/codex/hooks-adapter/memory-tencentdb-codex-hook.mjs"
timeout = 15
statusMessage = "Capturing TencentDB Agent Memory"
```

After changing Codex configuration, start a new Codex thread or restart the
client. In the Codex CLI, `/mcp` shows whether the MCP server is connected, and
`/hooks` lets you review and trust hook commands.

If the hook section is enabled, completed turns are captured automatically at
`Stop`. Keep `memory_tencentdb_capture` behind approval unless you intentionally
want Codex to perform an additional manual capture during the same turn.

## Configuration

| Environment variable | Default | Used by | Description |
| --- | --- | --- | --- |
| `MEMORY_TENCENTDB_GATEWAY_URL` | `http://127.0.0.1:8420` | MCP, hooks | Full Gateway URL |
| `MEMORY_TENCENTDB_GATEWAY_HOST` | `127.0.0.1` | MCP, hooks | Gateway host when URL is unset |
| `MEMORY_TENCENTDB_GATEWAY_PORT` | `8420` | MCP, hooks | Gateway port when URL is unset |
| `MEMORY_TENCENTDB_GATEWAY_API_KEY` | unset | MCP, hooks | Bearer token sent to the Gateway |
| `TDAI_GATEWAY_API_KEY` | unset | MCP, hooks | Fallback Bearer token name |
| `MEMORY_TENCENTDB_MCP_SESSION_KEY` | `mcp-default` | MCP | Default MCP session key |
| `MEMORY_TENCENTDB_MCP_TIMEOUT_MS` | `10000` | MCP | MCP Gateway request timeout |
| `MEMORY_TENCENTDB_CODEX_SESSION_PREFIX` | `codex` | hooks | Prefix for session keys derived from Codex `session_id` |
| `MEMORY_TENCENTDB_CODEX_SESSION_KEY` | unset | hooks | Fixed session key override |
| `MEMORY_TENCENTDB_CODEX_USER_ID` | unset | hooks | Optional user id forwarded to Gateway |
| `MEMORY_TENCENTDB_CODEX_STATE_DIR` | `~/.memory-tencentdb/codex-hooks` | hooks | Temporary turn state for matching prompt and stop events |
| `MEMORY_TENCENTDB_CODEX_TIMEOUT_MS` | `10000` | hooks | Hook Gateway request timeout |

## Supported Flow

1. `UserPromptSubmit` receives Codex's current prompt.
2. The hook example maps Codex `session_id` to a stable memory
   `session_key`, calls Gateway `/recall` through the Adapter SDK, and returns
   recalled memory as Codex `additionalContext`.
3. Codex can call MCP tools during the turn for explicit search, capture,
   health, or session flush.
4. `Stop` receives Codex's `last_assistant_message`.
5. The hook example combines the stored user prompt with the final
   assistant message and calls Gateway `/capture` through the Adapter SDK.

The hook adapter does not parse Codex transcript files; Codex documents
`transcript_path` as a convenience field but not a stable hook interface.
