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

The MCP adapter uses `TDAI_GATEWAY_URL` and `TDAI_GATEWAY_API_KEY` for the Gateway tools above.

## Wiki tools

The same server also exposes the Knowledge Service (team wikis). Wiki ids are always tool parameters; discover them with `tdai_wiki_list` first.

| Tool | Knowledge Service endpoint | Access |
|---|---|---|
| `tdai_wiki_list` | `POST /v3/wiki/list` | Read-only |
| `tdai_wiki_search` | `POST /v3/wiki/search` | Read-only |
| `tdai_wiki_pages` | `POST /v3/wiki/page/ls` | Read-only |
| `tdai_wiki_read` | `POST /v3/wiki/page/read` | Read-only, max 20 refs per call |
| `tdai_wiki_write` | `POST /v3/wiki/page/write` | Write, max 20 pages per call |

| Variable | Default | Purpose |
|---|---|---|
| `TDAI_KNOWLEDGE_URL` | `http://127.0.0.1:8424` | Knowledge Service base URL. |
| `TDAI_KNOWLEDGE_API_KEY` | falls back to `TDAI_GATEWAY_API_KEY` | Optional Bearer token for the Knowledge Service. |
| `TDAI_SERVICE_ID` | `default` | Sent as the `x-tdai-service-id` header. |
| `TDAI_TEAM_ID`, `TDAI_USER_ID`, `TDAI_AGENT_ID` | unset | Tenant identity sent in every request body; unset values are omitted. |
| `TDAI_KNOWLEDGE_TIMEOUT_MS` | `15000` | Per-request timeout. Writes and cold stores are slower than Gateway calls. |

Every Knowledge Service response is an envelope `{ code, message, data }`; the tools return `data` and turn a non-zero `code` into a tool error. Pass `knowledge: false` to `createMemoryMcpServer()` to register the Gateway tools only.

Start the server with:

```bash
node node_modules/tsx/dist/cli.mjs src/adapters/mcp/stdio.ts
```

An MCP client normally starts this process through its stdio server configuration. Do not run it in a terminal and type requests manually; stdin and stdout carry MCP JSON-RPC messages.

Platform adapters may reuse `createMemoryTools()` for deterministic lifecycle hooks, and `createKnowledgeTools()` for wiki access. This keeps Gateway and Knowledge Service access in one adapter while avoiding a second generic SDK or base adapter.