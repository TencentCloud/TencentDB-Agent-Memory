# Use TencentDB Agent Memory with OpenCode

OpenCode uses two complementary integration paths:

- The OpenCode plugin handles automatic recall, context injection, capture, and session flushing.
- The shared stdio MCP server gives the model on-demand memory search and capture tools.

Both paths reuse the same `MemoryTools` implementation and connect to the same Gateway. The MCP server is the model-facing stdio transport; the plugin calls `MemoryTools` directly for deterministic lifecycle behavior.

| OpenCode lifecycle point | Memory operation | Behavior |
|---|---|---|
| `chat.message` | `tdai_memory_recall` | Recalls memory for the current user message. |
| `experimental.chat.system.transform` | Context injection | Adds recalled memory to the system context once without changing the user message or transcript. |
| `session.status` with `idle`, or legacy `session.idle` | `tdai_memory_capture` | Captures the latest complete user/assistant turn. |
| `session.deleted` | `tdai_session_end` | Flushes work queued for the session. |

## Install the package and start the Gateway

Install the package where OpenCode can resolve npm plugins:

```bash
npm install @tencentdb-agent-memory/memory-tencentdb
```

Start the existing Gateway from a TencentDB Agent Memory checkout or deployment:

```bash
node --import tsx src/gateway/server.ts
```

The Gateway listens on `http://127.0.0.1:8420` by default. Export any non-default connection settings before starting OpenCode:

```bash
export TDAI_GATEWAY_URL="http://127.0.0.1:8420"
export TDAI_GATEWAY_API_KEY="your-gateway-token"
export TDAI_USER_ID="your-user-id"
```

## Configure the plugin and MCP server

Merge [`integrations/opencode/opencode.json.example`](../integrations/opencode/opencode.json.example) into one of these locations:

- `opencode.json` in a project for project-specific configuration.
- `~/.config/opencode/opencode.json` for all projects.

The `plugin` entry loads `@tencentdb-agent-memory/memory-tencentdb`. OpenCode resolves the package's `./server` export to the plugin build. The `memory_tencentdb` MCP entry uses `npx --package` to resolve and start the packaged `memory-tencentdb-mcp` command without relying on the current shell's `PATH`. The separate `./opencode` export remains available for direct Node imports, but it is not the value to put in OpenCode's `plugin` array.

OpenCode replaces an unset `{env:VARIABLE}` reference with an empty string. Remove environment entries you do not use, especially `TDAI_GATEWAY_API_KEY` and `TDAI_USER_ID`.

Check the MCP connection with:

```bash
opencode mcp list
```

The server exposes `tdai_memory_recall`, `tdai_memory_capture`, `tdai_session_end`, `tdai_memory_search`, and `tdai_conversation_search`. These tools are available for model-initiated work; the plugin provides automatic memory behavior without waiting for a model tool call.

## Configure adapter state

| Variable | Default | Purpose |
|---|---|---|
| `TDAI_GATEWAY_URL` | `http://127.0.0.1:8420` | Gateway base URL. |
| `TDAI_GATEWAY_API_KEY` | unset | Bearer token sent to the Gateway. |
| `TDAI_USER_ID` | unset | Optional Gateway `user_id`. |
| `TDAI_OPENCODE_STATE_DIR` | `~/.memory-tencentdb/opencode-adapter` | Recall, injection, error, and capture-deduplication state. |

The state directory uses short-lived files with mode `0600`. Pending state and successful markers expire after 24 hours. Claims left by a stopped process can be recovered after at most 60 seconds.

## How automatic capture selects a turn

When a session becomes idle, the plugin reads the session message history through the OpenCode client. It captures only the latest assistant message when all of these conditions are true:

- The assistant message has a completion timestamp.
- The assistant message has no error.
- It contains non-empty visible text.
- Its `parentID` identifies a user message with non-empty visible text.

The plugin does not capture reasoning, tool output, synthetic text, ignored text, aborted answers, or incomplete answers. If the latest assistant message is incomplete, it does not fall back to an older turn.

## Expect fail-open behavior

Gateway, OpenCode client, and local state errors do not block OpenCode:

- Recall errors leave the original prompt unchanged.
- Injection errors leave the normal system prompt unchanged.
- Capture errors release the local claim so a later idle event can retry.
- Session-end errors are logged, but session deletion continues.
- Repeated message, transform, and idle events are deduplicated through persistent state.

Capture delivery is at least once. If the Gateway accepts a capture but the process exits before the local marker is written, a later idle event can submit the turn again. Stable message IDs let downstream storage deduplicate retries.

## Account for the experimental injection hook

OpenCode currently exposes system-context injection through the legacy `experimental.chat.system.transform` hook. The plugin also supports the current `session.status` idle event and the deprecated `session.idle` event.

Record the OpenCode version used in production smoke tests. A future OpenCode V2 plugin migration will require a stable replacement for system-context injection.

For shared MCP adapter details, see [the MCP adapter guide](mcp.md).