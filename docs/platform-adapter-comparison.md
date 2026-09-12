# Platform Adapter Comparison

This document defines the long-term adapter boundary for TencentDB Agent Memory.
New platforms should integrate through the platform SDK instead of calling
`TdaiCore` or pipeline internals directly.

Chinese version: [docs/platform-adapter-comparison.zh.md](./platform-adapter-comparison.zh.md)

Complete adapter guide: [docs/platform-adapter-guide.md](./platform-adapter-guide.md)

## Standard Adapter Boundary

Every new platform implements one interface:

```ts
interface MemoryPlatformBridge {
  getRuntime(): {
    platform: string;
    userId: string;
    sessionId: string;
    sessionKey: string;
    workspaceDir: string;
  };

  buildTurn?(turn: {
    userContent: string;
    assistantContent: string;
    messages?: unknown[];
  }): {
    userContent: string;
    assistantContent: string;
    messages?: unknown[];
  };
}
```

The SDK handles the rest:

- `MemoryGatewayClient`: HTTP transport to the TDAI Gateway.
- `MemoryPlatformAdapter`: recall, capture, search, session flush, seed.
- Platform adapters: thin bridge implementations for Codex, Dify, and future hosts.

The target shape is:

```text
Platform event model
  -> MemoryPlatformBridge
    -> MemoryPlatformAdapter
      -> MemoryGatewayClient
        -> TDAI Gateway
          -> TdaiCore
```

## Platform Differences

| Platform | Integration shape | Recall injection | Capture timing | Session identity | Recommended path |
| --- | --- | --- | --- | --- | --- |
| OpenClaw | In-process plugin | `before_prompt_build` returns `prependContext` / `appendSystemContext` | `agent_end` | Native `ctx.sessionKey` | Keep direct `OpenClawHostAdapter` path |
| Hermes | Python memory provider + Node Gateway sidecar | `prefetch(query)` returns memory context | `sync_turn()` background capture | Hermes `session_id` | Keep Gateway HTTP path |
| Codex | TypeScript SDK imported by host integration | `buildPromptContext(query)` returns user/system sections | `recordTurn()` after assistant output | `codex:<userId>:<sessionId>` | `CodexMemoryAdapter` |
| Dify | Tool / workflow / backend extension using SDK | `buildPromptContext(query)` can populate prompt variables | `recordDifyTurn()` after answer generation | `dify:<appId>:<userId>:<conversationId>` | `DifyMemoryAdapter` |

## What New Platforms Must Provide

A new platform only needs to answer four questions:

1. Who is the user?
2. What is the current conversation/session?
3. Where can recalled context be injected?
4. When is a completed user/assistant turn available for capture?

Everything else is shared:

- HTTP auth and timeout handling
- Gateway request/response mapping
- Recall split between dynamic user context and stable system context
- Capture payload normalization
- Memory and conversation search
- Session flush

## Runtime Field Rules

| Field | Meaning | Stability rule |
| --- | --- | --- |
| `platform` | Short platform key, for example `codex` or `dify` | Constant per adapter implementation |
| `userId` | End-user identity | Stable across sessions for the same user |
| `sessionId` | Platform conversation/thread/run id | Stable for one conversation |
| `sessionKey` | Memory isolation key | Deterministic and namespaced by platform |
| `workspaceDir` | Local workspace or data context | Best-effort; use `process.cwd()` if unavailable |

Session keys must be platform namespaced to avoid collisions:

```text
codex:<userId>:<sessionId>
dify:<appId>:<userId>:<conversationId>
claude-code:<userId>:<projectId>:<sessionId>
opencode:<userId>:<workspaceId>:<sessionId>
```

## Recall Contract

Gateway recall now returns both legacy and split fields:

```json
{
  "context": "...",
  "prepend_context": "...",
  "append_system_context": "..."
}
```

Adapters expose this as:

- `prependUserContext`: dynamic L1 snippets, injected near the current user query.
- `appendSystemContext`: stable persona / scene / tool guide, injected into system or developer context.

Do not merge these prematurely in the SDK. Different hosts have different prompt surfaces, and keeping the split preserves prompt-cache friendliness.

## Dify Notes

Dify deployments vary: some integrations run as a plugin/tool, some as workflow HTTP nodes, and some as a backend extension. The adapter therefore avoids depending on one Dify runtime package.

Use `DifyMemoryAdapter` with the request context you have:

```ts
const memory = createDifyMemoryAdapter({
  appId,
  userId,
  conversationId,
  query,
});

const ctx = await memory.buildPromptContext();
// Inject ctx.prependUserContext and ctx.appendSystemContext into Dify prompt variables.

await memory.recordDifyTurn({
  query,
  answer,
  inputs,
});
```

If a Dify deployment lacks `conversationId`, use `workflowRunId` or `messageId` as the session fallback. For long-term personalization quality, prefer a stable conversation id whenever possible.
