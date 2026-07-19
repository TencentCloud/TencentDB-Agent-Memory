# Cross-Platform Gateway Adapter Kit

This guide explains how a new agent platform can integrate with
`memory-tencentdb` through the existing TDAI Gateway API.

## Architecture

```text
New platform hooks/tools
        |
        v
GatewayMemoryClient + createGatewayPlatformAdapter
        |
        v
TDAI Gateway HTTP API
        |
        v
StandaloneHostAdapter → TdaiCore
```

For platforms such as Codex, Claude Code, Dify, LangGraph, or custom agents,
the recommended path is to reuse the Gateway API. This keeps
platform-specific SDKs outside the core package and preserves the same memory
behavior as Hermes/Gateway deployments.

## Data Flow

| Platform event            | Adapter call            | Gateway route              | Core operation            |
|---------------------------|-------------------------|----------------------------|---------------------------|
| Prompt is about to build  | `prefetch(query)`       | `POST /recall`             | `handleBeforeRecall()`    |
| Assistant turn complete   | `captureTurn(turn)`     | `POST /capture`            | `handleTurnCommitted()`   |
| User searches memories    | `searchMemories(params)`| `POST /search/memories`    | `searchMemories()`        |
| User searches convos      | `searchConversations()` | `POST /search/conversations`| `searchConversations()`  |
| Session ends              | `endSession()`          | `POST /session/end`        | `handleSessionEnd()`      |

## Minimal Usage

```ts
import {
  GatewayMemoryClient,
  createGatewayPlatformAdapter,
} from "@tencentdb-agent-memory/memory-tencentdb";

const client = new GatewayMemoryClient({
  baseUrl: process.env.TDAI_GATEWAY_URL ?? "http://127.0.0.1:8420",
  apiKey: process.env.TDAI_GATEWAY_API_KEY,
});

const memory = createGatewayPlatformAdapter({
  client,
  platform: "codex",
  resolveContext: () => ({
    userId: process.env.USER ?? "default_user",
    sessionKey: `${process.cwd()}:default`,
  }),
});

// Before building the LLM prompt:
const recall = await memory.prefetch(userPrompt);
const promptWithMemory = `${recall.context}\n\n${userPrompt}`;

// After the assistant responds:
await memory.captureTurn({
  userText: userPrompt,
  assistantText: assistantResponse,
});
```

## Platform Checklist

1. Start or point to a TDAI Gateway process.
2. Configure `TDAI_GATEWAY_API_KEY` for any non-local deployment.
3. Resolve a stable `sessionKey` and optional `userId`.
4. Call `prefetch()` before building the model prompt.
5. Call `captureTurn()` after the assistant response is committed.
6. Expose search tools by forwarding to `searchMemories()` and
   `searchConversations()`.
7. Call `endSession()` when the host run closes so delayed work can flush.
