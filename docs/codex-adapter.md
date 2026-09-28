# Codex MCP Adapter

The Codex adapter runs TencentDB Agent Memory as a local
[Model Context Protocol (MCP)](https://learn.chatgpt.com/docs/extend/mcp) stdio server. Codex starts the
process, discovers its tools, and can read or write the same `TdaiCore` memory layers used by OpenClaw
and Hermes. No HTTP Gateway is required for this in-process path.

## Capabilities

| MCP tool | Layer | Side effect | Purpose |
| :--- | :--- | :--- | :--- |
| `memory_recall` | L1/L2/L3 | Read-only | Build relevant task context from dynamic memories, scenes, and persona |
| `memory_search` | L1 | Read-only | Search extracted structured memories |
| `conversation_search` | L0 | Read-only | Search captured raw exchanges, including data not yet extracted to L1 |
| `memory_capture` | L0 → pipeline | Durable write | Store one completed user/assistant exchange and notify the L1→L3 pipeline |
| `memory_session_end` | Pipeline | State change | Flush pending L1 work for one session |

The MCP server advertises matching tool annotations. With Codex
`default_tools_approval_mode = "writes"`, read tools can run normally while durable writes request
approval.

## Build and connect

Node.js `>=22.16.0` is required by this project.

```bash
npm install
npm run build
```

Add the built stdio server to Codex. Use absolute paths for both the repository and memory directory:

```bash
codex mcp add tencentdb-memory \
  --env TDAI_DATA_DIR=/absolute/path/to/memory-tdai \
  --env TDAI_CODEX_WORKSPACE=/absolute/path/to/your/project \
  -- node /absolute/path/to/TencentDB-Agent-Memory/dist/codex-mcp.mjs
```

Alternatively, add it to `~/.codex/config.toml` or a trusted project's `.codex/config.toml`:

```toml
[mcp_servers.tencentdb_memory]
command = "node"
args = ["/absolute/path/to/TencentDB-Agent-Memory/dist/codex-mcp.mjs"]
cwd = "/absolute/path/to/your/project"
default_tools_approval_mode = "writes"
startup_timeout_sec = 20
tool_timeout_sec = 120

[mcp_servers.tencentdb_memory.env]
TDAI_DATA_DIR = "/absolute/path/to/memory-tdai"
TDAI_CODEX_WORKSPACE = "/absolute/path/to/your/project"
```

Restart Codex after changing MCP configuration. Run `codex mcp list` in the CLI or `/mcp` in an
interactive session to verify that `tencentdb-memory` is connected.

## Verify basic read/write

No LLM API key is required for the basic L0 path:

1. Ask Codex to call `memory_capture` with a short test exchange.
2. Ask it to call `conversation_search` using a distinctive phrase from that exchange.
3. The search result should include the captured content.

For L1 extraction, L2 scenes, L3 persona, and semantic recall, configure an OpenAI-compatible model:

```toml
[mcp_servers.tencentdb_memory]
env_vars = ["TDAI_LLM_API_KEY"]

[mcp_servers.tencentdb_memory.env]
TDAI_LLM_BASE_URL = "https://api.openai.com/v1"
TDAI_LLM_MODEL = "gpt-4o"
```

Do not commit API keys into project-scoped configuration. Prefer `env_vars` or a user-only
configuration file when the value already exists in the environment.

## Configuration

The adapter reuses `tdai-gateway.yaml` / `tdai-gateway.json` and all existing `TDAI_LLM_*`, memory,
embedding, and Store settings from the standalone Gateway. These variables are specific to Codex:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `TDAI_CODEX_WORKSPACE` | MCP process working directory | Workspace exposed to the standalone LLM runner's sandboxed file tools |
| `TDAI_CODEX_SESSION_KEY` | `codex:<12-char workspace hash>` | Stable default session key when a tool call omits `session_key` |
| `TDAI_CODEX_USER_ID` | `codex_user` | User identity recorded in the host runtime context |
| `TDAI_DATA_DIR` | `~/.memory-tencentdb/memory-tdai` | Shared L0→L3 data directory |

The workspace-derived session key stores only a SHA-256 prefix, not the absolute workspace path.
Callers may pass `session_key` explicitly to isolate individual Codex conversations.

## Lifecycle and safety

Codex currently reaches this integration through MCP tool calls rather than OpenClaw-style
`before_prompt_build` / `agent_end` hooks. The server's MCP instructions tell Codex when recall and
capture are appropriate, but the model still decides whether to invoke them. Workflows that require a
guaranteed write should explicitly request `memory_capture`.

`memory_capture` must not be used for secrets, credentials, authentication tokens, or raw untrusted
tool output. Operational logs are written only to stderr because stdout is reserved for MCP JSON-RPC.
