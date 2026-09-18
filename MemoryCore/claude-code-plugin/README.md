# Claude Code Adapter for TencentDB Agent Memory (v3, native)

[简体中文](./README_CN.md) · English

This directory is the **Claude Code client adapter** for Memory Gateway **`/v3/*`**. Like the [OpenClaw client adapter](../openclaw-plugin/), it is a pure client: it runs no extraction, indexing, scene or persona generation, and it does **not** route Claude Code's model traffic through a proxy. Claude Code keeps talking to Anthropic directly; memory is added through Claude Code's own lifecycle hooks and a stdio MCP server, both backed by the npm TypeScript SDK.

| Item | Value |
|------|-------|
| Host | Claude Code `v2.1.196+` (supplies `prompt_id` and `transcript_path` in hook payloads) |
| SDK | [`@tencentdb-agent-memory/memory-sdk-ts-v2`](https://www.npmjs.com/package/@tencentdb-agent-memory/memory-sdk-ts-v2) (`V3MemoryClient` → `/v3/*` with `teamId` / `agentId` / `userId` isolation) |
| Hooks | `UserPromptSubmit` recall · `Stop` per-turn capture · `SessionEnd` remainder capture |
| MCP tools | `tdai_memory_search`, `tdai_conversation_search`, `tdai_scenario_read`, `tdai_memory_capture`, and `tdai_wiki_*` when a Knowledge Service is configured |
| Not included | Proxy routing, Offload, COS file read |

When to choose this over the [proxy route](../../agents/claude-code/): you want memory without moving Claude Code's model traffic, key, or billing to the proxy. When to choose the proxy: you want zero-code setup and server-side injection, and routing through the proxy is acceptable.

## Architecture

```text
Claude Code
  ├─ hooks (one process per event; ~/.claude/settings.json)
  │    UserPromptSubmit → dist/hooks/cli.js → searchAtomic (+ readCore, listScenarios once per session)
  │                        → additionalContext: <user-persona>, <scene-navigation>, <relevant-memories>, tool guide
  │    Stop             → dist/hooks/cli.js → transcript delta of the finished turn → addConversation (L0)
  │    SessionEnd       → dist/hooks/cli.js → whatever transcript remains → addConversation (L0)
  └─ MCP server (stdio; ~/.claude.json or .mcp.json)
       dist/mcp/stdio.js → tdai_memory_search / tdai_conversation_search / tdai_scenario_read / tdai_memory_capture
                          → tdai_wiki_list / search / pages / read / write   (Knowledge Service, optional)
            │
            ▼
       TencentDB Agent Memory Gateway (:8420)   +   Knowledge Service (:8421, optional)
```

## What gets captured

`Stop` reads the session transcript named by `transcript_path` in the hook payload (fallback: `<config dir>/projects/<cwd with non-alphanumerics as "-">/<session_id>.jsonl`) and sends the finished turn as one `addConversation` call: the prompt, every tool call, every tool result, intermediate and final assistant text. `SessionEnd` sends whatever is still unsent, for example a turn whose Stop was skipped because background tasks were running.

- Thinking blocks and images are dropped. A tool call becomes assistant text `[tool_use id=… name=… input=…]` (input quoted up to 2000 characters); a tool result becomes user text `[tool_result tool_use_id=…] …` (up to 4000 characters). Messages longer than 8192 characters are chunked; batches hold at most 100 messages.
- Credential-shaped substrings (private keys, bearer tokens, `sk-…` keys, GitHub / GitLab / Slack / AWS / Google / npm tokens, `password=…` values) are replaced by `[redacted:<kind>]` before anything leaves the machine. Tool traffic routinely carries env dumps and config files.
- A per-session marker in the state directory records the last transcript entry sent. A batch that fails leaves the marker where it was and the turn unclaimed, so `SessionEnd` sends the rest. A resumed session that ends again sends only what is new.
- When no transcript can be read, `Stop` falls back to the prompt and final assistant message. A turn captured that way contributes only its tool traffic later, so nothing lands twice.
- Capture is skipped while `background_tasks` or `session_crons` are present, so a pause with work in flight is not treated as a final response.

Why per turn rather than at session end: a 100-message batch costs the Gateway a few seconds, and a session's `SessionEnd` fires once, so an end-only capture loses the tail of a long session.

## What gets recalled

On every prompt the L1 hits for that prompt are injected as `<relevant-memories>`. On the session's first prompt the stable block is added once: the L3 persona (`<user-persona>`), the L2 scene index (`<scene-navigation>`, readable with `tdai_scenario_read`), and a short guide to the MCP tools. If every recall request fails, nothing is injected and the stable block is retried on the next prompt.

## Quick Start

### 1. Build

```bash
cd MemoryCore/claude-code-plugin
npm install
npm run build          # → dist/hooks/cli.js, dist/mcp/stdio.js
npm test
```

### 2. Environment

Set these in the shell that launches `claude` (or in the `env` block of `~/.claude/settings.json`):

| Variable | Default | Purpose |
|---|---|---|
| `TDAI_GATEWAY_URL` | `http://127.0.0.1:8420` | Memory Gateway base URL. |
| `TDAI_GATEWAY_API_KEY` (or `TDAI_API_KEY`) | `local` | Bearer token for the Gateway. |
| `TDAI_SERVICE_ID` | `default` | Memory instance id (`x-tdai-service-id`). |
| `TDAI_TEAM_ID` / `TDAI_AGENT_ID` / `TDAI_USER_ID` | `default` | v3 isolation triple, from the panel. |
| `TDAI_KNOWLEDGE_URL` | unset | Knowledge Service base URL; enables the `tdai_wiki_*` tools. |
| `TDAI_KNOWLEDGE_API_KEY` | falls back to the Gateway key | Bearer token for the Knowledge Service. |
| `TDAI_CLAUDE_CODE_STATE_DIR` | `~/.memory-tencentdb/claude-code-plugin` | Prompt cache, capture markers, transcript position. |
| `TDAI_RECALL_MAX_RESULTS` | `5` | L1 hits per prompt. |
| `TDAI_RECALL_PERSONA` / `TDAI_RECALL_SCENE_NAV` | `on` | Set `off` to leave persona / scene index out of the first-prompt block. |
| `TDAI_CAPTURE` | `on` | Set `off` to disable capture at Stop and SessionEnd. |
| `TDAI_STOP_BUDGET_MS` / `TDAI_SESSION_END_BUDGET_MS` | `3500` / `25000` | Wall-clock budgets for transcript batches. A budget only stops new batches from starting. |
| `TDAI_RECALL_TIMEOUT_MS` / `TDAI_CAPTURE_TIMEOUT_MS` | `3000` / `15000` | Gateway timeouts for recall and for one capture batch. |

### 3. Hooks

Merge [`integrations/hooks.json`](./integrations/hooks.json) into `~/.claude/settings.json` (every project) or `.claude/settings.json` (one project), replacing the absolute path. The hook timeouts (5 s, 15 s, 30 s) must cover a batch in flight, or the Gateway records a batch whose marker is never written. Check with `/hooks` inside Claude Code.

### 4. MCP server

Copy [`integrations/mcp.json.example`](./integrations/mcp.json.example) to the project root as `.mcp.json`, or register for every project:

```bash
claude mcp add --transport stdio --scope user tdai -- \
  node /absolute/path/to/TencentDB-Agent-Memory/MemoryCore/claude-code-plugin/dist/mcp/stdio.js
```

Check with `/mcp`. Tell the model which wiki id to use in your `CLAUDE.md`; the adapter never assumes one.

### 5. Test a hook by hand

```bash
printf '%s' '{"hook_event_name":"UserPromptSubmit","session_id":"demo","prompt_id":"p1","cwd":"/tmp","prompt":"what is our release flow?"}' \
  | node dist/hooks/cli.js
```

Expect `{}` when nothing matches, or `hookSpecificOutput.additionalContext` when recall succeeds.

## Adapter responsibilities

- Hook processes share state only through files under the state directory (hashed names, 0600). Prompt cache and capture markers expire after 24 hours; session markers after 30 days.
- Every path fails open. Recall errors return `{}`; capture errors are logged to stderr and retried by a later hook; the MCP server surfaces Gateway errors as tool errors.
- The plugin holds no organisation-specific content: wiki ids are tool parameters, identity comes from the environment.

## Files

```text
claude-code-plugin/
├── src/
│   ├── config.ts            env → config
│   ├── client.ts            V3MemoryClient + Knowledge client factories
│   ├── format.ts            recall context formatting
│   ├── knowledge.ts         Knowledge Service client + wiki tools
│   ├── hooks/
│   │   ├── cli.ts           hook entry (stdin → stdout)
│   │   ├── handler.ts       UserPromptSubmit / Stop / SessionEnd
│   │   ├── recall.ts        searchAtomic + readCore + listScenarios
│   │   ├── capture.ts       transcript delta → addConversation
│   │   ├── transcript.ts    JSONL parsing, normalisation, redaction, chunking
│   │   └── state.ts         prompt cache, capture markers, session markers
│   └── mcp/
│       ├── server.ts        tool definitions
│       └── stdio.ts         MCP entry
├── __tests__/               vitest
├── integrations/            hooks.json, mcp.json.example
└── README.md / README_CN.md
```
