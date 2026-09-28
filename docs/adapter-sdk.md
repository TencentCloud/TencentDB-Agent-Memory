# Add a platform with the Adapter SDK

Use the Adapter SDK when a platform needs automatic recall, capture, or session flushing through native hooks or a plugin. The platform implements one `PlatformAdapter` interface and receives an `AdapterRuntime` that handles Gateway calls, fail-open behavior, operation deduplication, per-session queues, and shutdown waiting.

MCP and the Adapter SDK solve different problems. MCP exposes memory tools to any compatible client. The Adapter SDK maps deterministic platform lifecycle events to those memory capabilities.

## Understand the four boundaries

| Boundary | Responsibility |
| --- | --- |
| `HostAdapter` | Supplies runtime context, logging, and LLM execution to `TdaiCore` |
| `MemoryClient` | Calls recall, capture, search, and session-end capabilities through the Gateway |
| `PlatformAdapter` | Maps one platform's native lifecycle to the shared runtime |
| MCP server | Exposes memory capabilities as model-callable protocol tools |

New platform integrations normally implement `PlatformAdapter`. They should not implement `HostAdapter` unless they also run `TdaiCore` in their own process.

## Implement one platform interface

```ts
import {
  createAdapterRuntime,
  createGatewayMemoryClient,
  type AdapterRuntime,
  type PlatformAdapter,
} from "@tencentdb-agent-memory/memory-tencentdb/adapter-sdk";

interface ExampleHooks {
  beforePrompt(sessionId: string, prompt: string): Promise<string>;
  afterTurn(sessionId: string, turnId: string, user: string, assistant: string): Promise<void>;
  sessionEnd(sessionId: string): Promise<void>;
}

class ExampleAdapter implements PlatformAdapter<ExampleHooks> {
  readonly platform = "example";

  create(runtime: AdapterRuntime): ExampleHooks {
    return {
      beforePrompt: async (sessionId, prompt) => {
        const memory = await runtime.recall({ query: prompt, sessionKey: `example:${sessionId}` });
        return memory ? `<relevant-memories>\n${memory.context}\n</relevant-memories>\n${prompt}` : prompt;
      },
      afterTurn: async (sessionId, turnId, user, assistant) => {
        await runtime.capture({
          operationId: turnId,
          sessionKey: `example:${sessionId}`,
          sessionId,
          userContent: user,
          assistantContent: assistant,
        });
      },
      sessionEnd: async (sessionId) => {
        await runtime.endSession({ operationId: sessionId, sessionKey: `example:${sessionId}` });
      },
    };
  }
}

const adapter = new ExampleAdapter();
const hooks = adapter.create(createAdapterRuntime({
  platform: adapter.platform,
  client: createGatewayMemoryClient(),
}));
```

Connect `hooks` to the platform's native hook or plugin API. The SDK does not prescribe hook names or the context injection format because those are platform presentation concerns.

## Use stable identifiers

- Namespace session keys with the platform name, such as `example:<session-id>`.
- Use a stable turn or message ID as `operationId` for capture.
- Use the stable session ID as the session-end `operationId`.
- Keep the same operation ID when retrying.

The default file operation store prevents concurrent or completed operations from running twice and releases failed claims for retry. It writes under `~/.memory-tencentdb/adapter-sdk/<platform>` with restricted file permissions and automatic stale-claim recovery.

## Keep platform concerns in the adapter

The platform adapter remains responsible for identifying completed turns, choosing the recall injection position, extracting visible text, and connecting handlers to the platform SDK.

The shared runtime treats memory failures as fail-open, trims empty recall results, deduplicates capture and session-end operations, serializes work passed to `runExclusive`, and waits for queued work during `dispose`.

Existing adapters that already own cross-process claims can inject `ExternalAdapterOperationStore` so their current state remains the single deduplication owner. New adapters should use the default file operation store.

See [the platform comparison](platform-comparison.md) for the Codex, Claude Code, and OpenCode lifecycle mappings.