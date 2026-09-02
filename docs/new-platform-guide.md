# New Platform Adapter Guide

This guide explains how to add TencentDB-Agent-Memory support to a new agent platform. Read [architecture.md](./architecture.md) first to understand the overall design.

There are two integration paths depending on how the platform communicates with tools:

| Path | Use when | Reference implementation |
|---|---|---|
| **MCP (stdio)** | Platform supports MCP servers (JSON-RPC over stdin/stdout) | Claude Code, Cursor, Codex |
| **HTTP / in-process** | Platform uses its own plugin SDK or HTTP calls | OpenClaw (in-process), Hermes (HTTP) |

---

## Path A — MCP Platform (recommended, ~25 lines total)

Platforms that support the Model Context Protocol only need to implement two small classes. All MCP JSON-RPC machinery, tool dispatch, session management, and lifecycle handling live in the shared base classes.

### What you need to implement

**`McpHostAdapterBase` — 3 abstract members:**

| Member | Type | Purpose |
|---|---|---|
| `hostType` | `string` constant | Identifies the platform in TdaiCore internals |
| `platformId` | `string` constant | Written into `RuntimeContext.platform` |
| `resolveSessionKey(explicit)` | method | Derives the default session key (env var strategy) |

**`McpServerBase` — 1 abstract method:**

| Method | Purpose |
|---|---|
| `createAdapter()` | Instantiates the platform's `McpHostAdapterBase` subclass |

Everything else — JSON-RPC framing, tool schemas, `handleBeforeRecall` / `handleTurnCommitted` calls, stdin/stdout lifecycle, SIGTERM handling — is inherited.

---

### Step-by-step

#### 1 · Host adapter (`src/adapters/{platform}/host-adapter.ts`)

```typescript
import { McpHostAdapterBase, sessionKeyFromEnv } from "../mcp-host-adapter-base.js";

export class WindsurfHostAdapter extends McpHostAdapterBase {
  readonly hostType = "windsurf" as const;   // unique per platform
  protected readonly platformId = "windsurf"; // written into RuntimeContext

  protected resolveSessionKey(explicit: string | undefined): string {
    // Priority: explicit arg → platform env var → process-stable UUID
    return sessionKeyFromEnv(explicit, "WINDSURF_SESSION_ID");
  }
}
```

`sessionKeyFromEnv(explicit, envVar)` implements the standard fallback chain:
`explicit ?? process.env[envVar] ?? randomUUID()`. Use it for every MCP platform.
If the platform doesn't set a session env var, just omit the `envVar` argument —
the UUID fallback keeps things working.

#### 2 · MCP server (`src/adapters/{platform}/mcp-server.ts`)

```typescript
import { McpServerBase } from "../mcp-server-base.js";
import { WindsurfHostAdapter } from "./host-adapter.js";
import type { McpHostAdapter } from "../mcp-server-base.js";

export class WindsurfMcpServer extends McpServerBase {
  protected createAdapter(): McpHostAdapter {
    // { ...this.opts, logger: this.logger } passes all options and ensures
    // the server and adapter share the same logger instance.
    return new WindsurfHostAdapter({ ...this.opts, logger: this.logger });
  }
}
```

