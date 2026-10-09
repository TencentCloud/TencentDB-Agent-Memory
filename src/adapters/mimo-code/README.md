# MiMo Code Adapter

Gateway-backed memory plugin for [MiMo Code](https://github.com/XiaomiMiMo/MiMo-Code)
(OpenCode fork).

**Adapter lane:** coding-agent adapter  
**Depends on / complements:** the shared `GatewayMemoryClient` and
`createGatewayPlatformAdapter` shipped in this package  
**Related:** [#235](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/235)

This PR lane intentionally does **not** implement a second Gateway SDK, MCP
server, or Dify/workflow adapter. It only maps MiMo lifecycle hooks onto the
shared Gateway HTTP client.

MiMo Code already ships project memory (`MEMORY.md` / checkpoints). This adapter
adds TDAI's L0→L3 pipeline (recall / capture / search) **alongside** that system.

## Lifecycle Mapping

| MiMo / OpenCode-compatible hook | Behavior | Gateway |
| --- | --- | --- |
| `chat.message` | Recall and cache context for the current session | `POST /recall` |
| `experimental.chat.system.transform` | Inject transient, clearly labelled historical context | — |
| completed main-agent `session.post` | Capture the final turn; ignore subagents and failed outcomes | `POST /capture` |
| `session.deleted` / plugin `dispose` | Retry failed captures, then flush | `POST /session/end` |

Gateway failures are **fail-open** (logged, never block the user turn).
Recalled content is labelled as untrusted historical data: it cannot override
current system/user instructions, repository state, or tool authorization.

## Session key strategy

```text
mimo-code:<workspace-name>:<sha256(root)[0:12]>:<sessionID>
```

- `workspace-name` + path hash keep repositories isolated.
- OpenCode/MiMo `sessionID` keeps concurrent chats isolated.
- Override with `MEMORY_TENCENTDB_SESSION_KEY_PREFIX` when you need a fixed prefix.
- Optional `user_id` from `MEMORY_TENCENTDB_USER_ID` is forwarded on recall/capture/session end.

## Setup

1. Run TDAI Gateway (default `http://127.0.0.1:8420`).
2. Project-local plugin deps (MiMo inherits OpenCode-style plugin load):

```json
// .mimocode/package.json
{
  "dependencies": {
    "@tencentdb-agent-memory/memory-tencentdb": "latest"
  }
}
```

3. Plugin entry:

```ts
// .mimocode/plugins/memory-tencentdb.ts
import { createMimoCodeMemoryPlugin } from "@tencentdb-agent-memory/memory-tencentdb/adapters/mimo-code";

export const MemoryTencentDB = createMimoCodeMemoryPlugin();
```

If MiMo only auto-loads `.opencode/plugins/` in your build, use that path instead
(or both). Plugin hooks match the OpenCode plugin shape that MiMo forked.

## Auth (Gateway API key)

When the Gateway enables `server.apiKey` / `TDAI_GATEWAY_API_KEY`, every non-health
request must send `Authorization: Bearer <key>`.

Resolution order for this plugin:

1. `createMimoCodeMemoryPlugin({ apiKey })`
2. `MEMORY_TENCENTDB_GATEWAY_API_KEY` (plugin-side name, same as Hermes client)
3. `TDAI_GATEWAY_API_KEY` (shared env when Gateway + plugin share one file)

Unset key → no `Authorization` header (matches open localhost Gateway default).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEMORY_TENCENTDB_GATEWAY_URL` | `http://127.0.0.1:8420` | Gateway base URL |
| `MEMORY_TENCENTDB_GATEWAY_API_KEY` | unset | Bearer token (preferred client env) |
| `TDAI_GATEWAY_API_KEY` | unset | Bearer token fallback |
| `MEMORY_TENCENTDB_USER_ID` | unset | Optional request metadata (not isolation) |
| `MEMORY_TENCENTDB_SESSION_KEY_PREFIX` | `mimo-code:<workspace>` | Session key prefix |

```ts
export const MemoryTencentDB = createMimoCodeMemoryPlugin({
  gatewayUrl: "http://127.0.0.1:8420",
  apiKey: process.env.TDAI_GATEWAY_API_KEY,
  userId: process.env.USER,
  timeoutMs: 5_000,
  sessionEndTimeoutMs: 120_000,
});
```

Non-loopback Gateway URLs are rejected by default. For an intentional remote
deployment, use HTTPS, configure a Bearer token, and pass
`allowRemoteGateway: true` explicitly.

`userId` is request metadata, not a storage-isolation control. The current
Gateway keeps one persona and memory store per data directory. Run a separate
Gateway/data directory for each user or trust boundary; do not rely on
`MEMORY_TENCENTDB_USER_ID` to isolate users sharing one Gateway.

## Local verification

```bash
npm test -- --run src/adapters/gateway-client/gateway-client.test.ts src/adapters/mimo-code/mimo-code.test.ts
npm test
npm run build
npm run test:mimo-host
git diff --check
```

## Note on dual memory

TDAI injects transient system context; MiMo may also inject `MEMORY.md` /
checkpoint content. That is intentional (different layers). If noise is high,
raise Gateway thresholds or disable one side for experiments.
