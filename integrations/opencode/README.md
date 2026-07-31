# TencentDB Agent Memory for OpenCode

This package is the complete OpenCode adapter for TencentDB Agent Memory. It combines OpenCode's native plugin lifecycle with the existing memory-tencentdb Gateway.

```text
OpenCode plugin -> Gateway HTTP API -> StandaloneHostAdapter -> TdaiCore -> L0/L1/L2/L3
```

The plugin never opens memory data files and never creates a second `TdaiCore`. The Gateway remains the only memory owner.

## Capabilities

- Automatic recall through `chat.message`.
- Automatic completed-turn capture through `session.idle`.
- Final capture and pipeline flush through `session.deleted` and plugin `dispose`.
- Synthetic-context filtering so recalled text is not captured as new user content.
- Idempotent capture across repeated idle events and plugin restarts.
- Seven explicit memory tools.
- Optional Gateway sidecar startup, health probing, bounded recovery, and owned-process shutdown.
- Bearer authentication, request timeouts, circuit breaking, bounded results, and non-fatal degradation.

## Installation

Add the adapter to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@tencentdb-agent-memory/memory-tencentdb-opencode"]
}
```

Plugin options may be supplied with OpenCode's tuple form. See `templates/opencode.example.json`.

For project-local development, install this package under `.opencode/package.json` and create `.opencode/plugins/memory-tencentdb.ts`:

```ts
export { MemoryTencentdbOpenCodePlugin } from "@tencentdb-agent-memory/memory-tencentdb-opencode";
```

Do not export the adapter twice through both a local wrapper and `opencode.json`; doing so registers duplicate hooks.

## Gateway configuration

The adapter controls only the client and optional sidecar lifecycle. Gateway memory, storage, and LLM settings continue to use the existing `TDAI_*` environment variables or `tdai-gateway.yaml`.

| Adapter variable                               | Default                                    | Purpose                                 |
| ---------------------------------------------- | ------------------------------------------ | --------------------------------------- |
| `MEMORY_TENCENTDB_OPENCODE_GATEWAY_URL`        | `http://127.0.0.1:8420`                    | Gateway base URL                        |
| `MEMORY_TENCENTDB_OPENCODE_GATEWAY_CMD`        | auto-discovery                             | Explicit Gateway command                |
| `MEMORY_TENCENTDB_OPENCODE_GATEWAY_API_KEY`    | `TDAI_GATEWAY_API_KEY`                     | Client Bearer token                     |
| `MEMORY_TENCENTDB_OPENCODE_REQUEST_TIMEOUT_MS` | `10000`                                    | Business request timeout                |
| `MEMORY_TENCENTDB_OPENCODE_STARTUP_TIMEOUT_MS` | `30000`                                    | Sidecar health wait                     |
| `MEMORY_TENCENTDB_OPENCODE_ENABLE_SUPERVISOR`  | `false`                                    | Allow sidecar startup (explicit opt-in) |
| `MEMORY_TENCENTDB_OPENCODE_SESSION_KEY`        | derived                                    | Fixed memory session key                |
| `MEMORY_TENCENTDB_OPENCODE_USER_ID`            | `default_user`                             | Default memory user                     |
| `MEMORY_TENCENTDB_OPENCODE_LOG_DIR`            | `~/.config/opencode/logs/memory_tencentdb` | Sidecar logs and capture state          |
| `MEMORY_TENCENTDB_OPENCODE_RESULT_MAX_CHARS`   | `12000`                                    | Maximum injected/tool text              |

Equivalent camelCase plugin options are `gatewayUrl`, `gatewayCommand`, `gatewayApiKey`, `requestTimeoutMs`, `startupTimeoutMs`, `enableSupervisor`, `sessionKey`, `userId`, `logDir`, and `resultMaxChars`. Plugin options take precedence over adapter environment variables.

If Gateway authentication is enabled, configure the same secret independently on both sides:

```text
TDAI_GATEWAY_API_KEY=<gateway-side secret>
MEMORY_TENCENTDB_OPENCODE_GATEWAY_API_KEY=<client-side secret>
```

The supervisor deliberately does not copy its client token into a child process. Enabling Gateway authentication remains an operator decision.

## Automatic lifecycle

### Recall

For each non-empty `chat.message`, the adapter calls `POST /recall` and appends returned context as a synthetic text part. The context is delimited and explicitly described as untrusted historical context rather than a new instruction.

Recall failures leave the user message unchanged.

### Capture

When a session becomes idle, the adapter reads session messages and captures newly completed user/assistant turns. It excludes:

- synthetic or ignored text;
- recalled memory blocks;
- reasoning and tool parts;
- summaries and synthetic continuation messages;
- failed or incomplete assistant messages;
- turns that predate this plugin process.

An assistant message ID is marked captured only after Gateway acceptance and is persisted atomically under the configured log directory. Repeated idle events and plugin restarts therefore do not duplicate successful captures, while a failed capture remains retryable.

### Session end

`session.deleted` performs a final capture scan and calls `POST /session/end`. During `dispose`, the adapter waits for bounded in-flight work, flushes observed sessions, and terminates only a Gateway child it created. A Gateway that was already healthy is treated as external and is never stopped.

## Tools

- `agent_memory_health`
- `agent_memory_recall`
- `agent_memory_capture`
- `agent_memory_search`
- `agent_conversation_search`
- `agent_memory_session_end`
- `agent_memory_seed`

Tool field names align with the Gateway contract. Tool failures return a readable unavailable result so OpenCode can continue its main task.

## Degraded mode

Five consecutive Gateway failures open the circuit breaker for 60 seconds. Recovery attempts are throttled to avoid repeatedly blocking OpenCode while the sidecar is down. Successful health or business requests reset the breaker.

Inspect `gateway.stdout.log` and `gateway.stderr.log` under the configured log directory when sidecar startup fails.

## Development

From the repository root:

```bash
npm run build:opencode
npx tsc -p integrations/opencode/tsconfig.json
npx vitest run integrations/opencode/tests
```

To inspect the standalone package:

```bash
npm pack --dry-run --prefix integrations/opencode
```
