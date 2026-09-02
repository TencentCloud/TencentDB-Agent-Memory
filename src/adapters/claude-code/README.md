# Claude Code Adapter

This adapter connects Claude Code to TencentDB-Agent-Memory through the existing Gateway.

Current scope:

- Gateway client for the existing HTTP API.
- Stable Claude Code session key derivation.
- `UserPromptSubmit` recall hook.
- `SessionEnd` transcript import through `/seed` and `/session/end`.
- `PostToolUse` short-term refs/jsonl/mmd symbolic canvas capture.
- MCP search tool handlers and a minimal stdio server.

Not included yet:

- Gateway process supervision.
- Production packaging/setup beyond development `tsx` invocation.

## Environment

```bash
MEMORY_TENCENTDB_GATEWAY_URL=http://127.0.0.1:8420
MEMORY_TENCENTDB_GATEWAY_API_KEY=
MEMORY_TENCENTDB_AUTO_RECALL=true
MEMORY_TENCENTDB_SHORT_TERM=true
MEMORY_TENCENTDB_RECALL_MAX_CHARS=4000
MEMORY_TENCENTDB_CANVAS_MAX_CHARS=3000
```

`MEMORY_TENCENTDB_GATEWAY_API_KEY` can be omitted when the Gateway is running without auth on loopback. If the Gateway uses `TDAI_GATEWAY_API_KEY`, the adapter also accepts that variable as a fallback.

## UserPromptSubmit Recall Hook

Development invocation:

```bash
npx tsx src/adapters/claude-code/hooks/user-prompt-submit.ts
```

The hook reads Claude Code hook JSON from stdin and writes a JSON response. On success it returns:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "<tencentdb-agent-memory>...</tencentdb-agent-memory>"
  }
}
```

The hook calls:

```text
POST /recall { query, session_key, user_id? }
```

If short-term memory is enabled, it also reads the active Mermaid canvas and includes it in `additionalContext`.

## SessionEnd Capture Hook

Development invocation:

```bash
npx tsx src/adapters/claude-code/hooks/session-end.ts
```

The hook reads Claude Code `SessionEnd` JSON from stdin. It expects `session_id`, `cwd`, and `transcript_path` when available.

It imports parsed transcript turns through:

```text
POST /seed { data, session_key, strict_round_role:false, auto_fill_timestamps:true }
POST /session/end { session_key }
```

Transcript import is conservative: it keeps user/assistant text pairs and skips tool-only blocks such as `tool_result` and `tool_use`.

## PostToolUse Short-term Canvas Hook

Development invocation:

```bash
npx tsx src/adapters/claude-code/hooks/post-tool-use.ts
```

The hook reads Claude Code `PostToolUse` JSON from stdin. It captures high-signal tool events and writes:

```text
~/.memory-tencentdb/claude-code-offload/
  <workspace_hash>/
    refs/<tool_use_id>.md
    offload-<session_id>.jsonl
    mmds/<session_id>.mmd
    state.json
```

Default capture policy:

- capture failed tools;
- capture shell/edit/write/patch tools;
- capture very large outputs;
- skip ordinary read/list/search tools unless they are large or failed.


### Windows hook command note

Claude Code runs hook commands through the platform shell. On Windows, prefer PowerShell-native environment assignment:

```powershell
$env:MEMORY_TENCENTDB_CLAUDE_STORAGE_DIR = 'C:\tmp\tdai-claude-runtime-smoke'; npx tsx src/adapters/claude-code/hooks/post-tool-use.ts
```

Avoid relying on `cmd /c set VAR=...&& ...` inside the hook command, because it can be parsed as PowerShell and fail before the adapter receives the hook payload.
## MCP Tools

Development invocation:

```bash
npx tsx src/adapters/claude-code/mcp/server.ts
```

Exposed tools:

- `memory_tencentdb_memory_search`
- `memory_tencentdb_conversation_search`

They map directly to:

- `POST /search/memories`
- `POST /search/conversations`

## Smoke Test

1. Start the TencentDB-Agent-Memory Gateway on `127.0.0.1:8420`.
2. Run the targeted tests:

   ```bash
   npm test -- --run src/adapters/claude-code
   ```

3. Feed sample hook payloads to `user-prompt-submit.ts`, `post-tool-use.ts`, or `session-end.ts` through stdin.

## Next Slices

Recommended order:

1. Run a real Claude Code hook smoke test with project-scoped settings.
2. Package the adapter as a documented Claude Code setup bundle.

