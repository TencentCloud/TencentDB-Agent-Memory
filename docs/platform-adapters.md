# Platform Adapter Guide

TencentDB-Agent-Memory keeps memory logic in `TdaiCore` and connects host
platforms through thin adapters. This guide summarizes the current patterns and
adds a Codex/CLI HTTP adapter path for new Agent hosts.

## Core Boundary

`TdaiCore` exposes four host-neutral operations:

- `handleBeforeRecall(query, sessionKey)` maps to a before-prompt recall hook.
- `handleTurnCommitted(turn)` maps to an after-turn capture hook.
- `searchMemories(params)` maps to an L1 structured-memory search tool.
- `searchConversations(params)` maps to an L0 raw-conversation search tool.

Each platform adapter is responsible for identity, lifecycle, and transport. It
should not reimplement L0/L1/L2/L3 memory logic.

## Existing Adapter Patterns

OpenClaw is an in-process adapter:

- `OpenClawHostAdapter` wraps `OpenClawPluginApi`.
- Hooks in `index.ts` call `TdaiCore` directly.
- LLM calls can use the OpenClaw embedded agent runtime.

Hermes is a sidecar adapter:

- The Python provider starts or discovers the Node Gateway.
- The provider calls `/recall`, `/capture`, `/search/*`, and `/session/end`.
- Gateway handlers call `TdaiCore` inside the Node process.

## Codex/CLI Adapter

`CodexMemoryAdapter` is a lightweight TypeScript client for Codex-like CLI
agents that can call the Gateway over HTTP. It provides:

- `recall(query)` for prompt-context injection.
- `captureTurn({ userText, assistantText, messages })` for after-turn writes.
- `searchMemories(...)` and `searchConversations(...)` for tool-style lookup.
- `endSession()` for shutdown or conversation flush.

Minimal usage:

```ts
import { CodexMemoryAdapter } from "@tencentdb-agent-memory/memory-tencentdb/src/adapters";

const memory = new CodexMemoryAdapter({
  gatewayUrl: "http://127.0.0.1:8420",
  apiKey: process.env.TDAI_GATEWAY_API_KEY,
  sessionKey: "codex:workspace:/repo/path",
  sessionId: "thread-123",
});

const context = await memory.buildPromptContext(userPrompt);

await memory.captureTurn({
  userText: userPrompt,
  assistantText,
  messages: [
    { role: "user", content: userPrompt },
    { role: "assistant", content: assistantText },
  ],
});
```

## Best Practices

- Use a stable `sessionKey` per workspace/thread family so recall can find past
  context after reconnects.
- Use a narrower `sessionId` for a single conversation stream when the host can
  distinguish it.
- Keep adapters thin: translate host events to Gateway or `TdaiCore` calls.
- Pass raw message arrays when the host has them; otherwise the adapter can
  still capture the user/assistant texts.
- Configure Gateway auth before exposing the port beyond loopback and pass the
  same bearer token through the adapter.
- Treat `/capture` as non-blocking from the host's perspective when possible;
  memory extraction may continue asynchronously after L0 capture.
