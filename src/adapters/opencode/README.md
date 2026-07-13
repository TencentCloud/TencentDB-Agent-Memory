# OpenCode Adapter

The OpenCode adapter connects OpenCode's plugin lifecycle to the existing TDAI
Gateway adapter. It reuses `GatewayMemoryClient` and
`createGatewayPlatformAdapter`; it does not introduce a second client or memory
SDK.

## Lifecycle Mapping

| OpenCode hook/event | Adapter behavior | Gateway route |
| --- | --- | --- |
| `chat.message` | Recall memory and inject a synthetic, delimited text part | `POST /recall` |
| completed assistant `message.updated` | Pair by `parentID` and capture the complete turn | `POST /capture` |
| `message.part.updated` | Replace the latest text for each streamed part | none |
| `session.idle` / idle `session.status` | Retry capture if completion arrived before the final text part | none |
| `session.deleted` / plugin dispose | Capture any completed turn, then flush the session | `POST /session/end` |

Gateway failures are fail-open. They are reported through OpenCode's structured
`client.app.log()` API, but do not block the user's turn.

## Setup

Start the TDAI Gateway first. The default URL is `http://127.0.0.1:8420`.

Install this package where OpenCode can resolve local plugin dependencies. For
a project-local plugin, OpenCode installs dependencies declared in
`.opencode/package.json`:

```json
{
  "dependencies": {
    "@tencentdb-agent-memory/memory-tencentdb": "latest"
  }
}
```

Create `.opencode/plugins/memory-tencentdb.ts`:

```ts
import { createOpenCodeMemoryPlugin } from "@tencentdb-agent-memory/memory-tencentdb";

export const MemoryTencentDB = createOpenCodeMemoryPlugin();
```

OpenCode automatically loads JavaScript and TypeScript modules from the local
plugin directory at startup.

## Configuration

The adapter reads these environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEMORY_TENCENTDB_GATEWAY_URL` | `http://127.0.0.1:8420` | TDAI Gateway base URL |
| `MEMORY_TENCENTDB_GATEWAY_API_KEY` | unset | Bearer token for an authenticated Gateway |
| `MEMORY_TENCENTDB_USER_ID` | unset | Optional user isolation key |
| `MEMORY_TENCENTDB_SESSION_KEY_PREFIX` | workspace-derived | Optional stable prefix for OpenCode session keys |

The same values can be passed directly to `createOpenCodeMemoryPlugin()`.

```ts
export const MemoryTencentDB = createOpenCodeMemoryPlugin({
  gatewayUrl: "http://127.0.0.1:8420",
  apiKey: process.env.TDAI_GATEWAY_API_KEY,
  userId: process.env.USER,
  timeoutMs: 5_000,
});
```

Session keys include both a workspace identity and OpenCode's session id, so
different repositories and concurrent sessions do not share conversation
state. Assistant messages are matched to user turns through OpenCode's
`parentID`, avoiding cross-turn capture when more than one turn is pending.
