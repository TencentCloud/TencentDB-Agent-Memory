# Use TencentDB Agent Memory with Codex

Codex connects through the shared MCP adapter. The MCP adapter is the only layer that calls the existing Gateway.

| Codex event | MCP operation | Behavior |
|---|---|---|
| `UserPromptSubmit` | `tdai_memory_recall` | Adds recalled memory as `additionalContext` before the turn starts. |
| `Stop` | `tdai_memory_capture` | Stores the original prompt and final assistant response after the turn finishes. |

Codex does not currently expose a `SessionEnd` hook, so the Codex adapter does not call `tdai_session_end` automatically.

## Start the Gateway

Install dependencies and start the existing Gateway from the repository checkout:

```bash
npm install --ignore-scripts
node --import tsx src/gateway/server.ts
```

The Gateway listens on `http://127.0.0.1:8420` by default. The stdio MCP adapter connects to that address and exposes memory tools to Codex.

If the Gateway uses a Bearer token, export it before starting Codex:

```bash
export TDAI_GATEWAY_API_KEY="your-gateway-token"
```

The Hook and MCP templates invoke the `tsx` CLI from this repository's `node_modules`, so keep this checkout and its installed dependencies available.

## Configure the MCP server

Merge [`integrations/codex/config.toml.example`](../integrations/codex/config.toml.example) into `~/.codex/config.toml` or a trusted project's `.codex/config.toml`.

Replace `/absolute/path/to/TencentDB-Agent-Memory` with this repository's absolute path. The configuration starts `src/adapters/mcp/stdio.ts` as a standard stdio MCP server.

Verify it in Codex:

```text
/mcp
```

The `memory_tencentdb` server exposes:

- `tdai_memory_recall`
- `tdai_memory_capture`
- `tdai_session_end`
- `tdai_memory_search`
- `tdai_conversation_search`

The model can use the search tools when it needs more historical detail. Automatic recall and capture are still triggered by Codex lifecycle hooks.

## Configure the Codex hooks

Copy [`integrations/codex/hooks.json`](../integrations/codex/hooks.json) to either:

- `~/.codex/hooks.json` for all trusted projects.
- `<project>/.codex/hooks.json` for one trusted project.

Replace `/absolute/path/to/TencentDB-Agent-Memory` with this repository's absolute path. Start Codex and open `/hooks`; Codex requires you to review and trust new or changed command hooks before running them.

The adapters read these optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `TDAI_GATEWAY_URL` | `http://127.0.0.1:8420` | Gateway base URL used by the MCP adapter. |
| `TDAI_GATEWAY_API_KEY` | unset | Bearer token sent by the MCP adapter. |
| `TDAI_USER_ID` | unset | Optional Gateway `user_id`. |
| `TDAI_CODEX_STATE_DIR` | `~/.memory-tencentdb/codex-adapter` | Prompt and capture-deduplication state shared between Hook processes. |

The adapter stores only pending prompts and short-lived deduplication markers in this directory. Stale prompts and successful capture markers are removed after 24 hours. A capture claim left behind by a timed-out or terminated Hook is recoverable after at most 60 seconds.

## How failure handling works

The Codex adapter is fail-open:

- An MCP recall failure returns `{}` and lets Codex process the original prompt without memory context.
- An MCP capture failure is written to stderr and does not prevent Codex from stopping.
- The prompt remains available after a failed capture, so a later repeated `Stop` event can retry it.
- After capture succeeds, a local marker prevents the same `session_id` and `turn_id` from being captured again.
- Capture delivery is at-least-once and depends on Codex emitting a later repeated `Stop` event; the adapter does not run a background retry loop.
- If the Gateway accepts a capture but the Hook exits before writing the local success marker, a later `Stop` may send the turn again. Retries reuse stable message IDs, but the adapter does not guarantee end-to-end exactly-once capture.

Hook stdout contains only Codex-compatible JSON. MCP protocol messages use the separate stdio server process.

## Troubleshoot the integration

Check the Gateway first:

```bash
curl http://127.0.0.1:8420/health
```

Then check `/mcp` and `/hooks` inside Codex. To test the lifecycle Hook manually:

```bash
printf '%s' '{"hook_event_name":"UserPromptSubmit","session_id":"demo","turn_id":"turn-1","cwd":"/tmp","prompt":"Remember my preferred response style"}' \
  | node /absolute/path/to/TencentDB-Agent-Memory/node_modules/tsx/dist/cli.mjs \
      /absolute/path/to/TencentDB-Agent-Memory/src/adapters/codex/cli.ts
```

A healthy recall returns either `{}` when no memory matches or a JSON object containing `hookSpecificOutput.additionalContext`.

For MCP adapter details, see [the MCP adapter guide](mcp.md).