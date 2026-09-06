# Use TencentDB Agent Memory with Claude Code

Claude Code uses two integrations backed by the same Gateway HTTP client. The stdio MCP server exposes model-facing tools, while lifecycle hooks call `MemoryTools` directly for deterministic automatic recall, capture, and session flushing. Hook traffic does not pass through the stdio MCP server.

| Claude Code event | MCP operation | Behavior |
|---|---|---|
| `UserPromptSubmit` | `tdai_memory_recall` | Recalls memory and injects it as `additionalContext` before the turn. |
| `Stop` | `tdai_memory_capture` | Captures the finished turn when the session has no background tasks or scheduled wakeups: the whole turn from the transcript (prompt, tool calls, tool results, intermediate text, final message), or the prompt and final assistant message alone when no transcript is available. |
| `SessionEnd` | `tdai_memory_capture`, then `tdai_session_end` | Sends whatever transcript remains unsent (a turn whose Stop was skipped or did not fully land), then flushes work queued for the session. |

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

### Transcript capture

The hook payload names the session transcript in `transcript_path` (fallback: `<config dir>/projects/<cwd with non-alphanumerics as "-">/<session_id>.jsonl`). Both `Stop` and `SessionEnd` read it and send the entries after a per-session marker as L0 messages, so tool calls, tool results and intermediate assistant text reach memory, not only the prompt and the final reply:

- At `Stop` the delta is the finished turn, sent as one capture whose `user_content` and `assistant_content` are the prompt and the final message. Per-turn sending keeps each Stop small: a Gateway batch of 100 messages takes several seconds, and a session's `SessionEnd` fires once, so sending everything at the end would lose the tail of a long session.
- At `SessionEnd` the delta is whatever is still unsent, for example a turn whose Stop was skipped because background tasks were running.
- Thinking blocks and images are dropped. A tool call becomes assistant text `[tool_use id=… name=… input=…]` (input quoted up to 2000 characters); a tool result becomes user text `[tool_result tool_use_id=…] …` (up to 4000 characters). Messages longer than 8192 characters are chunked; batches hold at most 100 messages.
- Credential-shaped substrings (private keys, bearer tokens, `sk-…` keys, GitHub, GitLab, Slack, AWS, Google and npm tokens, `password=…` style values) are replaced by `[redacted:<kind>]` before anything is sent. Tool traffic routinely carries env dumps and config files; shared memory must not.
- A turn the plain prompt-plus-final path captured (no transcript available at the time) contributes only its tool traffic later, so nothing lands twice. The Gateway records what it is sent and does not deduplicate by message id.
- The marker records the last transcript entry sent. A batch that fails leaves it at the last batch that landed; a turn whose delta did not fully land stays unclaimed, so `SessionEnd` sends the rest. A resumed session that ends again sends only what is new.
- Budgets: `TDAI_CLAUDE_CODE_STOP_BUDGET_MS` (default 3500) at Stop and `TDAI_CLAUDE_CODE_TRANSCRIPT_BUDGET_MS` (default 25000) at SessionEnd. A budget only stops new batches from starting; a batch in flight runs to its own Gateway timeout, `TDAI_CLAUDE_CODE_TRANSCRIPT_TIMEOUT_MS` (default 15000). Hook timeouts must cover a batch in flight, or the marker is never written for a batch the Gateway did record: the sample uses 15 seconds for `Stop` and 30 for `SessionEnd`.
- Set `TDAI_CLAUDE_CODE_TRANSCRIPT_CAPTURE=off` to keep the old behaviour: prompt and final message at Stop, flush only at SessionEnd.

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

The `memory_tencentdb` server exposes `tdai_memory_recall`, `tdai_memory_capture`, `tdai_session_end`, `tdai_memory_search`, and `tdai_conversation_search` for the Gateway, plus `tdai_wiki_list`, `tdai_wiki_search`, `tdai_wiki_pages`, `tdai_wiki_read`, and `tdai_wiki_write` for the Knowledge Service (team wikis). Models can use these tools for on-demand detail; lifecycle hooks provide automatic memory behavior without waiting for a model tool call. Tell the model which wiki id to use in your project instructions, for example `CLAUDE.md`; the adapter never assumes one.

## Configure the adapter with environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TDAI_GATEWAY_URL` | `http://127.0.0.1:8420` | Gateway base URL used by both lifecycle hooks and the MCP adapter. |
| `TDAI_GATEWAY_API_KEY` | unset | Bearer token sent to the Gateway. |
| `TDAI_CLAUDE_CODE_STATE_DIR` | `~/.memory-tencentdb/claude-code-adapter` | Pending prompts and capture-deduplication markers shared by Hook processes. |
| `TDAI_CLAUDE_CODE_TRANSCRIPT_CAPTURE` | `on` | Set `off` to skip transcript capture at Stop and SessionEnd. |
| `TDAI_CLAUDE_CODE_STOP_BUDGET_MS` | `3500` | Wall-clock budget for the turn's transcript batches at Stop. |
| `TDAI_CLAUDE_CODE_TRANSCRIPT_BUDGET_MS` | `25000` | Wall-clock budget for the remaining transcript batches at SessionEnd. |
| `TDAI_CLAUDE_CODE_TRANSCRIPT_TIMEOUT_MS` | `15000` | Gateway timeout for one transcript batch (recall and per-turn capture keep the 3-second default). |
| `TDAI_KNOWLEDGE_URL` | `http://127.0.0.1:8424` | Knowledge Service base URL used by the wiki tools (MCP adapter only). |
| `TDAI_SERVICE_ID`, `TDAI_TEAM_ID`, `TDAI_USER_ID`, `TDAI_AGENT_ID` | see [the MCP adapter guide](mcp.md) | Service and tenant identity for the wiki tools. |

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