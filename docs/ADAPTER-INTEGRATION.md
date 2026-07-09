# Adapter Integration Guide

TencentDB Agent Memory can be embedded in OpenClaw, used through the Hermes
provider, or called by any host that can reach the standalone Gateway. This
guide documents the stable integration boundary for new adapters.

## Integration Boundary

`TdaiCore` owns memory capture, recall, search, and the L0 to L3 pipeline. Host
frameworks should not call storage internals directly. Instead, use one of these
adapter shapes:

| Mode | Best for | Boundary |
| --- | --- | --- |
| OpenClaw HostAdapter | OpenClaw plugins | In-process `HostAdapter` plus hooks |
| Hermes provider | Hermes memory provider | Python provider talks to Gateway |
| HTTP REST Gateway | Dify, Coze, LangGraph, webhooks | `POST /recall`, `POST /capture`, search routes |
| TypeScript Gateway client | Node.js adapters | `TdaiGatewayClient` wrapper over REST routes |

New platform adapters should prefer the Gateway boundary unless they run inside
the same JavaScript process as `TdaiCore`.

## No OpenTelemetry Requirement

The TypeScript Gateway client added for cross-platform adapters has no
OpenTelemetry dependency. It only uses `fetch` and the existing Gateway HTTP
schema. This keeps adapters isolated from observability SDK version conflicts
and avoids the `Resource is not a constructor` mismatch that can happen when
mixing OpenTelemetry v1 APIs with v2 packages.

## Gateway Setup

Start the Gateway in the plugin checkout:

```bash
npx tsx src/gateway/server.ts
```

Verify it:

```bash
curl http://127.0.0.1:8420/health
```

If the Gateway is protected, set the same token on both sides:

```bash
export TDAI_GATEWAY_API_KEY="replace-me"
```

Clients send:

```http
Authorization: Bearer replace-me
```

## TypeScript Client

```ts
import {
  TdaiGatewayClient,
  createGatewaySessionKey,
} from "@tencentdb-agent-memory/memory-tencentdb";

const client = new TdaiGatewayClient({
  baseUrl: "http://127.0.0.1:8420",
  apiKey: process.env.TDAI_GATEWAY_API_KEY,
});

const sessionKey = createGatewaySessionKey({
  platform: "my-agent",
  userId: "user-42",
  conversationId: "conversation-abc",
});

const recall = await client.recall({
  query: "What should I remember before answering?",
  session_key: sessionKey,
  user_id: "user-42",
});

const promptWithMemory = `${recall.context}\n\nUser: ...`;

await client.capture({
  user_content: "User request text",
  assistant_content: "Assistant answer text",
  session_key: sessionKey,
  user_id: "user-42",
});
```

## Dify Workflow Adapter

The Dify adapter is a thin mapper from common workflow variables to Gateway
requests. Use it when a Dify workflow can run a small JavaScript/TypeScript
adapter service, or copy the same field mapping into HTTP request nodes.

```ts
import { createDifyWorkflowMemoryAdapter } from "@tencentdb-agent-memory/memory-tencentdb";

const memory = createDifyWorkflowMemoryAdapter({
  gateway: {
    baseUrl: "http://127.0.0.1:8420",
    apiKey: process.env.TDAI_GATEWAY_API_KEY,
  },
});

const recalled = await memory.recall({
  query: inputs.query,
  conversation_id: conversationId,
  user: userId,
});

// Inject recalled.memory_context into the Dify prompt template.

await memory.capture({
  query: inputs.query,
  answer: llmAnswer,
  conversation_id: conversationId,
  user: userId,
});
```

### HTTP-only Dify Nodes

If you do not run TypeScript, use two HTTP request nodes:

1. Before the LLM node:

```http
POST http://127.0.0.1:8420/recall
Content-Type: application/json
Authorization: Bearer ${TDAI_GATEWAY_API_KEY}

{
  "query": "{{query}}",
  "session_key": "dify:{{user}}:{{conversation_id}}",
  "user_id": "{{user}}"
}
```

Use `context` from the response as `memory_context`.

2. After the LLM node:

```http
POST http://127.0.0.1:8420/capture
Content-Type: application/json
Authorization: Bearer ${TDAI_GATEWAY_API_KEY}

{
  "user_content": "{{query}}",
  "assistant_content": "{{answer}}",
  "session_key": "dify:{{user}}:{{conversation_id}}",
  "user_id": "{{user}}"
}
```

## Adapter Checklist

- Build a stable `session_key` from platform, user, and conversation IDs.
- Call `/recall` before the model turn and inject `context` into the prompt.
- Call `/capture` after a successful assistant turn.
- Keep platform-specific fields outside `TdaiCore`; map them in the adapter.
- Forward the Bearer token when `TDAI_GATEWAY_API_KEY` is enabled.
- Do not import store internals or mutate files under the data directory.

## Validation

Run adapter-focused tests:

```bash
npm test -- src/adapters/gateway-client.test.ts src/adapters/dify/index.test.ts
```

Run the full suite before opening a PR:

```bash
npm test
npm run build
```
