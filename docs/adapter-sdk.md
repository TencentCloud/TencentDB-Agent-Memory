# Adapter SDK

TencentDB Agent Memory exposes a small adapter SDK so a new Agent platform does
not need to duplicate memory tool schemas, Gateway HTTP calls, parameter
normalization, or result formatting. A platform adapter only implements one
host-facing interface: `TdaiPlatformAdapter`.

## What the SDK Owns

The SDK lives under `src/adapter-sdk/` and provides:

| Module | Responsibility |
| --- | --- |
| `types.ts` | The single platform interface, shared tool/result types, and SDK contracts |
| `tools.ts` | Canonical memory tool definitions for MCP and OpenClaw surfaces |
| `params.ts` | Shared argument parsing and search `limit` normalization |
| `gateway-client.ts` | TypeScript Gateway client for HTTP-based adapters |
| `runtime.ts` | Runtime dispatcher for recall, capture, search, session flush, and tool calls |
| `results.ts` | MCP/OpenClaw-compatible text and error result formatting |

This keeps the platform boundary narrow. New platforms provide session and event
mapping; the SDK handles the memory operations.

For a complete type-checkable onboarding example, see
[`examples/adapter-sdk/platform-adapter.ts`](../examples/adapter-sdk/platform-adapter.ts).

## Single Interface for a New Platform

```ts
import {
  TdaiAdapterRuntime,
  CoreMemoryOperations,
  type TdaiPlatformAdapter,
} from "@tencentdb-agent-memory/memory-tencentdb/adapter-sdk";
import { TdaiCore } from "../src/core/tdai-core.js";

interface MyEvent {
  prompt: string;
  messages: unknown[];
}

interface MyContext {
  sessionKey: string;
  sessionId?: string;
}

const adapter: TdaiPlatformAdapter<MyEvent, MyContext> = {
  platform: "my-agent-platform",

  getSession({ context }) {
    return {
      sessionKey: context.sessionKey,
      sessionId: context.sessionId,
    };
  },

  getRecallInput({ event }) {
    return { query: event.prompt };
  },

  getCaptureInput({ event }) {
    return {
      userContent: event.prompt,
      assistantContent: "",
      messages: event.messages,
      originalUserMessageCount: event.messages.length,
    };
  },

  applyRecallResult(result) {
    return result;
  },
};

const runtime = new TdaiAdapterRuntime({
  adapter,
  operations: new CoreMemoryOperations({ core: tdaiCore as TdaiCore }),
});

// Host lifecycle hooks call these:
await runtime.handleRecall({ event, context });
await runtime.handleCapture({ event, context });
```

For platforms that cannot run the TypeScript core in-process, use the Gateway
operation wrapper instead:

```ts
import {
  GatewayMemoryOperations,
  TdaiAdapterRuntime,
  TdaiGatewayClient,
} from "@tencentdb-agent-memory/memory-tencentdb/adapter-sdk";

const client = new TdaiGatewayClient({
  baseUrl: "http://127.0.0.1:8420",
  timeoutMs: 10_000,
});

const runtime = new TdaiAdapterRuntime({
  adapter,
  operations: new GatewayMemoryOperations({
    client,
    defaultSessionKey: "my-platform-default",
  }),
});
```

## Shared Tool Contract

The SDK is the single source of truth for memory tool metadata:

| SDK function | Consumer |
| --- | --- |
| `getMcpToolDefinitions()` | MCP stdio servers and MCP-capable clients |
| `getOpenClawSearchToolDefinitions()` / `getCanonicalTool()` | OpenClaw plugin tool registration |

The canonical tool set is:

| Tool | Capability |
| --- | --- |
| `memory_tencentdb_health` | Gateway health check |
| `memory_tencentdb_recall` | Recall memory context before a model turn |
| `memory_tencentdb_capture` | Capture a completed user/assistant turn |
| `memory_tencentdb_memory_search` | Search L1 structured memories |
| `memory_tencentdb_conversation_search` | Search L0 raw conversations |
| `memory_tencentdb_session_end` | Flush session-scoped work |

OpenClaw keeps its established in-host search tool names:

| OpenClaw tool | Canonical capability |
| --- | --- |
| `tdai_memory_search` | L1 structured memory search |
| `tdai_conversation_search` | L0 raw conversation search |

## Existing Consumers

The SDK is already used by TypeScript adapter surfaces:

| Consumer | Reused SDK surface |
| --- | --- |
| MCP stdio adapter | Gateway client, MCP server instructions, tool definitions, tool annotations, tool call dispatcher, MCP result formatting |
| Codex hooks example | `TdaiPlatformAdapter` lifecycle mapping, Gateway operations, recall/capture runtime |
| OpenClaw plugin | Canonical search tool definitions, search limit normalization, OpenClaw result formatting |

Hermes remains a Python provider and continues to call the Gateway. Its Gateway
contract stays compatible with the TypeScript SDK because the shared tool and
HTTP shapes match the existing `/recall`, `/capture`, `/search/*`, and
`/session/end` routes.

## Codex Example Integration

Codex can use TencentDB Agent Memory through the package-provided MCP entry and
an optional hook reference implementation under `examples/codex/`:

| Entry | Codex surface | SDK path |
| --- | --- | --- |
| `memory-tencentdb-mcp` | MCP stdio server | `GatewayMemoryOperations` + canonical MCP tools |
| `examples/codex/hooks-adapter/` | `UserPromptSubmit` and `Stop` hooks | `TdaiPlatformAdapter` + `TdaiAdapterRuntime.handleRecall()` / `handleCapture()` |

The MCP entry exposes the complete memory tool surface to Codex. The hook
example adds automatic lifecycle behavior without becoming a package `bin`
entry:

1. `UserPromptSubmit` maps Codex `session_id` to a memory `session_key`, calls
   recall, and returns Codex `additionalContext`.
2. `Stop` uses the stored prompt plus Codex `last_assistant_message` to capture
   the completed turn.

See [`examples/codex/`](../examples/codex/) for a complete `config.toml`
example.

## Validation

Run the SDK and adapter contract tests:

```bash
npx vitest run src/adapter-sdk/adapter-sdk.test.ts __tests__/mcp-adapter.test.ts
```

Run the Codex hook adapter tests:

```bash
npx vitest run __tests__/codex-hooks-adapter.test.ts
```

Run the MCP adapter build:

```bash
npm run build:mcp-adapter
```

Type-check and build the optional Codex hook example:

```bash
npx tsc -p examples/codex/hooks-adapter/tsconfig.json
```

For full repository verification:

```bash
npm test
npm run build
```

Type-check the standalone SDK onboarding example:

```bash
npm run build
npx tsc -p examples/adapter-sdk/tsconfig.json
```
