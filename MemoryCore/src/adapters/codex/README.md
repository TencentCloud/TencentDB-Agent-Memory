# Codex CLI Adapter for TDAI Memory System

A production-quality adapter that integrates the [OpenAI Codex CLI](https://github.com/openai/codex) with the TDAI (TencentDB Agent) memory engine. Codex is an OpenAI-based CLI agent that supports hooks and tool registration; this adapter bridges Codex's lifecycle-hook model to the TDAI Gateway's memory APIs (L0 conversation recording, L1 structured memory search, L2 scene navigation, L3 persona).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Codex CLI                                                        │
│                                                                   │
│  User input ──► beforePromptBuild ──► LLM call ──► afterResponse │
│                      │                              │            │
│                      ▼                              ▼            │
│              CodexHooks.beforePromptBuild   CodexHooks.afterResp │
│                      │                              │            │
│                      ▼                              ▼            │
│              CodexAdapter.recall()       CodexAdapter.capture()  │
│                      │                              │            │
│                      ▼                              ▼            │
│            MemoryAdapterBase ──────► MemoryGatewayClient ────── │
│            (circuit breaker,        (HTTP v3 API calls)          │
│             graceful degradation)                                 │
│                              │                                    │
│                              ▼                                    │
│                    TDAI Gateway (port 8420)                       │
│                                                                   │
│  Tool call ──► onToolCall ──► handleToolCall() ──► result       │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### Files

| File | Purpose |
|------|---------|
| `codex-adapter.ts` | Main adapter class extending `MemoryAdapterBase`. Implements 4 abstract methods: `formatRecallResult`, `getToolDefinitions`, `formatToolResult`, `normalizeMessages`. Includes `createCodexAdapter()` factory and `resolveCodexConfig()` env-based config resolver. |
| `hooks.ts` | `CodexHooks` class wrapping the adapter. Provides pre-bound hook handlers (`beforePromptBuild`, `afterResponse`, `onToolCall`) and registration helpers (`registerAll`, `registerTools`). |
| `index.ts` | Barrel re-exports for the public API. |

---

## Quick Start

### 1. Configure environment variables

```bash
# TDAI Gateway connection
export TDAI_GATEWAY_ENDPOINT="http://127.0.0.1:8420"
export TDAI_GATEWAY_API_KEY="your-api-key"
export TDAI_GATEWAY_SERVICE_ID="my-service"
export TDAI_GATEWAY_TIMEOUT_MS="10000"

# Tenancy (all default to "default")
export TDAI_TEAM_ID="my-team"
export TDAI_AGENT_ID="my-agent"
export TDAI_USER_ID="alice"

# Optional tuning
export TDAI_CAPTURE_ENABLED="true"
export TDAI_RECALL_MAX_RESULTS="5"
export TDAI_GATEWAY_REJECT_UNAUTHORIZED="true"
```

### 2. Create and register hooks

```typescript
import { createCodexHooks } from "./adapters/codex/index.js";

async function setupCodex(codex: CodexCLI) {
  // Create adapter + hooks in one call (reads env vars)
  const { hooks, adapter } = await createCodexHooks();

  // Register lifecycle hooks with Codex
  hooks.registerAll(codex);

  // Register memory tools with Codex
  hooks.registerTools(codex);

  return hooks;
}
```

### 3. Manual setup (without the factory)

```typescript
import { createCodexAdapter, CodexHooks } from "./adapters/codex/index.js";

// Create adapter with explicit config overrides
const adapter = await createCodexAdapter({
  gateway: { endpoint: "http://localhost:8420" },
  tenancy: { userId: "alice" },
  recallMaxResults: 10,
});

// Create hooks wrapper
const hooks = new CodexHooks(adapter, (level, msg) => {
  console.log(`[${level}] ${msg}`);
});

// Register with Codex
hooks.registerAll(codex);
hooks.registerTools(codex);
```

---

## Hook Lifecycle

### `beforePromptBuild(userText, sessionId)`

Called before Codex builds the final prompt for the LLM.

1. Sets the session ID on the adapter.
2. Calls `adapter.recall(userText, sessionId)` which fetches L1 memories, L3 persona, and L2 scene navigation from the Gateway in parallel.
3. Returns Markdown-formatted context:
   - `prependContext` — L1 relevant memories (injected before the user's message, dynamic per-turn).
   - `appendSystemContext` — L3 persona + L2 scene navigation + tool guide (appended to system prompt, stable/cacheable).

**Never throws.** On failure, returns empty strings so Codex proceeds without memory.

### `afterResponse(messages, sessionId)`

Called after the LLM produces its response for the current turn.

1. Sets the session ID on the adapter.
2. Calls `adapter.capture(messages, sessionId)` which normalizes Codex messages and sends them to the Gateway for L0 recording.

**Never throws.** On failure, returns `{ capturedCount: 0, success: false }`.

### `onToolCall(toolName, args)`

Called when the LLM invokes a registered memory tool.

Dispatches to `adapter.handleToolCall(toolName, args)`, which routes to:
- `tdai_memory_search` → `searchMemories()` (L1 structured memory search)
- `tdai_conversation_search` → `searchConversations()` (L0 raw conversation search)
- `tdai_read_scene` → `readScene()` (L2 scene block read)

**Never throws.** On failure, returns a JSON error envelope.

---

## Message Normalization

Codex represents conversations as an array of `{ role, content, timestamp }` objects. The adapter's `normalizeMessages()` handles three `content` shapes:

| Shape | Example | Handling |
|-------|---------|----------|
| Plain string | `"Hello"` | Used directly |
| Array of content blocks | `[{ type: "text", text: "Hello" }]` | Concatenates all `text`/`input_text` blocks |
| `null` / `undefined` | `null` | Skipped (no text to record) |

Role normalization:

| Codex role | Standard role |
|------------|---------------|
| `user`, `human` | `user` |
| `assistant`, `ai`, `bot` | `assistant` |
| `system`, `developer` | `system` |
| `tool`, `function` | `tool` |
| *(unknown)* | *(skipped)* |

---

## Recall Result Formatting

`formatRecallResult()` produces Markdown context blocks:

**prependContext (L1 memories):**
```markdown
## Relevant Memories

The following memories were recalled for this conversation. They are contextual references only and may not reflect the current task.

- **[episodic]** User prefers TypeScript over JavaScript (score: 0.92)
- **[instruction]** Always use functional components in React (score: 0.87)
```

**appendSystemContext (L3 persona + L2 scenes):**
```markdown
## User Persona

Alice is a senior frontend engineer who values clean, type-safe code.

## Scene Navigation

The following scene blocks are available. Use the `tdai_read_scene` tool to read a scene's full content.

- `travel-plan.md` — Summer trip to Japan _(heat: 3)_
- `project-setup.md` — React project initialization

## Memory Tools

- `tdai_memory_search` — Search structured memories (L1).
- `tdai_conversation_search` — Search raw conversations (L0).
- `tdai_read_scene` — Read a scene block by name.

_Limit: max 3 combined search calls per turn._
```

---

## Configuration

All configuration is resolved from environment variables with optional programmatic overrides. Programmatic overrides always take precedence.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TDAI_GATEWAY_ENDPOINT` | `http://127.0.0.1:8420` | Gateway base URL |
| `TDAI_GATEWAY_API_KEY` | *(none)* | Bearer API key for authentication |
| `TDAI_GATEWAY_SERVICE_ID` | *(none)* | Instance / service ID for multi-tenant routing |
| `TDAI_GATEWAY_TIMEOUT_MS` | `10000` | Request timeout in milliseconds |
| `TDAI_GATEWAY_REJECT_UNAUTHORIZED` | `true` | Whether to reject unauthorized TLS certs |
| `TDAI_TEAM_ID` | `default` | Team (tenant) identifier |
| `TDAI_AGENT_ID` | `default` | Agent identifier |
| `TDAI_USER_ID` | `default` | User identifier |
| `TDAI_CAPTURE_ENABLED` | `true` | Whether conversation capture is enabled |
| `TDAI_RECALL_MAX_RESULTS` | `5` | Max L1 memories to recall per turn |

### Programmatic Overrides

```typescript
const adapter = await createCodexAdapter({
  gateway: {
    endpoint: "http://my-gateway:8420",
    apiKey: "secret-key",
    timeoutMs: 5000,
  },
  tenancy: {
    teamId: "engineering",
    agentId: "codex-bot",
    userId: "alice",
  },
  recallMaxResults: 10,
  recallIncludePersona: true,
  recallIncludeSceneNav: true,
  captureEnabled: true,
});
```

---

## Resilience

The adapter inherits robust error handling from `MemoryAdapterBase`:

- **Circuit breaker**: After 5 consecutive Gateway failures, the adapter pauses all recall/capture/search calls for 60 seconds, then auto-resets.
- **Graceful degradation**: Every method returns empty/safe results on failure rather than throwing. Codex never crashes due to memory subsystem errors.
- **Non-blocking health check**: At `initialize()`, a best-effort Gateway health check runs. If the Gateway is unreachable, the adapter still initializes successfully and will retry on the next operation.
- **Per-hook try/catch**: Each hook handler in `CodexHooks` wraps its body in a try/catch, guaranteeing hooks never throw into the Codex session.

---

## Registered Tools

| Tool | Description |
|------|-------------|
| `tdai_memory_search` | Search L1 structured memories by natural-language query |
| `tdai_conversation_search` | Search L0 raw conversation history |
| `tdai_read_scene` | Read an L2 scene block by file name |

Tools are registered in OpenAI function-calling format:

```json
{
  "type": "function",
  "function": {
    "name": "tdai_memory_search",
    "description": "Search structured long-term memories (L1)...",
    "parameters": {
      "type": "object",
      "properties": { "query": { "type": "string" }, ... },
      "required": ["query"]
    }
  }
}
```

---

## API Reference

### `createCodexAdapter(config?)`

Factory function that creates and initializes a `CodexAdapter`.

- **Parameters**: `config?: CodexAdapterConfig` — optional overrides (merged with env vars).
- **Returns**: `Promise<CodexAdapter>`

### `createCodexHooks(config?, logger?)`

Convenience factory that creates an adapter and wraps it in `CodexHooks`.

- **Parameters**: `config?: CodexAdapterConfig`, `logger?: (level, message) => void`
- **Returns**: `Promise<{ hooks: CodexHooks, adapter: CodexAdapter }>`

### `CodexHooks`

| Method | Description |
|--------|-------------|
| `registerAll(registry)` | Register all 3 hook handlers with a Codex hook registry |
| `registerTools(registry)` | Register memory tool definitions with a Codex tool registry |
| `getAdapter()` | Get the underlying `CodexAdapter` instance |
| `shutdown()` | Gracefully shut down the adapter |
| `beforePromptBuild` | Bound hook handler (readonly property) |
| `afterResponse` | Bound hook handler (readonly property) |
| `onToolCall` | Bound hook handler (readonly property) |

### `CodexAdapter`

Inherits all methods from `MemoryAdapterBase`:

| Method | Description |
|--------|-------------|
| `initialize(config)` | Initialize with Gateway config + health check |
| `recall(query, sessionId?)` | Recall memories (returns `{ prependContext, appendSystemContext }`) |
| `capture(rawMessages, sessionId?)` | Capture conversation to L0 |
| `searchMemories(query, options?)` | Search L1 structured memories |
| `searchConversations(query, options?)` | Search L0 raw conversations |
| `readScene(sceneId)` | Read an L2 scene block |
| `handleToolCall(toolName, args)` | Dispatch a tool call |
| `getToolDefinitions()` | Return tool schemas for Codex registration |
| `setSessionId(sessionId)` | Set the current session ID |
| `shutdown()` | Release resources |
| `resolveConfig()` | Build config from env vars + constructor overrides |

---

## Example Integration

```typescript
import { createCodexHooks } from "./adapters/codex/index.js";

async function main() {
  const codex = getCodexCLI();

  // 1. Initialize TDAI memory hooks (reads env vars)
  const { hooks, adapter } = await createCodexHooks(
    undefined,
    (level, msg) => console.error(`[tdai:${level}] ${msg}`),
  );

  // 2. Register hooks and tools with Codex
  hooks.registerAll(codex);
  hooks.registerTools(codex);

  // 3. Run Codex normally — memory recall/capture happens automatically
  await codex.run();

  // 4. Clean up on exit
  await hooks.shutdown();
}

main().catch(console.error);
```
