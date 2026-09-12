# Platform Adapter Guide

This guide describes how to connect a new Agent platform to TencentDB Agent Memory through the cross-platform adapter SDK.

## Architecture

The memory engine is split into three layers:

```text
Platform runtime
  -> MemoryPlatformBridge
    -> MemoryPlatformAdapter
      -> MemoryGatewayClient
        -> TDAI Gateway
          -> TdaiCore
```

- `TdaiCore` owns memory semantics: recall, capture, search, session flush, and the L0 to L3 pipeline.
- `MemoryGatewayClient` owns Gateway HTTP transport, auth, timeout, and response mapping.
- `MemoryPlatformAdapter` owns the common platform-facing API.
- `MemoryPlatformBridge` is the only piece a new platform must implement.

OpenClaw remains an in-process integration because it already provides a native plugin API and embedded LLM runtime. Hermes, Codex, Dify, and future platforms should use the Gateway path unless they need to embed the Node runtime directly.

## Core Engine Interface

`TdaiCore` exposes the stable host-neutral capabilities:

| Method | Purpose | Existing platform mapping |
| --- | --- | --- |
| `handleBeforeRecall(userText, sessionKey)` | Recall relevant memory before the next model turn | OpenClaw `before_prompt_build`, Hermes `prefetch`, Gateway `POST /recall` |
| `handleTurnCommitted(turn)` | Capture a completed user/assistant turn and trigger L0 to L3 processing | OpenClaw `agent_end`, Hermes `sync_turn`, Gateway `POST /capture` |
| `searchMemories(params)` | Search L1 structured memories | `tdai_memory_search`, Gateway `POST /search/memories` |
| `searchConversations(params)` | Search L0 raw conversations | `tdai_conversation_search`, Gateway `POST /search/conversations` |
| `handleSessionEnd(sessionKey)` | Flush one session without stopping the shared process | Gateway `POST /session/end`, Hermes session end |

The core depends on `HostAdapter`, `LLMRunnerFactory`, and `RuntimeContext`. New remote platforms should not implement these directly; the Gateway already wraps them through `StandaloneHostAdapter`.

## Platform Comparison

| Platform | Adapter style | Recall injection | Capture timing | Session key |
| --- | --- | --- | --- | --- |
| OpenClaw | In-process `OpenClawHostAdapter` | Native hook result | `agent_end` | `ctx.sessionKey` |
| Hermes | Python provider + Gateway sidecar | `prefetch(query)` | `sync_turn()` | Hermes `session_id` |
| Codex | TypeScript SDK | `buildPromptContext(query)` | `recordTurn()` | `codex:<userId>:<sessionId>` |
| Dify | TypeScript SDK for tool/workflow/backend extension | `buildPromptContext(query)` into prompt variables | `recordDifyTurn()` | `dify:<appId>:<userId>:<conversationId>` |

## New Platform Integration Steps

### 1. Start or reach the Gateway

The platform adapter talks to the Gateway:

```bash
npx tsx src/gateway/server.ts
```

If the Gateway enforces auth, pass the same key to the adapter:

```ts
const gateway = {
  baseUrl: "http://127.0.0.1:8420",
  apiKey: process.env.TDAI_GATEWAY_API_KEY,
};
```

### 2. Implement `MemoryPlatformBridge`

```ts
import {
  createMemoryPlatformAdapter,
  type MemoryPlatformBridge,
  type MemoryTurnPayload,
} from "@tencentdb-agent-memory/memory-tencentdb";

class MyAgentBridge implements MemoryPlatformBridge {
  getRuntime() {
    return {
      platform: "my-agent",
      userId: "user-123",
      sessionId: "thread-456",
      sessionKey: "my-agent:user-123:thread-456",
      workspaceDir: process.cwd(),
    };
  }

  buildTurn(turn: MemoryTurnPayload): MemoryTurnPayload {
    return {
      ...turn,
      messages: turn.messages ?? [
        { role: "user", content: turn.userContent },
        { role: "assistant", content: turn.assistantContent },
      ],
    };
  }
}

const memory = createMemoryPlatformAdapter(new MyAgentBridge(), gateway);
```

