# How to Integrate a New Platform (如何接入新平台)

> 中文版本见 [NEW-PLATFORM-GUIDE_CN.md](./NEW-PLATFORM-GUIDE_CN.md)。
> Background: [ARCHITECTURE.md](./ARCHITECTURE.md) · [PLATFORM-COMPARISON.md](./PLATFORM-COMPARISON.md) · [SDK reference](../../src/adapter-sdk/README.md)

With the Adapter SDK (`src/adapter-sdk/`), integrating a new agent platform means implementing
**one interface** (`PlatformAdapter`, via `BasePlatformAdapter`) against **one client**
(`MemoryClient`). This guide is the step-by-step recipe, ending with a complete worked example
and a test skeleton.

## Step 1 — Pick a transport

| Question | Yes → | No → |
| --- | --- | --- |
| Does your adapter run in the same Node process that should own the memory engine's lifecycle? | `in-process` | `http` |
| Do multiple consumers (or non-Node processes) need to share one memory store? | `http` (one Gateway, many clients) | either |
| Do you want zero extra processes during local development? | `in-process` | `http` |

Rule of thumb: **`http` is the default** (matches Hermes, Claude Code, Dify deployments; the
Gateway owns the store). Choose `in-process` only when your adapter process should *be* the
memory engine.

The transport is invisible to your adapter code — both implement `MemoryClient` with identical
semantics (verified by mirrored unit tests in `src/adapter-sdk/transports/*.test.ts`).

## Step 2 — Create the client

```ts
import { createMemoryClient, resolveClientOptionsFromEnv } from "../../adapter-sdk/index.js";

// Option A: explicit
const client = createMemoryClient({
  transport: "http",
  baseUrl: "http://127.0.0.1:8420",
  apiKey: process.env.TDAI_GATEWAY_API_KEY,
});

// Option B: standard env convention (TDAI_ADAPTER_TRANSPORT, TDAI_GATEWAY_URL,
// TDAI_GATEWAY_API_KEY, TDAI_ADAPTER_TIMEOUT_MS) — what the shipped CLIs use.
const client2 = createMemoryClient(resolveClientOptionsFromEnv(logger));
```

## Step 3 — Subclass `BasePlatformAdapter`

Implement exactly three members: `platformName`, `start()`, `stop()` (the base `stop()` already
closes the client — call `super.stop()` after your own teardown).

## Step 4 — Map your platform's lifecycle onto the client

The cheat-sheet — find your platform's event in column 1, call column 2:

| Platform event (typical names) | MemoryClient call | Notes |
| --- | --- | --- |
| "before prompt build" / "pre-turn" / "prefetch" | `safeRecall({query, sessionKey})` | Inject `prependContext` near the user message, `context` into the system prompt. Use `safeRecall` — a memory outage must not break the turn. |
| "turn finished" / "agent end" / "message committed" | `safeCapture({userContent, assistantContent, sessionKey})` | Fire-and-forget is fine; pass `messages` only if you have the full turn including tool calls. |
| model-invoked "search memory" tool | `searchMemories({query, limit, type?, scene?})` | Return `.text` to the model; `.items` if your platform wants per-record scores. Clamp `limit` to 1..20. |
| model-invoked "search history" tool | `searchConversations({query, limit, sessionKey?})` | `sessionKey` here is a *filter*, not a scope — leave it unset to search across sessions. |
| "conversation closed" / "session end" | `endSession(sessionKey)` | Flushes ONE session's pipeline buffers. Never call this as a global shutdown. |
| liveness probe | `health()` | Also useful at startup to fail fast with a clear log. |
| process shutdown | `stop()` → `client.close()` | `close()` destroys the core only when the in-process client built it. |

## Step 5 — Choose a session-key strategy

The `sessionKey` groups L0 records and scopes pipeline state. Precedents:

- OpenClaw: the host's stable conversation key.
- Claude Code adapter: `TDAI_SESSION_KEY` env, defaulting to `claude-code:<cwd basename>`
  (one memory thread per project directory).
- Dify adapter: `session_key` field per request, defaulting to `dify:default`; flows thread a
  conversation variable through for per-user memory.

