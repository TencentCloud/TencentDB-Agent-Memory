# Adapter SDK — Unified Cross-Platform Memory Client

> 中文版本见 [README_CN.md](./README_CN.md)。
> Architecture: [docs/adapters/ARCHITECTURE.md](../../docs/adapters/ARCHITECTURE.md) ·
> Onboarding: [docs/adapters/NEW-PLATFORM-GUIDE.md](../../docs/adapters/NEW-PLATFORM-GUIDE.md)

One interface for platforms to consume (`MemoryClient`), one interface for platforms to
implement (`PlatformAdapter` via `BasePlatformAdapter`), two interchangeable transports.
The Claude Code MCP adapter (`src/adapters/claude-code/`) and the Dify adapter
(`src/adapters/dify/`) are both built exclusively on this SDK.

## Quick start

```ts
import {
  createMemoryClient,
  BasePlatformAdapter,
  type MemoryClient,
} from "./index.js"; // src/adapter-sdk

// 1. Get a client — transport is configuration, not code.
const client: MemoryClient = createMemoryClient({
  transport: "http",                       // or "in-process"
  baseUrl: "http://127.0.0.1:8420",        // TdaiGateway
  apiKey: process.env.TDAI_GATEWAY_API_KEY,
});

// 2. Use the six capabilities.
const recall = await client.recall({ query: "user prefs?", sessionKey: "app:s1" });
await client.capture({ userContent: "hi", assistantContent: "hello!", sessionKey: "app:s1" });
const mem = await client.searchMemories({ query: "tea", limit: 5 });
const conv = await client.searchConversations({ query: "deploy", sessionKey: "app:s1" });
await client.endSession("app:s1");
await client.close();
```

## `MemoryClient` at a glance

| Method | Backing capability | Returns |
| --- | --- | --- |
| `recall(p)` | `TdaiCore.handleBeforeRecall` / `POST /recall` | `{ context, prependContext?, strategy?, memoryCount }` |
| `capture(p)` | `handleTurnCommitted` / `POST /capture` | `{ l0Recorded, schedulerNotified }` |
| `searchMemories(p)` | `searchMemories(Structured)` / `POST /search/memories` | `{ text, total, strategy, items[] }` |
| `searchConversations(p)` | `searchConversations(Structured)` / `POST /search/conversations` | `{ text, total, items[] }` |
| `endSession(key)` | `handleSessionEnd` / `POST /session/end` | `void` — flushes ONE session |
| `health()` | store accessors / `GET /health` | `{ status, vectorStore, embeddingService, version? }` |
| `close()` | lifecycle | destroys the core only if this client built it |

All params/results are camelCase; snake_case exists only inside the HTTP transport.
Every failure is a `MemoryClientError` with a stable `code`:
`"transport" | "auth" | "bad_request" | "unavailable"` (plus `httpStatus` when applicable).

## Transports

### `http` — `HttpMemoryClient`
Speaks the exact TdaiGateway REST dialect the Hermes Python client uses (same endpoints, same
snake_case bodies, Bearer only when the key is non-empty). Additionally sends
`include_items: true` on search routes to receive structured per-record `items`; gracefully
tolerates older gateways that ignore the flag (items default to `[]`). Options: `baseUrl`
(default `http://127.0.0.1:8420`), `apiKey`, `timeoutMs` (default 10 s), `fetchImpl` (test DI).

### `in-process` — `InProcessMemoryClient`
Wraps a `TdaiCore` in the same process. Two modes:

- **Injected core** — pass `core` (anything satisfying the structural `TdaiCoreLike` subset,
  including a test fake). The client never manages its lifecycle.
- **Owned core** — pass nothing; on first call the client builds a standalone core from the
  Gateway config machinery (`TDAI_DATA_DIR`, `TDAI_LLM_*`, `tdai-gateway.yaml`), with a
  promise-gated lazy init (concurrent first calls produce exactly one core). `close()` destroys it.

The method↔core mapping is byte-identical to what `src/gateway/server.ts` does, so the two
transports are semantically interchangeable — the e2e test
(`transports/http-gateway.e2e.test.ts`) proves wire compatibility against a real gateway.

## `BasePlatformAdapter`

```ts
class MyAdapter extends BasePlatformAdapter {
  readonly platformName = "my-platform";
  async start() { /* bind server / subscribe events */ }
  // stop() inherited: closes the client. Override + super.stop() to add teardown.
}
```

Provides `this.client`, `this.logger` (tagged console fallback), and the resilience helpers
`safeRecall` / `safeCapture` which log-and-degrade instead of throwing — encoding the project
rule that memory must never break the host conversation.

## Environment convention (`resolveClientOptionsFromEnv`)

| Variable | Meaning | Default |
| --- | --- | --- |
| `TDAI_ADAPTER_TRANSPORT` | `"http"` or `"in-process"` | `http` |
| `TDAI_GATEWAY_URL` | gateway base URL | `http://127.0.0.1:8420` |
| `TDAI_GATEWAY_API_KEY` | Bearer token (same var the gateway reads) | unset (no auth) |
| `TDAI_ADAPTER_TIMEOUT_MS` | HTTP timeout | `10000` |

## Testing your adapter

Inject a fake: either a fake `MemoryClient` (see
`src/adapter-sdk/base-platform-adapter.test.ts`) or a fake `TdaiCoreLike` into
`InProcessMemoryClient` (see `transports/in-process.test.ts`). No sqlite, no LLM, no network.

## Import hygiene

Import from `src/adapter-sdk/index.js` (or concrete files). Never import root `index.ts` or
`src/adapters/index.ts` from adapter code — they reference the optional `openclaw` peer
dependency, which is absent in gateway-only installs.
