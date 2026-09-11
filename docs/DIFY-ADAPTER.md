# Dify Adapter Guide

This guide documents the Dify-specific follow-up adapter for TencentDB Agent
Memory. It intentionally stays narrower than the shared Gateway client baseline:
the Dify adapter maps workflow variables to the existing Gateway `/recall` and
`/capture` routes, while reusable cross-platform client boundaries should live
in the dedicated Gateway adapter kit.

## Scope

Included:

- Dify workflow input mapping for recall before the LLM node.
- Dify answer mapping for capture after the LLM node.
- Stable Dify `session_key` construction from platform, user, conversation, and
  optional session IDs.
- HTTP-only Dify node examples for users who do not run TypeScript.

Not included:

- A general-purpose Gateway SDK.
- MCP server, Python SDK, Codex or Claude hooks.
- Core memory runtime changes.
- CI or packaging changes beyond the Dify adapter export.

## Gateway Setup

Start the Gateway in the plugin checkout:

```bash
npx tsx src/gateway/server.ts
```

Verify it:

```bash
curl http://127.0.0.1:8420/health
```

If the Gateway is protected, configure the same token on both sides:

```bash
export TDAI_GATEWAY_API_KEY="replace-me"
```

The Dify adapter sends:

```http
Authorization: Bearer replace-me
```

## TypeScript Adapter

Use the TypeScript adapter when your Dify workflow can call a small Node.js
bridge service. The adapter accepts either an injected Dify memory port or
Dify-scoped HTTP Gateway options.

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

## HTTP-Only Dify Nodes

If you do not run TypeScript, use two HTTP request nodes.

Before the LLM node:

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

After the LLM node:

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

## Field Mapping

| Dify field | Gateway field | Notes |
| --- | --- | --- |
| `query`, `inputs.query`, `user_content`, `prompt`, `message` | `query` / `user_content` | Recall and capture accept common Dify variable names. |
| `answer`, `assistant_content`, `response`, `output` | `assistant_content` | Required for capture. |
| `user`, `user_id` | `user_id` and `session_key` part | Falls back to `default_user`. |
| `conversation_id`, `session_id` | `session_key` part | Falls back to `default_conversation`. |
| `messages` | `messages` | Forwarded to `/capture` when present. |

## Validation

Run adapter-focused tests:

```bash
npm test -- src/adapters/dify/index.test.ts
```

Run the full suite before opening or updating a PR:

```bash
npm test
npm run build
git diff --check
```
