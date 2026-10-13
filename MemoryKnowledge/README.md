# MemoryKnowledge (Knowledge Service)

This directory contains the **Knowledge Service (KS)**: a user-side Wiki and Code-Graph engine within the monorepo.
The control plane is located in [`../MemoryPanel`](../MemoryPanel/).

Default port is **8421**, and the API prefix is **`/v3`**.
`API_PREFIX` accepts static slash-separated segments containing ASCII letters, digits,
underscores or hyphens (for example `/api/knowledge`). A leading slash is added and
trailing slashes are removed. Root, wildcard, query, fragment, encoded and dynamic
route prefixes are rejected before startup; use the same prefix in client URLs.

## Features

| Capability | Description |
| --- | --- |
| **Native OKF Wiki** | Import/Export standard Open Knowledge Format 0.2 bundles seamlessly without LLM rewrites. |
| **LLM-Wiki** | Upload/pull documents → LLM extracts structured pages → FTS5 full-text search + knowledge graph. |
| **Code-Graph** | `git clone` repositories → CodeGraph indexing (symbols, calls, file trees) → explorative queries. |
| **Auto-Sync** (Optional) | Periodically scans code-graphs. Uses a FIFO queue + worker pool to automatically pull Git updates and rebuild indexes. Disabled by default, see the Auto-Sync section below. |
| **Tools** | `POST /v3/tools/list` and `/v3/tools/call`, enabling agents/kernels to self-discover and invoke tools. |
| **Status Callbacks** | After ingestion/sync completion, sends callbacks to the Panel (`TMC_CALLBACK_URL`), which then writes to remote metadata / knowledge. |

You can start the service alone using `npm run dev`, but in a product workflow, a Panel must push `llm_binding`, receive callbacks, and update remote metadata.

## Directory Structure

```text
MemoryKnowledge/
├── src/
│   ├── server.ts           # Hono entry point: mounts routes, Swagger, starts listener
│   ├── module.ts           # Assembles store / wiki / code-graph / queues / recovery
│   ├── config.ts           # Environment variables
│   ├── callback.ts         # → Panel status-callbacks
│   ├── telemetry.ts        # Optional Langfuse tracing
│   ├── routes/             # API routes: wiki, code-graph, tools, llm-binding, health
│   ├── engines/
│   │   ├── wiki/           # OKF bundle transport, ingest-v2, FTS indexing, graph search
│   │   └── code/           # CodeGraph bridge
│   ├── store/              # SQLite (Drizzle) + build queue + llm_binding store
│   ├── source-fetcher/     # Git fetching module
│   ├── mcp/                # MCP stdio server (forwards to local HTTP APIs)
│   ├── db/                 # Database schemas and clients
│   └── middleware/         # Security and request parsing middlewares
├── docs/                   # Design, OKF specs, and API documentation
├── tests/                  # Vitest regression tests
├── package.json            # Node.js dependencies
└── tsconfig.json           # TypeScript configuration
```

## Running Locally

