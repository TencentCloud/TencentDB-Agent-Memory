# Dify Adapter

This directory documents a full Dify integration for `memory-tencentdb` through
the existing Gateway HTTP API.

## Capabilities

- Custom Tool schema in `openapi.json` for Gateway recall, capture, search, and
  session flush endpoints.
- HTTP Request workflow skeleton in `workflow-http-request.json` for automatic
  pre-prompt recall and post-answer capture.
- MCP stdio registration example in `mcp-server.json` for exposing memory search
  tools to Dify agents that support command-based MCP tools.

## Gateway Mapping

| Dify concept | Gateway field |
| --- | --- |
| `sys.query` | `query` / `user_content` |
| LLM answer text | `assistant_content` |
| `conversation_id` | `session_key`, `session_id` |
| `user` | `user_id` |

## Setup

1. Start the Gateway.

```bash
pnpm exec tsx src/gateway/server.ts
```

2. Import `openapi.json` as a Dify Custom Tool. Point the server URL at the
   Gateway address, usually `http://127.0.0.1:8420`.
3. Add the HTTP Request workflow skeleton when automatic recall/capture is
   needed. Keep the LLM prompt input wired to `pre_recall.memory_context` plus
   the original user query.
4. Configure `MEMORY_TENCENTDB_GATEWAY_API_KEY` when the Gateway is protected.
5. Use `mcp-server.json` when the Dify deployment supports command-based MCP
   tools. The MCP bridge calls the same Gateway search endpoints and does not
   require a `/mcp` route on the Gateway itself.

## Notes

Dify workflows differ by deployment version and app type. Treat
`workflow-http-request.json` as the field-level contract: the important part is
that recall runs before the LLM step and capture runs after the final answer is
available.
