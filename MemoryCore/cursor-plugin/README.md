# Cursor IDE Adapter

Standalone Cursor Hooks and MCP adapter for the MemoryCore v3 SDK. It keeps
Cursor's foreground lifecycle fail-open and stores complete transcript turns in
local pending JSONL before a detached worker delivers them.

## Data flow

```text
sessionStart → concurrent readCore/listScenarios → additional_context
stop         → transcript → pending JSONL → detached worker → addConversation
sessionEnd   → detached worker wake-up + local marker cleanup
MCP          → searchAtomic/searchConversation/readScenario
```

`stop` and `sessionEnd` never access the network. If MemoryCore is unavailable,
the worker keeps pending data for a later `stop` or `sessionEnd` wake-up.

## Configuration

Set all required values before running hooks, worker, or MCP:

```bash
export MEMORY_TENCENTDB_GATEWAY_URL=https://memory.example.com
export MEMORY_TENCENTDB_GATEWAY_API_KEY=replace-me
export MEMORY_TENCENTDB_SERVICE_ID=service-1
export MEMORY_TENCENTDB_TEAM_ID=team-1
export MEMORY_TENCENTDB_AGENT_ID=agent-1
export MEMORY_TENCENTDB_USER_ID=user-1
```

Optional values:

```bash
export MEMORY_TENCENTDB_TASK_ID=task-1
export MEMORY_TENCENTDB_CURSOR_CAPTURE_TIMEOUT_MS=60000
export MEMORY_TENCENTDB_CURSOR_RECALL_TIMEOUT_MS=2000
export MEMORY_TENCENTDB_CURSOR_TRANSCRIPTS_ROOT=$HOME/.cursor/projects
```

The equivalent `TDAI_MEMORY_ENDPOINT`, `TDAI_MEMORY_API_KEY`,
`TDAI_MEMORY_INSTANCE_ID`, `TDAI_MEMORY_TEAM_ID`, `TDAI_MEMORY_AGENT_ID`,
`TDAI_MEMORY_USER_ID`, and `TDAI_MEMORY_TASK_ID` variables are also accepted.
No isolation ID is generated or defaulted by the adapter.

## Build and install

```bash
npm install
npm run build
node dist/src/entry.js install --scope project
```

Use `--scope user` for user-level installation. The installer refuses duplicate
cross-scope ownership and does not overwrite foreign Hook, MCP, or Rule entries.

## MCP tools

- `tdai_memory_search`: L1 search through `searchAtomic()`.
- `tdai_conversation_search`: L0 evidence through `searchConversation()`.
- `tdai_read_cos`: reads only an L2 relative scenario path through
  `readScenario()`. The name is retained for agent compatibility; it does not
  access COS or STS.

## Verification

```bash
npm test
npm run typecheck
npm run build
```

Unit and build verification do not replace the real Cursor + MemoryCore E2E.
Stage 1 remains unaccepted until the E2E proves write, new-session recall, L2
read, isolation, and pending recovery while the server is unavailable.
