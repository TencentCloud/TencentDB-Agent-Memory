# TDAI Memory — Dify Adapter

Gives [Dify](https://dify.ai) agents and workflows long-term memory via the
TDAI four-layer engine. Unlike the MCP adapter, this integration is
**declarative**: Dify calls the TDAI Gateway's HTTP API directly, so the
"adapter" is just an OpenAPI schema plus this guide — no glue process to run.

```
┌─────────────┐   HTTP (OpenAPI custom tool)   ┌───────────┐
│  Dify app   │ ─────────────────────────────► │  TDAI     │
│ (agent /    │ ◄───────────────────────────── │  Gateway  │
│  workflow)  │   tdai_memory_search, …         │  + Core   │
└─────────────┘                                 └───────────┘
```

## Tools (from [`openapi.yaml`](./openapi.yaml))

| Operation (tool) | Method / path | Best used as |
| :--------------- | :------------ | :----------- |
| `tdai_memory_search`       | `POST /search/memories`      | Agent tool (LLM-called) |
| `tdai_conversation_search` | `POST /search/conversations` | Agent tool (LLM-called) |
| `tdai_recall`              | `POST /recall`               | Workflow node (prime the prompt) |
| `tdai_capture`             | `POST /capture`              | Workflow node (persist the turn) |
| `tdai_health`              | `GET /health`                | Diagnostics |

## Prerequisites

1. A running TDAI Gateway (see [`../mcp/README.md`](../mcp/README.md#prerequisites-a-running-gateway)).
2. **The Gateway must be reachable from your Dify instance:**
   - **Dify self-hosted** on the same host/LAN → use the Gateway's LAN address.
   - **Dify Cloud** → expose the Gateway over public HTTPS (reverse proxy or a
     tunnel like `cloudflared`/`ngrok`). Dify Cloud cannot reach `127.0.0.1`.
   - If you enable a public endpoint, set `TDAI_GATEWAY_API_KEY` on the Gateway
     and use Bearer auth in Dify (below) — do not expose an open Gateway.

## Import into Dify

1. In Dify, go to **Tools → Custom → Create Custom Tool**.
2. Set **Schema** by pasting the contents of [`openapi.yaml`](./openapi.yaml)
   (or a URL to it).
3. Edit the `servers[0].url` to the address your Dify instance can reach
   (e.g. `https://memory.example.com` or `http://192.168.1.20:8420`).
4. **Authorization:**
   - Open Gateway (default) → **None**.
   - Auth-enabled Gateway → **API Key**, auth type **Bearer**, header
     `Authorization`, value = your `TDAI_GATEWAY_API_KEY`.
5. Save. The five tools now appear under your custom tool.

## Wiring it up

### Agent app (LLM decides when to search)

Add **`tdai_memory_search`** and **`tdai_conversation_search`** to an Agent
app's tools. The model calls them on its own when it needs to recall something
about the user — both only require a `query`.

### Workflow (deterministic recall + capture)

`tdai_recall` and `tdai_capture` need a stable `session_key` so memory is scoped
per conversation. Dify exposes exactly that as `sys.conversation_id`:

```
[Start] → [Tool: tdai_recall]                     # session_key = {{#sys.conversation_id#}}
        → [LLM]  (inject recall "context" into the prompt)
        → [Tool: tdai_capture]                     # session_key = {{#sys.conversation_id#}}
        → [Answer]
```

- In the `tdai_recall` node, map `query` = the user input and
  `session_key` = `{{#sys.conversation_id#}}`. Feed its `context` output into
  the LLM node's prompt.
- In the `tdai_capture` node, map `user_content`, `assistant_content`, and the
  same `session_key`.

## Notes

- The Gateway returns pre-formatted text in `results` / `context`, so no
  response post-processing is needed — feed it straight to the model.
- This is the same Gateway the MCP and Hermes adapters use. One Gateway can
  back Dify, Claude Code, and Hermes at once, sharing a single memory store.

See [`docs/adapters/COMPARISON.md`](../../../docs/adapters/COMPARISON.md) for how
the declarative Dify approach compares to the code-based adapters.
