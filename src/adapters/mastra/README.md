# Mastra adapter

This adapter reuses `GatewayMemoryClient` and maps TencentDB Agent Memory to
Mastra's native Processor lifecycle.

| Mastra lifecycle | Memory operation |
| --- | --- |
| `processInput` | Recall and inject a tagged system message |
| `processOutputResult` | Capture a completed `stop` or `length` response |
| Application thread close | Explicit `flushMastraSession()` call |

## Setup

```bash
npm install @mastra/core @tencentdb-agent-memory/memory-tencentdb
```

```ts
import { Agent } from "@mastra/core/agent";
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";
import {
  GatewayMemoryClient,
  createMastraMemoryProcessor,
  flushMastraSession,
} from "@tencentdb-agent-memory/memory-tencentdb";

const client = new GatewayMemoryClient({
  baseUrl: process.env.TDAI_GATEWAY_URL ?? "http://127.0.0.1:8420",
  apiKey: process.env.TDAI_GATEWAY_API_KEY,
});
const memoryProcessor = createMastraMemoryProcessor({
  client,
  onError: ({ phase, error }) =>
    console.warn(`[memory-tdai][mastra] ${phase} failed`, error),
});

const agent = new Agent({
  id: "assistant",
  name: "Assistant",
  instructions: "You are a helpful assistant.",
  model: "openai/gpt-5-mini",
  inputProcessors: [memoryProcessor],
  outputProcessors: [memoryProcessor],
});

const requestContext = new RequestContext();
requestContext.set(MASTRA_THREAD_ID_KEY, "conversation-42");
requestContext.set(MASTRA_RESOURCE_ID_KEY, "user-7");

await agent.generate("How should I format this answer?", { requestContext });

// Call only from a real thread-close, archive, or logout path.
await flushMastraSession({
  client,
  threadId: "conversation-42",
  resourceId: "user-7",
});
```

The processor also reads `thread` and `resource` from Mastra `MessageList`
memory metadata. Trusted `RequestContext` values take precedence. Gateway
session keys use the stable `mastra:<threadId>` format.

Recall, capture, and flush are fail-open. Gateway errors can be observed with
`onError` but do not abort the agent or shutdown path.

Mastra Processors do not expose a multi-turn session-end hook, so session flush
remains explicit. This adapter does not add MCP, duplicate the Gateway client,
or modify core/runtime behavior.