### 3. Inject recalled context before the model call

```ts
const ctx = await memory.buildPromptContext(userQuery);

const systemPrompt = [
  baseSystemPrompt,
  ctx.appendSystemContext,
].filter(Boolean).join("\n\n");

const userPrompt = [
  ctx.prependUserContext,
  userQuery,
].filter(Boolean).join("\n\n");
```

`prependUserContext` contains dynamic L1 recall snippets. `appendSystemContext` contains stable persona, scene navigation, and memory tool guidance. Keep them separate until the final platform-specific prompt assembly step.

### 4. Capture the completed turn

```ts
await memory.capture({
  userContent: userQuery,
  assistantContent: assistantAnswer,
  messages: transcriptMessages,
});
```

Capture after the assistant answer is complete. Do not capture partial streaming chunks as separate turns.

### 5. Expose optional search tools

```ts
const result = await memory.searchMemories("user deployment preference", 5);
const raw = await memory.searchConversations("exact phrase from last week", 5);
```

Use these for platform tool surfaces, workflow nodes, or backend debug endpoints.

### 6. Flush on session end

```ts
await memory.endSession();
```

Flush the current session when the host tells you a conversation has ended. Do not stop the Gateway for a single session; the Gateway may serve concurrent sessions.

## Existing SDK Adapters

### Codex

```ts
import { createCodexMemoryAdapter } from "@tencentdb-agent-memory/memory-tencentdb";

const memory = createCodexMemoryAdapter({
  userId,
  sessionId,
  workspaceDir,
});

const ctx = await memory.buildPromptContext(query);
await memory.recordTurn({ userContent: query, assistantContent: answer, messages });
```

### Dify

```ts
import { createDifyMemoryAdapter } from "@tencentdb-agent-memory/memory-tencentdb";

const memory = createDifyMemoryAdapter({
  appId,
  userId,
  conversationId,
  query,
});

const ctx = await memory.buildPromptContext();
await memory.recordDifyTurn({ query, answer, inputs });
```

Dify deployments vary across tools, workflow nodes, and backend extensions. Prefer `conversationId`; fall back to `workflowRunId` or `messageId` only when the conversation id is unavailable.

## Best Practices

- Namespace every `sessionKey` with the platform name.
- Keep `userId` stable across conversations for long-term personalization.
- Keep `sessionId` stable for one conversation, not one message.
- Inject `appendSystemContext` into the system/developer area and `prependUserContext` near the user query.
- Capture after the assistant turn finishes, not during streaming.
- Preserve raw platform metadata in `messages[].metadata` when available.
- Use Gateway auth when binding to anything beyond loopback.
- Treat recall failure as non-blocking; continue the platform turn without memory if the Gateway is temporarily unavailable.

## Common Pitfalls

| Pitfall | Impact | Fix |
| --- | --- | --- |
| Using a random `sessionKey` per request | Memory never accumulates in one conversation | Derive a deterministic key from platform, user, and conversation |
| Using one global `sessionKey` for all users | Cross-user memory contamination | Always include `userId` |
| Merging recall sections too early | Worse prompt cache behavior and less control per host | Keep `prependUserContext` and `appendSystemContext` separate |
| Capturing partial stream chunks | Fragmented L0 records and noisy L1 extraction | Capture once after the final answer |
| Calling `destroy()` / stopping Gateway on session end | Breaks other concurrent sessions | Call `endSession()` only |
| Calling pipeline internals from a platform adapter | Tight coupling and fragile upgrades | Use `MemoryPlatformAdapter` or Gateway APIs |

## Acceptance Checklist

- Core engine boundary is documented and not bypassed.
- OpenClaw, Hermes, Codex, and Dify integration styles are compared.
- New platforms implement `MemoryPlatformBridge` only.
- Recall, capture, search, and session flush are covered by examples.
- Session identity rules prevent cross-platform and cross-user collisions.
- Best practices and failure modes are documented.
- Adapter tests cover runtime derivation and Gateway payload mapping.
