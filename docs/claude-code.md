# Use TencentDB Agent Memory with Claude Code

Claude Code uses two integrations backed by the same Gateway HTTP client. The stdio MCP server exposes model-facing tools, while lifecycle hooks call `MemoryTools` directly for deterministic automatic recall, capture, and session flushing. Hook traffic does not pass through the stdio MCP server.

| Claude Code event | MCP operation | Behavior |
|---|---|---|
| `UserPromptSubmit` | `tdai_memory_recall` | Recalls memory and injects it as `additionalContext` before the turn. |
| `Stop` | `tdai_memory_capture` | Captures the original prompt and final assistant message when the session has no background tasks or scheduled wakeups. |
| `SessionEnd` | `tdai_session_end` | Flushes work queued for the session. |

Use Claude Code `v2.1.196` or later. This version supplies `prompt_id`, which makes prompt-to-response mapping stable across independent Hook processes.

## Start the Gateway first

Install dependencies and start the existing Gateway from the repository checkout:

```bash
npm install --ignore-scripts
node --import tsx src/gateway/server.ts
```

The Gateway listens on `http://127.0.0.1:8420` by default. If it uses a Bearer token, export it before starting Claude Code:

```bash
export TDAI_GATEWAY_API_KEY="your-gateway-token"
```

## Add the lifecycle hooks

Merge [`integrations/claude-code/hooks.json`](../integrations/claude-code/hooks.json) into either `.claude/settings.json` for one project or `~/.claude/settings.json` for every project. Replace `/absolute/path/to/TencentDB-Agent-Memory` with the absolute path to this checkout.

The sample uses command-hook exec form, so paths containing spaces do not need shell quoting. Check the registered handlers in Claude Code with:

```text
/hooks
```

The `Stop` handler deliberately skips capture while `background_tasks` or `session_crons` are present. That prevents a pause while work is still in flight from being treated as a final response.

## Add the MCP server

Copy [`integrations/claude-code/mcp.json.example`](../integrations/claude-code/mcp.json.example) to the project root as `.mcp.json`, then replace the example repository path. Project-scoped MCP servers require workspace trust and approval before Claude Code connects to them.

You can also add the same server through the CLI:

```bash
claude mcp add --transport stdio --scope project memory_tencentdb -- \
  node /absolute/path/to/TencentDB-Agent-Memory/node_modules/tsx/dist/cli.mjs \
  /absolute/path/to/TencentDB-Agent-Memory/src/adapters/mcp/stdio.ts
```

Check the connection inside Claude Code:

```text
/mcp
```

The `memory_tencentdb` server exposes `tdai_memory_recall`, `tdai_memory_capture`, `tdai_session_end`, `tdai_memory_search`, and `tdai_conversation_search`. Models can use these tools for on-demand detail; lifecycle hooks provide automatic memory behavior without waiting for a model tool call.

## Configure the adapter with environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TDAI_GATEWAY_URL` | `http://127.0.0.1:8420` | Gateway base URL used by both lifecycle hooks and the MCP adapter. |
| `TDAI_GATEWAY_API_KEY` | unset | Bearer token sent to the Gateway. |
| `TDAI_CLAUDE_CODE_STATE_DIR` | `~/.memory-tencentdb/claude-code-adapter` | Pending prompts and capture-deduplication markers shared by Hook processes. |

One Gateway instance currently represents one memory namespace. User-level namespace isolation is not provided by these adapter environment variables.

The state directory contains only pending prompts and short-lived markers. Prompts and successful capture markers expire after 24 hours. A claim left by a killed Hook can be recovered after at most 60 seconds.

## Expect fail-open behavior

Gateway errors do not block Claude Code:

- Recall errors return `{}`, so Claude Code processes the original prompt without memory context.
- Capture and session-end errors are written to stderr, but Claude Code can still stop or exit.
- A failed capture keeps its prompt state, allowing a repeated `Stop` event to retry.
- A successful capture writes a local marker to prevent duplicate capture for the same `session_id` and `prompt_id`.

Delivery is at least once. If the Gateway accepts a capture but the Hook process exits before recording the local success marker, a later `Stop` can submit the turn again. Retries use stable message IDs so downstream storage can deduplicate them.

## Test a Hook manually

Run a recall event from the repository checkout:

```bash
printf '%s' '{"hook_event_name":"UserPromptSubmit","session_id":"demo","prompt_id":"prompt-1","cwd":"/tmp","prompt":"Remember my preferred response style"}' \
  | node node_modules/tsx/dist/cli.mjs src/adapters/claude-code/cli.ts
```

The output is `{}` when no memory matches, or a JSON object with `hookSpecificOutput.additionalContext` when recall succeeds. For runtime diagnostics, start Claude Code with `claude --debug-file /tmp/claude-hooks.log` and inspect `/hooks` and `/mcp`.

For shared MCP adapter details, see [the MCP adapter guide](mcp.md).