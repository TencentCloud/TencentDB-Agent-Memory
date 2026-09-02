# Claude Code Gateway Adapter

This adapter is a thin Claude Code hook helper built on the shared
`GatewayMemoryClient` and `createGatewayPlatformAdapter()` seam.

It does not introduce a second SDK, storage layer, or Gateway abstraction. The
only platform-specific responsibilities are:

- derive a stable TDAI `sessionKey` from the Claude Code workspace and
  conversation identity
- call Gateway recall before prompt construction
- call Gateway capture after a completed assistant turn
- forward memory and conversation search requests to the Gateway
- flush delayed work when the host session ends

## Minimal Usage

```ts
import {
  GatewayMemoryClient,
  createClaudeCodeContextFromHookInput,
  createClaudeCodeGatewayAdapter,
} from "@tencentdb-agent-memory/memory-tencentdb";

const hookInput = JSON.parse(await readStdin());

const client = new GatewayMemoryClient({
  baseUrl: process.env.MEMORY_TENCENTDB_GATEWAY_URL ?? "http://127.0.0.1:8420",
  apiKey: process.env.MEMORY_TENCENTDB_GATEWAY_API_KEY,
});

const memory = createClaudeCodeGatewayAdapter({
  client,
  resolveContext: () => createClaudeCodeContextFromHookInput(hookInput, {
    userId: process.env.USER ?? "default_user",
  }),
});

const recall = await memory.prefetchForPrompt(userPrompt);
const promptWithMemory = `${recall.context}\n\n${userPrompt}`;

await memory.captureCompletedTurn({
  userText: userPrompt,
  assistantText: assistantResponse,
  messages,
});

await memory.flushSession();
```

`readStdin()` is host wiring, not part of this adapter. The adapter only needs
the Claude Code hook fields `session_id` and `cwd`.

## Session Identity

Prefer a host conversation or thread id when one is available. If the hook
runner only provides a per-invocation session id, pass it as `sessionId`. The
fallback session key format is:

```text
claude-code:<normalized-workspace-dir>:<conversation-or-session-id>
```

Callers that already have a stable TDAI key can pass `sessionKey` directly.

## Scope

This helper intentionally stays smaller than a platform SDK. If a future PR adds
Claude Code installer scripts, MCP server support, or prompt-file wiring, those
should build on this adapter rather than duplicating the Gateway client.