Guidelines: prefix with the platform name (`myplatform:...`), keep it stable across reconnects
of the same logical conversation, and let callers override it per-request when your platform is
multi-tenant.

## Step 6 — Worked example (~40 lines, compiles against the SDK)

A minimal adapter for a hypothetical webhook-driven platform:

```ts
import {
  BasePlatformAdapter,
  createMemoryClient,
  resolveClientOptionsFromEnv,
  type MemoryClient,
} from "../../adapter-sdk/index.js";

interface TurnEvent {
  userText: string;
  assistantText: string;
  conversationId: string;
}

export class MyPlatformAdapter extends BasePlatformAdapter {
  readonly platformName = "my-platform";

  constructor(client: MemoryClient) {
    super({ client });
  }

  async start(): Promise<void> {
    const health = await this.client.health();
    this.logger.info(`memory backend: ${health.status}`);
    // ... subscribe to your platform's events here ...
  }

  /** Call before each LLM turn — returns context to inject, never throws. */
  async beforeTurn(query: string, conversationId: string): Promise<string> {
    const recall = await this.safeRecall({
      query,
      sessionKey: `my-platform:${conversationId}`,
    });
    return [recall.prependContext, recall.context].filter(Boolean).join("\n\n");
  }

  /** Call after each completed turn — fire and forget. */
  async afterTurn(event: TurnEvent): Promise<void> {
    await this.safeCapture({
      userContent: event.userText,
      assistantContent: event.assistantText,
      sessionKey: `my-platform:${event.conversationId}`,
    });
  }
}

// Wiring:
const adapter = new MyPlatformAdapter(createMemoryClient(resolveClientOptionsFromEnv()));
await adapter.start();
```

## Step 7 — Test it (offline, no core, no gateway)

Copy the fake-client pattern used by every shipped adapter test
(`src/adapters/claude-code/mcp-server.test.ts`, `src/adapters/dify/server.test.ts`):

```ts
import { describe, expect, it, vi } from "vitest";
import type { MemoryClient } from "../../adapter-sdk/index.js";

function createFakeClient(overrides: Partial<MemoryClient> = {}): MemoryClient {
  return {
    recall: vi.fn(async () => ({ context: "ctx", memoryCount: 1 })),
    capture: vi.fn(async () => ({ l0Recorded: 2, schedulerNotified: true })),
    searchMemories: vi.fn(async () => ({ text: "", total: 0, strategy: "none", items: [] })),
    searchConversations: vi.fn(async () => ({ text: "", total: 0, items: [] })),
    endSession: vi.fn(async () => {}),
    health: vi.fn(async () => ({ status: "ok" as const, vectorStore: true, embeddingService: true })),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("MyPlatformAdapter", () => {
  it("injects recalled context before a turn", async () => {
    const client = createFakeClient();
    const adapter = new MyPlatformAdapter(client);
    const context = await adapter.beforeTurn("what do I like", "c1");
    expect(client.recall).toHaveBeenCalledWith({
      query: "what do I like",
      sessionKey: "my-platform:c1",
    });
    expect(context).toContain("ctx");
  });

  it("survives a memory outage (safeRecall degrades)", async () => {
    const client = createFakeClient({
      recall: vi.fn(async () => { throw new Error("down"); }),
    });
    const adapter = new MyPlatformAdapter(client);
    await expect(adapter.beforeTurn("q", "c1")).resolves.toBe("");
  });
});
```

Conventions checklist before you ship:

- [ ] Adapter lives in `src/adapters/<platform>/` with `index.ts` barrel + `main.ts` CLI entry
      (`isMain` pattern like `src/gateway/server.ts`), runnable via `node --import tsx`.
- [ ] Only imports from `src/adapter-sdk/` and `src/core/types.js` — never from root `index.ts`
      or `src/adapters/index.ts` (they pull the optional `openclaw` peer dependency).
- [ ] Env vars named `TDAI_<PLATFORM>_*`; transport via the shared `TDAI_ADAPTER_*` convention.
- [ ] Tests use a fake `MemoryClient`; servers bind port `0` and close in `afterEach`.
- [ ] Bilingual `README.md` + `README_CN.md` in the adapter directory.
- [ ] Add an npm script `"adapter:<platform>"` in `package.json`.
