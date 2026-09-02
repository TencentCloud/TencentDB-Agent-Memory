# Dify Adapter

Connects Dify (and any other HTTP-driven workflow platform) to
TencentDB-Agent-Memory over HTTP.

```
┌──────────────────────────────────────────┐
│            DifyHttpServer                │
│  ┌────────────────────────────────────┐  │
│  │  HTTP endpoints:                   │  │
│  │  GET  /health                      │  │
│  │  POST /recall                      │  │
│  │  POST /capture                     │  │
│  │  POST /search/memories             │  │
│  │  POST /search/conversations        │  │
│  │  POST /session/end                 │  │
│  └────────────────────────────────────┘  │
│             │                            │
│  ┌──────────▼───────────────────────┐   │
│  │  DifyHostAdapter                 │   │
│  │  (per-request RuntimeContext)    │   │
│  └──────────┬───────────────────────┘   │
└─────────────┼────────────────────────────┘
              ▼
        ┌───────────┐
        │ TdaiCore  │
        └───────────┘
```

The entire adapter is under 30 lines across four files — everything else comes
from `HttpServerBase` and `HostAdapterBase`. It is the reference example
for [Path B](new-platform-guide.md#path-b--http-platform-30-lines-total).

## Run the server

```bash
npm install -g @tencentdb-agent-memory/memory-tencentdb
```

```bash
TDAI_LLM_BASE_URL=https://api.deepseek.com/v1 \
TDAI_LLM_API_KEY=sk-... \
TDAI_LLM_MODEL=deepseek-chat \
TDAI_GATEWAY_API_KEY=choose-a-strong-token \
tdai-dify-http
```

Defaults to `127.0.0.1:8420`. Configuration variables:

| Variable | Default | Purpose |
|---|---|---|
| `TDAI_PORT` | `8420` | Listen port |
| `TDAI_HOST` | `127.0.0.1` | Bind address |
| `TDAI_GATEWAY_API_KEY` | unset | Bearer token; **unset means no auth** |
| `TDAI_CORS_ORIGINS` | unset | Comma-separated allow-list |
| `TDAI_DATA_DIR` | `~/.tdai/dify` | Storage root |

Shared LLM and memory variables are documented in
[`bin/env-common.ts`](../bin/env-common.ts).

### Security

With `TDAI_GATEWAY_API_KEY` unset, every endpoint except `GET /health` is open
to anyone who can reach the port. Set a token before binding to anything other
than loopback, and prefer a concrete CORS allow-list over `*`.

### No per-user isolation

One server instance keeps **one** memory store shared by every caller. There is
no `user_id` on any endpoint, because `TdaiCore` does not scope storage by user
and accepting the field would imply an isolation guarantee that does not exist.

`session_key` separates conversations, not tenants: a search can surface
memories captured under a different session. If you need real separation
between end users today, run one server per tenant with its own `TDAI_DATA_DIR`
and port.

## Wire it into a Dify workflow

Use an **HTTP Request** node. Recall before the LLM node:

```
POST http://127.0.0.1:8420/recall
Authorization: Bearer {{ env.TDAI_GATEWAY_API_KEY }}
Content-Type: application/json

{
  "query": "{{ sys.query }}",
  "session_key": "{{ sys.conversation_id }}"
}
```

Response:

```json
{
  "context": "…memories to inject…",
  "strategy": "hybrid",
  "memory_count": 4
}
```

Feed `context` into the LLM node's system prompt. Then capture after it:

```
POST http://127.0.0.1:8420/capture
Authorization: Bearer {{ env.TDAI_GATEWAY_API_KEY }}
Content-Type: application/json

{
  "user_content": "{{ sys.query }}",
  "assistant_content": "{{ llm.text }}",
  "session_key": "{{ sys.conversation_id }}"
}
```

Using `sys.conversation_id` as the session key is what keeps memories grouped
per Dify conversation.

## Endpoints

All request and response bodies use `snake_case`.

| Endpoint | Required fields | Returns |
|---|---|---|
| `POST /recall` | `query`, `session_key` | `context`, `strategy`, `memory_count` |
| `POST /capture` | `user_content`, `assistant_content`, `session_key` | `l0_recorded`, `scheduler_notified` |
| `POST /search/memories` | `query` | `results`, `total`, `strategy` |
| `POST /search/conversations` | `query` | `results`, `total` |
| `POST /session/end` | `session_key` | `flushed` |
| `GET /health` | — | `status`, `version`, `uptime`, `stores` |

`POST /capture` also accepts `session_id` and a full `messages` array.
`POST /search/*` accept `limit`; `/search/memories` also accepts `type` and
`scene`.

A missing required field returns `400`; a bad or absent bearer token returns
`401`.

## Verify

```bash
curl -s http://127.0.0.1:8420/health
```

```bash
curl -s -X POST http://127.0.0.1:8420/recall \
  -H "Authorization: Bearer $TDAI_GATEWAY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"query":"what did we decide","session_key":"test-1"}'
```

## Relationship to the Gateway

`DifyHttpServer` and `TdaiGateway` are siblings — both extend `HttpServerBase`
and serve the same six endpoints. They differ only in configuration and extras:

| | `DifyHttpServer` | `TdaiGateway` |
|---|---|---|
| Config source | `TDAI_*` env vars | `tdai-gateway.yaml` + env |
| Extra endpoints | none | `POST /seed` |
| Startup warnings | none | Security posture logging |
| Intended caller | Dify, n8n, any HTTP client | Hermes Python provider |

Any HTTP platform can use `tdai-dify-http` as-is; the name reflects its first
consumer, not a Dify-specific protocol.

See [architecture.md](architecture.md) for the full cross-platform picture.
