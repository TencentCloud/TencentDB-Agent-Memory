# TencentDB Agent Memory for Dify

This Dify tool plugin connects Dify workflows to TencentDB Agent Memory through
the local HTTP Gateway. It does not start the Gateway by itself.

The bundled Python `TdaiGatewayClient` is a Dify-runtime transport shim. It is
kept local to this plugin and is not intended as a new shared cross-platform
adapter SDK. Shared Gateway client structure should come from the Gateway Client Adapter Kit rather than this Dify plugin.

## Quickstart

For a runnable smoke test that starts the Gateway, starts a mock Dify server,
and invokes the real `tdai_capture`, `tdai_conversation_search`, and
`tdai_recall` tool classes:

```bash
npm install
bash dify-plugin-tdai-memory/scripts/quickstart-gateway-mock-e2e.sh
```

The quickstart is intentionally scoped as a Dify adapter smoke test. It proves:

- the plugin can call the Gateway end to end,
- `tdai_capture` writes a turn,
- `tdai_conversation_search` provides immediate `L0 read path` validation, and
- `tdai_recall` is reachable through the Dify tool surface.

Manual setup:

1. Start the Gateway from the repository root:

   ```bash
   npx tsx src/gateway/server.ts
   ```

2. In Dify, install this plugin directory and configure provider credentials:

   - `gateway_url`: `http://127.0.0.1:8420`
   - `gateway_api_key`: optional; must match `TDAI_GATEWAY_API_KEY` if Gateway auth is enabled
   - `gateway_timeout_seconds`: optional, default `10`

3. Recommended workflow wiring:

   - Before the LLM node: call `tdai_recall` with the current user message and Dify `conversation_id`.
   - Inject the returned `context` into the system prompt or context field.
   - After the assistant response: call `tdai_capture` with user/assistant content and the same `conversation_id`.
   - At workflow `End`: call `tdai_session_end` to flush the current session buffer.

## Tools

| Tool | Gateway endpoint | Purpose |
| --- | --- | --- |
| `tdai_health` | `GET /health` | Check Gateway availability |
| `tdai_recall` | `POST /recall` | Recall memory context before generation |
| `tdai_capture` | `POST /capture` | Store a completed conversation turn |
| `tdai_memory_search` | `POST /search/memories` | Search structured L1 memories |
| `tdai_conversation_search` | `POST /search/conversations` | Search raw L0 conversations |
| `tdai_session_end` | `POST /session/end` | Flush the current session buffer |

## Notes

- Use Dify `conversation_id` as `session_key`; do not use transient run IDs.
- Use `tdai_conversation_search` as the immediate `L0 read path` for read-after-write verification.
- Treat `tdai_recall` as the structured recall path. Whether it returns non-empty context depends on the deployed Gateway build plus the existing memory consolidation pipeline, so the quickstart only asserts that the recall path is callable.
- Tool calls return `{ "ok": false, "error": "..." }` on Gateway/network failure so workflows can continue without memory.
- Search outputs are truncated by default to 2000 characters to avoid oversized prompt injection. Set `max_chars` to `0` for unlimited output.
- The current Gateway accepts `user_id` in recall/capture request bodies, but core identity handling still uses the existing Gateway behavior. Treat `session_key` as the primary isolation key until Gateway/Core user scoping is extended.
- Provider credential validation sends a read-only `POST /search/memories` probe because `GET /health` is intentionally unauthenticated. The probe does not write memory, but it can appear in Gateway logs or metrics.

## Architecture Docs

- [Dify adapter architecture](ARCHITECTURE.md)
- Repository guide: `docs/dify-plugin-installation-guide.md`
- [Dify workflow diagram](../docs/dify-workflow-diagram.md)
