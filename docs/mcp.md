# Run the memory-tencentdb MCP adapter

`src/adapters/mcp/` exposes the existing Gateway as a standard stdio MCP server. It does not create another memory core or store.

## Tools

| Tool | Gateway endpoint | Access |
|---|---|---|
| `tdai_memory_recall` | `POST /recall` | Read-only |
| `tdai_memory_capture` | `POST /capture` | Write |
| `tdai_session_end` | `POST /session/end` | Write |
| `tdai_memory_search` | `POST /search/memories` | Read-only |
| `tdai_conversation_search` | `POST /search/conversations` | Read-only |

The MCP adapter uses `TDAI_GATEWAY_URL`, `TDAI_GATEWAY_API_KEY`, and `TDAI_USER_ID`. Start it with:

```bash
node node_modules/tsx/dist/cli.mjs src/adapters/mcp/stdio.ts
```

An MCP client normally starts this process through its stdio server configuration. Do not run it in a terminal and type requests manually; stdin and stdout carry MCP JSON-RPC messages.

Platform adapters may reuse `createMemoryTools()` for deterministic lifecycle hooks. This keeps Gateway access in one adapter while avoiding a second generic SDK or base adapter.