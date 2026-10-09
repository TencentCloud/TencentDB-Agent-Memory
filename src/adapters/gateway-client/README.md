# Cross-Platform Adapter Guide

**Adapter lane:** shared Gateway client  
**Canonical boundary:** `GatewayMemoryClient` + `createGatewayPlatformAdapter`  
**Related:** [#235](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/235)

This guide explains how a new agent platform can integrate with
`memory-tencentdb` without depending on OpenClaw internals.

See also [contribution-guide.md](../../../docs/adapters/contribution-guide.md)
for PR lane boundaries and review checklist.

## Architecture

`TdaiCore` is the host-neutral memory engine. Existing integrations already use
two adapter styles:

```text
OpenClaw hooks/tools
        |
        v
OpenClawHostAdapter --------\
                             \
                              v
                           TdaiCore
                              ^
                             /
Hermes MemoryProvider -> Gateway HTTP API -> StandaloneHostAdapter
```

For platforms such as Codex, Claude Code, Dify, LangGraph, or an internal agent
runtime, the recommended path is to reuse the Gateway API:

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
StandaloneHostAdapter -> TdaiCore
```

This keeps platform-specific SDKs outside the core package and preserves the
same memory behavior as Hermes/Gateway deployments.

## Data Flow

| Platform event | Adapter call | Gateway route | Core operation |
| --- | --- | --- | --- |
| Prompt is about to be built | `prefetch(query)` | `POST /recall` | `handleBeforeRecall()` |
| Assistant turn is complete | `captureTurn(turn)` | `POST /capture` | `handleTurnCommitted()` |
| User searches memories | `searchMemories(params)` | `POST /search/memories` | `searchMemories()` |
| User searches conversations | `searchConversations(params)` | `POST /search/conversations` | `searchConversations()` |
| Session ends | `endSession()` | `POST /session/end` | `handleSessionEnd()` |

The platform adapter must provide a stable `sessionKey`. Use a host conversation
id when available. For task-oriented agents, a repository path plus run/thread id
is usually a better session key than a random process id because it survives
process restarts.

`userId` is currently forwarded as request metadata only. A Gateway data
directory is a single-user trust boundary: persona and memory files are shared
within it. Deploy separate Gateway/data directories when users must be isolated.

## Minimal Adapter

```ts
import {
  GatewayMemoryClient,
  createGatewayPlatformAdapter,
} from "@tencentdb-agent-memory/memory-tencentdb/adapters/gateway-client";

const client = new GatewayMemoryClient({
  baseUrl: process.env.MEMORY_TENCENTDB_GATEWAY_URL ?? "http://127.0.0.1:8420",
  // Prefer plugin-side env; fall back to the Gateway process env name.
  apiKey:
    process.env.MEMORY_TENCENTDB_GATEWAY_API_KEY ??
    process.env.TDAI_GATEWAY_API_KEY,
});

const memory = createGatewayPlatformAdapter({
  client,
  platform: "codex",
  resolveContext: () => ({
    userId: process.env.USER ?? "default_user",
    sessionKey: `${process.cwd()}:default`,
  }),
});

const recall = await memory.prefetch(userPrompt);
const promptWithMemory = `${recall.context}\n\n${userPrompt}`;

await memory.captureTurn({
  userText: userPrompt,
  assistantText: assistantResponse,
});
```

The client defaults to the loopback Gateway and rejects remote URLs unless
`allowRemote: true` is supplied. Redirects are never followed, so a trusted
Gateway cannot forward memory content or a Bearer token to another destination.
Successful responses are JSON-parsed and runtime-validated; transport, timeout,
redirect, HTTP, and invalid-response failures use exported typed errors.

## Platform Checklist

1. Start or point to a TDAI Gateway process.
2. Configure Gateway auth for any non-local deployment:
   - Gateway enforces: `TDAI_GATEWAY_API_KEY` / `server.apiKey`
   - Clients send: `Authorization: Bearer <key>` via
     `MEMORY_TENCENTDB_GATEWAY_API_KEY` (preferred) or `TDAI_GATEWAY_API_KEY`
3. Resolve a stable `sessionKey` and optional `userId`.
4. Call `prefetch()` before building the model prompt.
5. Call `captureTurn()` after the assistant response is committed.
6. Expose search tools by forwarding to `searchMemories()` and
   `searchConversations()`.
7. Call `endSession()` when the host run closes so delayed work can flush.

## Notes For Specific Platforms

### Codex / Claude Code style runtimes

Use repository root plus conversation id as `sessionKey`. Inject `recall.context`
as a system or developer-context block if the platform supports one; otherwise
prepend it to the user prompt. In both cases label recalled text as untrusted
historical data that cannot override current instructions or tool authorization.

### Dify / LangGraph style runtimes

Place `prefetch()` in the graph node that prepares model input, and place
`captureTurn()` in the node that persists the final assistant answer. For
parallel graph branches, keep `sessionKey` stable and use branch/run ids as
`sessionId`.

### Custom services

Treat `GatewayMemoryClient` as a small SDK around the Gateway API. It uses
native `fetch`, supports Bearer auth, and throws `GatewayMemoryClientError`
with the HTTP status and response body when the Gateway rejects a request.