If you need a unified **Panel + KS image** for production/debugging, use [`agentmemory/memory-hub`](https://hub.docker.com/r/agentmemory/memory-hub) (see [`../deploy/panel-knowledge-combined/README.md`](../deploy/panel-knowledge-combined/README.md)).

To run this specific OKF patched service from source:

```bash
cd MemoryKnowledge
npm ci
cp .env.example .env
# Edit .env as shown below
npm run dev
```

Check health and API documentation:
```bash
curl -s http://127.0.0.1:8421/health
# Swagger UI available at: http://127.0.0.1:8421/docs
```

When integrating with the Panel (which defaults to port `8123`), the KS `.env` requires at least:

```dotenv
PORT=8421
API_PREFIX=/v3
KNOWLEDGE_DATA_DIR=./data
KNOWLEDGE_DB_PATH=./data/knowledge.db
KNOWLEDGE_PUBLIC_BASE_URL=http://127.0.0.1:8421/v3   # Accessible by Agent, must include /v3
TMC_CALLBACK_URL=http://127.0.0.1:8123               # Panel base URL, no callback path
LLM_MODE=proxy
LLM_MODEL=Memory-Model
```

On the Panel side (Panel's `.env`, not KS):

```dotenv
KNOWLEDGE_SERVICE_URL=http://127.0.0.1:8421
```

| Variable | Consumer | Includes `/v3`? |
| --- | --- | --- |
| `KNOWLEDGE_PUBLIC_BASE_URL` | KS → Writes resource `service_url` | Yes |
| Panel `KNOWLEDGE_SERVICE_URL` | Panel → Calls KS admin APIs | No |
| `TMC_CALLBACK_URL` | KS → Callbacks to Panel | No (Root URL only) |

`LLM_MODE=proxy` (default): Wiki uses the `llm_binding` pushed by the Panel via `x-tdai-service-id`.
`LLM_MODE=custom`: Set `LLM_API_KEY` / `LLM_BASE_URL` (and optionally `LLM_PROTOCOL=anthropic`) in `.env` directly.

## Common Commands

```bash
npm run dev          # Start HTTP API (with TSX hot-reloading)
npm run dev:mcp      # Start MCP stdio (requires HTTP server running)
npm run typecheck    # Validate TypeScript types
npm test             # Run Vitest test suite
npm run build        # Build using tsdown → dist/
npm run okf          # OKF CLI utility for validating/migrating bundles
```

## Security and Authentication Architecture

### 1. Service Authentication
When `KNOWLEDGE_SERVICE_KEY` is configured:
- **ALL service API endpoints (`/v3/*`) require `Authorization: Bearer <KNOWLEDGE_SERVICE_KEY>`.** This includes read queries (`wiki/page/read`, `wiki/raw/read`, `wiki/search`), write/ingest mutations, tool execution (`tools/list`, `tools/call`), internal configurations, auto-sync, and analytics.
- Missing or invalid tokens fail-closed immediately with HTTP 401 without reading or buffering request bodies or emitting telemetry.
- Public endpoints: `/health` (liveness check) and `/docs` / `/openapi.json` (OpenAPI specification) are hosted outside the API prefix and remain public.

### 2. Multi-Tenancy Boundary vs. Authentication
- The `x-tdai-service-id` and `team_id` headers passed in requests define logical multi-tenancy boundaries and resource scoping across SQLite stores and directory structures.
- **These headers are NOT caller authentication.** Supplying arbitrary tenant headers without a valid service key does not grant access.
- `KNOWLEDGE_SERVICE_KEY` is a trusted **service-to-service** credential (e.g. Panel ↔ Knowledge), **NOT end-user tenant authentication**. Production deployments require an operator-provided trusted gateway that authenticates end-user sessions and derives the tenant identity before proxying to Knowledge. (Note: The included MemoryProxy and MemoryCore do not currently supply an end-user gateway for Knowledge endpoints; a custom ingress proxy or sidecar is required for direct Agent access.)

### 3. Agent Migration for Direct Reads
- Previously unauthenticated agent reads must now access Knowledge through an authenticated operator-provided gateway/proxy, or carry the service token within trusted private environments.
- **CRITICAL:** Never embed the global `KNOWLEDGE_SERVICE_KEY` into LLM prompts or user-visible generated tool definitions.

### 4. Network Listener Posture
- The service defaults to binding explicitly to the loopback interface (`127.0.0.1`, configurable via `HOST` or `KNOWLEDGE_HOST`).
- Unauthenticated (no-key) mode is permitted **only** on loopback for local development.
- Binding to a non-loopback interface (such as `0.0.0.0` or external network interfaces) **strictly requires** `KNOWLEDGE_SERVICE_KEY`. Attempting to start without a service key on non-loopback will immediately throw a configuration error before initializing network or telemetry side effects, unless explicitly overridden with `KNOWLEDGE_ALLOW_INSECURE_NO_KEY_LISTEN=true` (strictly for trusted/isolated development networks).

## Telemetry (Optional)

### ClickHouse Tool Call Logging
Disabled by default. Set the following environment variables to write `POST /v3/tools/call` invocations into a `tool_call_logs` table compatible with Memory/Skill. Tables are idempotently created on startup. Logging failures do not block business requests.

```dotenv
KNOWLEDGE_CLICKHOUSE_ENABLED=true
KNOWLEDGE_CLICKHOUSE_URL=http://clickhouse.example.com:8123
KNOWLEDGE_CLICKHOUSE_DATABASE=default
KNOWLEDGE_CLICKHOUSE_TABLE=tool_call_logs
KNOWLEDGE_CLICKHOUSE_USER=knowledge_writer
KNOWLEDGE_CLICKHOUSE_PASSWORD=              # Injected via env, never committed
```

If the caller provides headers like `x-conversation-id`, `x-tdai-user-id`, `x-tdai-team-id`, `x-tdai-agent-id`, `x-tdai-agent-source`, `x-tdai-space-id`, or `x-tdai-turn-seq`, these dimensions are recorded. Request bodies are recursively masked and truncated to 512 bytes.

### Langfuse Tracing
Configure `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` (and optionally `LANGFUSE_BASE_URL`) to report Wiki LLM invocations. When unset, tracing is safely disabled.

### Auto-Sync

Disabled by default. Set `KNOWLEDGE_AUTO_SYNC_ENABLED=true` to enable scheduled updates. `KNOWLEDGE_AUTO_SYNC_SCAN_INTERVAL_MIN` defaults to 10 (range 1–60); `KNOWLEDGE_AUTO_SYNC_MAX_CONCURRENT` defaults to 3 (range 1–20). The first scan runs after 30 seconds. While disabled, `POST /v3/auto-sync/trigger` returns `triggered: false`.
