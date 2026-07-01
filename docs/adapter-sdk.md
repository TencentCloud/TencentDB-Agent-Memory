# Adapter SDK

The adapter SDK lets a new Agent platform connect to TencentDB Agent Memory by implementing one interface: `MemoryPlatformAdapter`.

The SDK is Gateway-backed. Platform code provides session identity and turn text; the SDK handles HTTP calls to `/recall`, `/capture`, `/search/memories`, and `/search/conversations`.

## Architecture

```mermaid
flowchart LR
  Platform["New Agent platform"] --> OneInterface["MemoryPlatformAdapter"]
  OneInterface --> SDK["MemoryAdapterRuntime"]
  SDK --> Gateway["TencentDB Agent Memory Gateway"]
  Gateway --> Core["TdaiCore"]
  Core --> Store["SQLite / TencentDB VectorDB"]
```

## Install / Import

```ts
import { createMemoryAdapter, type MemoryPlatformAdapter } from "@tencentdb-agent-memory/memory-tencentdb/adapter-sdk";
```

## Implement one interface

```ts
interface MyTurn {
  user: string;
  assistant: string;
  messages?: unknown[];
}

const platform: MemoryPlatformAdapter<MyTurn> = {
  async getSession() {
    return {
      platform: "my-agent-platform",
      sessionKey: "my-agent:workspace-123:thread-456",
      sessionId: "thread-456",
      userId: "user-123",
      workspaceDir: process.cwd(),
    };
  },

  getUserText(turn) {
    return turn.user;
  },

  getAssistantText(turn) {
    return turn.assistant;
  },

  getMessages(turn) {
    return turn.messages;
  },
};
```

## Use the runtime

```ts
const memory = createMemoryAdapter(platform, {
  gatewayUrl: process.env.TDAI_GATEWAY_URL ?? "http://127.0.0.1:8420",
  apiKey: process.env.TDAI_GATEWAY_API_KEY,
});

// Before a model turn: retrieve memory context.
const recall = await memory.recallForTurn({
  user: "How should I format release notes?",
  assistant: "",
});

// Inject or display recall.context according to the host platform's hook model.
console.log(recall.context);

// After a successful model turn: capture the completed exchange.
await memory.captureTurn({
  user: "How should I format release notes?",
  assistant: "Use concise bullet points grouped by feature area.",
});
```

## Manual search helpers

```ts
const memories = await memory.searchMemories({
  query: "release note preferences",
  limit: 5,
});

const conversations = await memory.searchConversations({
  query: "release notes",
  limit: 5,
});
```

## Session key guidance

A good `sessionKey` should be stable for a conversation but scoped enough to avoid mixing unrelated users or projects:

```text
<platform>:<workspace-or-project-id>:<thread-or-conversation-id>
```

Examples:

- `codex:repo-sha256:thread-id`
- `claude-code:workspace-id:chat-id`
- `dify:app-id:conversation-id`

## Gateway requirements

Start the Gateway before using the SDK:

```bash
npx tsx src/gateway/server.ts
```

The SDK reads these environment variables by default:

```bash
TDAI_GATEWAY_URL=http://127.0.0.1:8420
TDAI_GATEWAY_API_KEY=<optional-shared-secret>
```

## What the SDK does not assume

The SDK does not assume a platform-specific hook system. Each platform decides where to call:

- `recallForTurn()` before prompt construction or before sending to the model.
- `captureTurn()` after a successful assistant response.
- `searchMemories()` / `searchConversations()` as tools, commands, or diagnostics.

This keeps platform integration limited to lifecycle wiring while memory semantics remain centralized in `TdaiCore`.

## Short-Term Context Compaction

For platforms that do not expose OpenClaw's native `contextEngine` slot, the SDK provides a portable short-term compaction helper:

```ts
const compacted = memory.compactContext({
  messages,
  targetTokens: 8_000,
  systemPrompt,
  prompt: latestUserPrompt,
});
```

This helper provides portable emergency-style context compression and is suitable for Codex-style wrappers that need to shrink a long local message list before sending it to the model.

Scope note:

- `compactContext()` covers portable short-term context compression.
- OpenClaw-specific Mermaid canvas/offload hooks still require OpenClaw's `contextEngine`, `after_tool_call`, and prompt-build lifecycle.
- A Codex native integration can use `compactContext()` immediately, and can add deeper Mermaid/tool-log offload later if Codex exposes equivalent fine-grained tool-call hooks.
