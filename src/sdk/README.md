# TDAI Unified Adapter SDK (`src/sdk`)

A platform-neutral toolkit for wiring the TDAI four-layer memory engine into any
agent host. It builds on the Gateway HTTP boundary that the OpenClaw and Hermes
integrations already established and distills the cross-platform surface into
three small layers.

```
buildMemoryTools(adapter) ──► MemoryTool[] ─────────────► your platform's tools
        ▲
   MemoryAdapter  ◄── GatewayMemoryAdapter ──► TdaiGatewayClient ──► TDAI Gateway
   (the one interface)     (HTTP transport)     (retries/auth/errors)
```

| Layer | Export | Responsibility |
| :---- | :----- | :------------- |
| Transport  | `TdaiGatewayClient` | Typed client for every Gateway endpoint — timeouts, bounded retries, Bearer auth, typed `TdaiGatewayError`. TS sibling of the Hermes Python client. |
| Capability | `MemoryAdapter` / `GatewayMemoryAdapter` | The single interface every transport implements and every platform consumes: `recall · searchMemories · searchConversations · capture · endSession · health`. |
| Tools      | `buildMemoryTools()` | Host-neutral tool descriptors (`name` + `description` + JSON Schema + non-throwing `invoke`). Maps 1:1 onto MCP, Dify, Vercel AI SDK, OpenAI functions, … |

## Quick start

```ts
import { GatewayMemoryAdapter, buildMemoryTools } from "./sdk/index.js";

const adapter = GatewayMemoryAdapter.fromEnv();      // TDAI_GATEWAY_URL / _API_KEY
const tools = buildMemoryTools(adapter);             // 4 canonical memory tools

const search = tools.find((t) => t.name === "tdai_memory_search")!;
const { text } = await search.invoke({ query: "what does the user like?" });
```

Or use the client directly:

```ts
import { TdaiGatewayClient } from "./sdk/index.js";

const client = new TdaiGatewayClient({ baseUrl: "http://127.0.0.1:8420" });
await client.capture({ userContent: "hi", assistantContent: "hello", sessionKey: "s1" });
const { context } = await client.recall("what's my name?", "s1");
```

## Design guarantees

- **`invoke` never throws.** Failures (Gateway down, bad args) return
  `{ isError: true, text }` so a host's tool loop degrades gracefully.
- **Argument coercion built in.** `limit` accepts `"10"`, `10.9`, etc. and is
  clamped to `[1, 20]` — LLMs ignore JSON Schema `type` hints.
- **Retries only where safe.** Network errors, timeouts, and 5xx retry with
  exponential backoff; 4xx surface immediately.
- **No runtime dependencies.** Uses the Node global `fetch` (injectable for
  tests); no HTTP library, no MCP framework.

## Consumers

- [`src/adapters/mcp`](../adapters/mcp/README.md) — MCP stdio server.
- [`src/adapters/dify`](../adapters/dify/README.md) — Dify OpenAPI tool.
- Your platform next — see [`docs/adapters/ADDING-A-PLATFORM.md`](../../docs/adapters/ADDING-A-PLATFORM.md).

Tests: `src/sdk/*.test.ts` (client wire-mapping/retries/errors; tool coercion &
routing). Run `npx vitest run src/sdk`.