If the platform has an automatic capture mechanism (like Claude Code's Stop hook),
override `onBeforeRecall()`, `onAfterInit()`, and `onBeforeShutdown()` in this class.
See `ClaudeCodeMcpServer` as the reference for hook queue draining.

#### 3 · Types (`src/adapters/{platform}/types.ts`, 2 lines)

```typescript
export type { McpHostAdapterOptions as WindsurfHostAdapterOptions } from "../mcp-host-adapter-base.js";
export type { McpServerBaseOptions as WindsurfMcpServerOptions } from "../mcp-server-base.js";
```

These are type aliases — they don't duplicate any field definitions. If `McpServerBaseOptions`
gains a new field, `WindsurfMcpServerOptions` picks it up automatically.

#### 4 · Barrel (`src/adapters/{platform}/index.ts`, 3 lines)

```typescript
export { WindsurfHostAdapter } from "./host-adapter.js";
export { WindsurfMcpServer } from "./mcp-server.js";
export type { WindsurfHostAdapterOptions, WindsurfMcpServerOptions } from "./types.js";
```

#### 5 · Wire into the adapters barrel (`src/adapters/index.ts`)

```typescript
export { WindsurfHostAdapter, WindsurfMcpServer } from "./windsurf/index.js";
export type { WindsurfHostAdapterOptions, WindsurfMcpServerOptions } from "./windsurf/index.js";
```

#### 6 · Extend core type unions (`src/core/types.ts`)

```typescript
// Add to HostAdapter.hostType union:
readonly hostType: "openclaw" | "hermes" | "standalone" | "claude-code" | "cursor" | "codex" | "windsurf";

// Add to RuntimeContext.platform union:
platform: "openclaw" | "hermes" | "cli" | "gateway" | "claude-code" | "cursor" | "codex" | "windsurf" | string;
```

#### 7 · CLI entry point (`bin/tdai-{platform}-mcp.ts`)

Copy `bin/tdai-cursor-mcp.ts` and change:
- The import to use `WindsurfMcpServer`
- The default `dataDir` to `~/.tdai/windsurf`
- The env var prefix documentation comment

Then create `bin/tdai-{platform}-mcp.mjs` (copy `bin/tdai-cursor-mcp.mjs`, change the entry path).

#### 8 · Register the binary (`package.json`)

```json
"bin": {
  "tdai-windsurf-mcp": "./bin/tdai-windsurf-mcp.mjs"
}
```

#### 9 · Platform configuration

Create a platform-specific settings snippet for the docs (e.g. `~/.windsurf/mcp.json`):

```json
{
  "mcpServers": {
    "tdai-memory": {
      "command": "tdai-windsurf-mcp",
      "env": {
        "TDAI_DATA_DIR": "/Users/you/.tdai/windsurf",
        "TDAI_LLM_BASE_URL": "https://api.openai.com/v1",
        "TDAI_LLM_API_KEY": "sk-...",
        "TDAI_LLM_MODEL": "gpt-4o"
      }
    }
  }
}
```

---

## Path B — HTTP Platform (~30 lines total)

For platforms that talk HTTP rather than MCP stdio — Dify, n8n, Coze, or any
workflow tool with an HTTP request node — the base layer is symmetric with
Path A. You do **not** write an HTTP server; `HttpServerBase` already provides
one.

### What you need to implement

| File | Purpose | Members to write |
|---|---|---|
| `host-adapter.ts` | Extends `HostAdapterBase` | `hostType`, `platformId` |
| `http-server.ts` | Extends `HttpServerBase` | `createAdapter()` |
| `types.ts` | Option type aliases | — |
| `index.ts` | Barrel | — |

`src/adapters/dify/` is the complete reference — all four files together are
under 30 lines.

### Step 1 — the host adapter

```typescript
import { HostAdapterBase } from "../host-adapter-base.js";
import type { HostAdapterBaseOptions } from "../host-adapter-base.js";

export type { HostAdapterBaseOptions as MyPlatformHostAdapterOptions };

export class MyPlatformHostAdapter extends HostAdapterBase {
  readonly hostType = "my-platform" as const;
  protected readonly platformId = "my-platform";
}
```

Two members, no methods. `HostAdapterBase` supplies `getRuntimeContext()`,
`getLogger()` and `getLLMRunnerFactory()`, and is shared with the MCP adapters
— `McpHostAdapterBase` is the same class plus session-key resolution.

> **On identity:** `TdaiCore` currently reads only `dataDir` from
> `RuntimeContext`. `userId` is recorded but does not scope storage, so a
> single server instance shares one memory store across all callers. Do not
> build per-tenant isolation on it until that lands.

### Step 2 — the server

```typescript
import { HttpServerBase } from "../http-server-base.js";
import { MyPlatformHostAdapter } from "./host-adapter.js";
import type { HostAdapter } from "../../core/types.js";

export class MyPlatformHttpServer extends HttpServerBase {
  protected createAdapter(): HostAdapter {
    return new MyPlatformHostAdapter({ ...this.opts, logger: this.logger });
  }
}
```

That is the whole server. You inherit six endpoints, Bearer auth, a CORS
allow-list, graceful shutdown and health reporting:

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /health` | none | Always open, for probes and health-checks |
| `POST /recall` | required | |
| `POST /capture` | required | |
| `POST /search/memories` | required | |
| `POST /search/conversations` | required | |
| `POST /session/end` | required | Flushes pending pipelines |

### Step 3 — the entry point

```typescript
#!/usr/bin/env node
import { MyPlatformHttpServer } from "../src/adapters/my-platform/index.js";
import { loadHttpEnvOptions } from "./shared-http.js";

new MyPlatformHttpServer(loadHttpEnvOptions("my-platform", 8420)).start().catch((err: unknown) => {
  process.stderr.write(`[tdai] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
```

`loadHttpEnvOptions` reads the shared `TDAI_*` variables plus `TDAI_PORT`,
`TDAI_HOST`, `TDAI_GATEWAY_API_KEY` and `TDAI_CORS_ORIGINS`. `start()` installs
its own `SIGTERM`/`SIGINT` handlers, so do not add any.

Register the `.mjs` launcher under `bin` in `package.json`, mirroring
`tdai-dify-http`.

### Optional hooks

| Hook | Use it for |
|---|---|
| `onAfterInit()` | Background timers, startup warnings |
| `onBeforeShutdown()` | Final flush |
| `handleCustomRoute(method, pathname, req, res)` | Extra endpoints; return `true` if you responded |
| `buildMemoryConfig()` | Supply an already-parsed `MemoryTdaiConfig` instead of raw overrides |

`TdaiGateway` (`src/gateway/server.ts`) uses all four: YAML config through
`buildMemoryConfig()`, `POST /seed` through `handleCustomRoute()`, and security
posture logging through `onAfterInit()`. It is the reference for a
non-trivial HTTP platform.

### Path C — in-process platform

If the platform runs in the same process (an SDK plugin rather than a network
service), skip both base classes and implement `HostAdapter` directly, then
drive `TdaiCore` from the platform's own hooks:

```typescript
const core = new TdaiCore({ hostAdapter: new MyHostAdapter(opts), config: parseConfig({}) });
await core.initialize();

const recall = await core.handleBeforeRecall(userMessage, sessionKey);
// → inject recall.prependContext / recall.appendSystemContext

await core.handleTurnCommitted({ userText, assistantText, messages, sessionKey, sessionId, startedAt });
```

Use `StandaloneLLMRunnerFactory` unless the platform has its own LLM runtime —
see `src/adapters/standalone/llm-runner.ts`. `src/adapters/openclaw/` is the
reference implementation.

For the **Hermes pattern** (Python process + Node.js sidecar), the sidecar is
just `TdaiGateway`; the Python provider calls it over HTTP and
`GatewaySupervisor` manages the subprocess. See
`hermes-plugin/memory/memory_tencentdb/`.

---

## Design Decisions

### Session key strategy

MCP servers are long-lived (one process per workspace or per session depending on the platform). Session key resolution follows this priority chain for all MCP adapters:

```
explicit session_key arg   →   platform session env var   →   process-stable UUID
```

The UUID fallback means: all conversations in one server process share a session until restart. This is acceptable for project-focused tools (Cursor, Windsurf) where workspace = context. For session-focused tools like Claude Code, the platform provides `CLAUDE_CODE_SESSION_ID` so each conversation gets its own key automatically.

If the platform provides a per-conversation ID, pass it as the env var name to `sessionKeyFromEnv`. If it doesn't, document that users can set `TDAI_SESSION_KEY` for cross-session continuity.

### Capture mode

| Mode | When to use |
|---|---|
| **Automatic** | Platform fires a post-response hook (e.g. Claude Code Stop hook). Write a capture hook script + queue file; drain in `onBeforeRecall`. |
| **Explicit tool** | Platform has no hooks. Instruct the LLM via platform-specific rules/config to call `tdai_memory_capture` after each turn. |

Never use both modes simultaneously — it causes duplicate L0 records.

### Logger sharing

Pass `{ ...this.opts, logger: this.logger }` to the host adapter constructor in `createAdapter()`. This ensures the server and adapter share the same logger instance, so a user-supplied custom logger reaches both layers.

### `onBeforeRecall` / `onAfterInit` / `onBeforeShutdown` hooks

Override these in `McpServerBase` subclasses to add platform-specific behaviour without duplicating lifecycle code:

| Hook | Use for |
|---|---|
| `onAfterInit()` | Start background timers (e.g. periodic queue drain) |
| `onBeforeRecall()` | Drain a capture queue before recall |
| `onBeforeShutdown()` | Final flush, clear timers |

Default implementations are no-ops, so platforms that don't need them pay zero overhead.

---

## Common Pitfalls

**Double-capture.** If the platform has both an automatic capture hook AND the LLM is instructed to call `tdai_memory_capture`, every turn is written to L0 twice. TdaiCore deduplicates at L1 (not L0), so raw records accumulate. Use one mode only.

**Session key mismatch.** The MCP server and any capture hook script must derive the session key from the same source. If the hook reads `PLATFORM_SESSION_ID` and the server reads `TDAI_SESSION_KEY`, a session key mismatch silently splits history into two sessions. Always use `sessionKeyFromEnv` with the same env var in both places.

**Hook must always exit 0.** Post-response hooks must not block the agent. Always `process.exit(0)` in hook scripts, even on error — a non-zero exit code can block or abort the agent's turn in some platforms.

**MCP env var isolation.** Many platforms do not inherit `mcpServers.env` values in hook/subprocess environments. Any env var your hook needs (especially `TDAI_DATA_DIR`) must be prefixed directly in the hook command string or exported in the shell profile.

**SQLite concurrency.** `TdaiCore` holds an open SQLite connection. A hook script that also writes to the same database risks lock contention. Use a queue file (like Claude Code's `hook-queue.jsonl`) and let the MCP server drain it — the hook does only fast file I/O and never touches SQLite directly.
