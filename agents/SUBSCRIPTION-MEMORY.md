# Memory for subscription clients

Codex and Claude Code retain their existing subscription authentication. The
MemoryCore/Memory Hub backend uses `deepseek-v4-flash` at
`https://api.deepseek.com/v1` for extraction and synthesis. No model-request
proxy is involved in this integration.

## Automatic behavior

| Event | Behavior |
| --- | --- |
| SessionStart, including after compaction | Inject shared profile, scenario summaries, relevant memories and skill search results. |
| UserPromptSubmit | Store the prompt locally and inject relevant shared memory before the model answers. |
| Stop | Send the completed prompt/final-answer pair to MemoryCore L0 and the skill conversation buffer. |
| PreCompact | Request skill-buffer archival and extraction. |
| MemoryCore background workers | Extract L1 facts, aggregate L2 scenarios and synthesize the L3 profile with DeepSeek. |

MCP adds explicit `memory_search`, `memory_save`, `memory_profile` and
`memory_scenario` tools. Automatic hooks do not depend on the model invoking MCP.

Configure the two clients with the same user, team and agent IDs to share memory.
Session IDs retain the source prefix. Project
paths accompany captured prompts; this is a personal shared memory pool, not
an isolation boundary between projects.

## Local configuration (never commit credentials or generated IDs)

- Dashboard: <http://localhost:8125>
- MemoryCore: the port configured by `MEMORY_CORE_PORT` (default `8420`).
- Knowledge service: <http://localhost:8424>
- Backend settings/key: `deploy/global-images/.env` (ignored, mode 600).
- Shared user/team/agent IDs: `deploy/global-images/.env.memory-mcp.json` (ignored).
- Dashboard admin login key: `deploy/global-images/.admin-key`.
- Hook state and retry queue: `workspace/subscription-memory/hooks.sqlite` (ignored).
- Python environment: `workspace/subscription-memory/.venv`.
- Codex hooks: `~/.codex/hooks.json`; MCP: `~/.codex/config.toml`.
- Claude Code hooks: `~/.claude/settings.json`; MCP: `~/.claude.json`.

Create the user, team and agent through Memory Hub, then put their IDs in the
ignored `deploy/global-images/.env.memory-mcp.json` file:

```json
{"user_id": "YOUR_USER_ID", "team_id": "YOUR_TEAM_ID", "agent_id": "YOUR_AGENT_ID"}
```

Set `MEMORY_LLM_BASE_URL`, `MEMORY_LLM_API_KEY`, `MEMORY_LLM_MODEL` and a random
`MEMORY_CORE_GATEWAY_API_KEY` in the ignored `.env` file. Set
`MEMORY_BIND_ADDRESS=127.0.0.1` for a local-only deployment.

Restart both clients to load the integration. **In Codex, open `/hooks` and
review/trust the four new memory hooks.** Codex skips untrusted hooks; installing
their definitions does not grant trust. Claude Code can inspect tools with `/mcp`.

Register each hook to run the environment's Python with `agents/memory_hooks.py codex` or
`agents/memory_hooks.py claude-code`, with a 20-second timeout. MCP runs
`agents/memory_mcp.py` using the same Python. Resolve these paths to your checkout
in your local client settings; do not publish those machine-specific settings.
Preserve existing hooks when adding these commands.

Start the services again using `start-memory-core.sh` and `start-memory-hub.sh`
in `deploy/global-images`. Use these individual scripts for subscription mode;
`start-all.sh` also configures the API proxy. Docker containers restart unless
explicitly stopped. Persistent Docker volumes retain the backend data.

## Scope and failure behavior

Capture uses documented prompt/final-answer hook fields, not full transcripts.
Tool traces, intermediate answers, interrupted turns and subagent conversations
are not captured. This preserves automatic chat memory but does not reproduce
the proxy's full trace-based skill learning or knowledge routing.

Skill buffers use the repository's normal size thresholds and are also archived
before compaction. Small conversations may produce no reusable skill. Wiki and
CodeGraph ingestion remain separate dashboard operations.

Configured secrets and common key/password patterns are redacted before local
capture or recall queries; this is not a universal secret detector. Completed
turns are sent to the memory backend and processed by DeepSeek. Local pending
captures survive service outages and retry on subsequent hook events. A lost
HTTP acknowledgement may cause a duplicate because the upstream ingestion API
does not accept idempotency keys. Hook failures report a diagnostic and do not
block coding. No historical transcripts are imported automatically.

## Checks

```bash
workspace/subscription-memory/.venv/bin/python agents/test-memory-mcp.py
workspace/subscription-memory/.venv/bin/python agents/test-memory-hooks.py
```

References: [Codex hooks](https://developers.openai.com/codex/hooks),
[Claude Code hooks](https://code.claude.com/docs/en/hooks),
[DeepSeek models](https://api-docs.deepseek.com/).
