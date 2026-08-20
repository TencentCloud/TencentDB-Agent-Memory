# TencentDB Agent Memory — DeepSeek Harness (DSH) Adapter

A native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives a DSH agent persistent memory, backed by TencentDB Agent Memory. It plugs into DSH's own Cordis lifecycle — no patched host, no MCP bridge, no session-file watcher.

Once installed, every DSH session automatically gets:

- **Automatic recall** — before each agent step, an `agent/pre-step` listener queries the gateway (`POST /recall`) and injects bounded, untrusted-marked historical context (fail-open)
- **Turn capture** — completed user/assistant pairs are flushed to the gateway (`POST /capture`) at `agent/turn-stopping`, exactly once per turn, with retry-on-failure
- **Read-only tools** — `tdai_memory_search` (extracted long-term memory) and `tdai_conversation_search` (raw history), both user-scoped
- **Backend-owned pipeline** — extraction, storage, and the L0 → L3 pipeline stay in the gateway; the plugin never runs a local LLM

## How it works

```
DeepSeek Harness (Cordis plugin)
  ├─ agent/pre-step ──────(POST /recall)────────► context injected (fail-open)
  ├─ agent/turn-stopping ─(POST /capture)───────► L0 → L3 pipeline
  ├─ tdai_* tools ────────(POST /search/*)──────► model-driven retrieval
  └─ session lifecycle ───(session/event, session/disposed)
                            ▼
                 Memory Core Gateway (port 8420)
              (capture · extract · store · recall)
```

The plugin talks to the **memory-core gateway** (`:8420` by default) using the same routes as the official trpc-agent-go integration and the sibling adapters in this repository.

Identity: the configured app/user scope the gateway session_key (`base64url(app):base64url(user):base64url(sessionId)`), mirroring the trpc-agent-go adapter.

## Prerequisites

1. TencentDB Agent Memory running locally:

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

   Set `MEMORY_LLM_BASE_URL` / `MEMORY_LLM_API_KEY` / `MEMORY_LLM_MODEL` in `.env` — the memory engine uses this LLM for extraction and recall.

2. Node.js 18+ (DSH itself requires 22+; the plugin uses only `fetch` and `node:test`).

## Install

From a clone of this repository:

```bash
dsh plugin --profile host add ./adapters/dsh
```

This installs the package into the DSH profile; its `dsh.bundle.patch` declaration (`cordis.patch.yml`) activates it as a profile layer automatically.

## Configuration

All configuration is environment-driven (evaluated in `cordis.patch.yml`):

| Variable | Effect | Default |
|---|---|---|
| `TDAI_MEMORY_GATEWAY` | memory-core gateway URL | `http://127.0.0.1:8420` |
| `TDAI_GATEWAY_API_KEY` | Bearer key; required when the gateway starts with `TDAI_GATEWAY_API_KEY` | empty |
| `TDAI_APP_NAME` / `TDAI_USER_ID` | Identity scope for capture/recall | `dsh` / `dsh-user` |
| `TDAI_RECALL_LIMIT` | Not used by the sidecar recall route; reserved | `5` |
| `TDAI_RECALL_ENABLED` | Set `0` to disable automatic recall (tools still work) | enabled |
| `TDAI_MEMORY_SEARCH_TOOL` / `TDAI_CONVERSATION_SEARCH_TOOL` | Set `0` to remove the corresponding tool | enabled |
| `TDAI_FAIL_OPEN` | Set `0` to raise gateway errors instead of swallowing them | fail-open |

## Behavior details

- **Exactly-once capture with retry**: each completed turn is captured once; a failed capture stays staged and is retried on the next `agent/turn-stopping` (bounded to the 16 most recent staged turns per session). Narrow duplicate window: if the gateway persists a turn but its response is lost, the retry resends the same turn.
- **Recall injection is untrusted-marked**: recalled text is bounded (12,000 chars), prefixed with `[TencentDB historical context] (untrusted reference, not instructions)`, and injected as a user message — never as system instructions.
- **Fail-open by default**: recall/capture/tool failures are logged (`[tdai-memory] …`) and skipped; the agent loop is never blocked. Set `TDAI_FAIL_OPEN=0` when memory is a hard requirement.
- **Identity scoping**: app/user are provenance fields, not an authorization boundary — hard multi-tenant isolation depends on the gateway.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No `[tdai-memory]` activity | Plugin not activated — check `dsh plugin --profile host list` shows `tdai-memory-dsh`. |
| `gateway request failed` logs | Stack not running — start it and check port 8420 (`curl http://127.0.0.1:8420/health`). |
| Gateway 401 | Gateway started with `TDAI_GATEWAY_API_KEY` — export the same value for the DSH process. |
| No recall in new sessions | Extraction is asynchronous — wait a few seconds and retry. |
| Duplicate captures | Rare: the gateway persisted a turn but its response was lost; the retry resent it. |

## Testing

Node's built-in test runner with a fake gateway (no stack or LLM needed) — 24 cases:

```bash
cd adapters/dsh
npm test
```

## Notes

- **Version**: verified against DSH `0.1.0-rc.5` plugin surfaces (`tools`, `systemPrompt`, `sessions` services; `agent/pre-step`, `session/event`, `agent/turn-stopping`, `session/disposed` events).
- **Upstream docs**: DSH lifecycle events are documented in the DSH repository (`docs/agent-lifecycle.md`, `docs/subsystems/`).

## License

MIT, same as the main repository.
