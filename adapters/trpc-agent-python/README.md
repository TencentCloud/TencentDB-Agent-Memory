# TencentDB Agent Memory — trpc-agent-python Adapter

Give agents built with [trpc-agent-python](https://github.com/trpc-group/trpc-agent-python) persistent memory, backed by TencentDB Agent Memory. This adapter provides `TencentDBMemoryService`, a drop-in implementation of the framework's `MemoryServiceABC` (the same contract the built-in InMemory / Redis / SQL / Mem0 services implement), so it plugs into `Runner(memory_service=...)` without any framework changes.

Once wired in, every session automatically gets:

- **Turn capture** — after each completed turn, the runner calls `store_session`, which streams the turn's user/assistant pair to the gateway (`POST /capture`) and into the L0 → L3 memory pipeline
- **Memory search** — the framework's recall path (`invocation_context → search_memory`) queries the gateway (`POST /search/memories`) and maps results into `SearchMemoryResponse`
- **Incremental capture** — a per-session watermark ensures repeated `store_session` calls only send the delta, never replaying the transcript
- **Fail-open by default** — a gateway outage is logged and skipped; the agent loop is never blocked

## How it works

```
trpc-agent-python Runner
  ├─ post-turn: store_session ─(POST /capture)──► L0 → L3 pipeline
  └─ recall: search_memory ────(POST /search/memories)──► SearchMemoryResponse
                                                  ▼
                       Memory Core Gateway (port 8420)
                  (capture · extract · store · recall)
```

The adapter talks to the **memory-core gateway** (`:8420` by default), which runs the memory engine (extraction, dedup, scenario distillation, profiling). This mirrors the official trpc-agent-go integration (`memory/tencentdb`), which targets the same gateway routes.

Identity follows the framework convention: the session's `save_key` (`{app}/{user}`) is the primary scope — exactly like the built-in Mem0 service — with config values as fallbacks.

## Prerequisites

1. TencentDB Agent Memory running locally:

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

   Set `MEMORY_LLM_BASE_URL` / `MEMORY_LLM_API_KEY` / `MEMORY_LLM_MODEL` in `.env` — the memory engine uses this LLM for extraction and recall.

2. Python 3.10+ with trpc-agent-python (PyPI: `trpc-agent-py`, ≥ 1.1.17):

   ```bash
   pip install trpc-agent-py
   ```

## Installation

```bash
pip install ./adapters/trpc-agent-python
```

Or copy the `tdai_trpc/` package into your project (dependencies: `trpc-agent-py` and `httpx` only).

## Quickstart

```python
from trpc_agent_sdk.agents import LlmAgent
from trpc_agent_sdk.models import OpenAIModel
from trpc_agent_sdk.runners import Runner
from trpc_agent_sdk.sessions import InMemorySessionService

from tdai_trpc import TDAiConfig, TencentDBMemoryService

memory = TencentDBMemoryService(TDAiConfig(
    gateway_url="http://127.0.0.1:8420",
    api_key=os.environ.get("TDAI_GATEWAY_API_KEY", ""),
    fail_open=True,
))

runner = Runner(
    app_name="my-app",
    agent=LlmAgent(name="assistant", model=OpenAIModel("gpt-4o-mini"),
                   instruction="You are a concise assistant."),
    session_service=InMemorySessionService(),
    memory_service=memory,   # stores each completed turn after the turn ends
)

async for event in runner.run_async(
    user_id="user-42",
    session_id="session-1",
    new_message=user_message("Remember: my codename is Apollo Lake."),
):
    ...
# A brand-new session can now recall it through the framework's memory path.
```

A runnable end-to-end script is in [`example/quickstart.py`](./example/quickstart.py).

## Configuration reference

| Field | Effect | Default |
|---|---|---|
| `gateway_url` | memory-core gateway URL (remote plaintext HTTP rejected unless `allow_remote_http=True`) | `http://127.0.0.1:8420` |
| `api_key` | `Authorization: Bearer` key; required when gateway starts with `TDAI_GATEWAY_API_KEY` | `""` |
| `timeout` | Per-request HTTP timeout | `5.0` s |
| `app_name` / `user_id` | Fallback identity when a session's `save_key` can't be parsed; the session's own `save_key` always takes precedence | `"trpc-agent-app"` / `"default-user"` |
| `allow_remote_http` | Permit plaintext HTTP to a non-local gateway | `False` |
| `fail_open` | gateway errors logged-and-swallowed (empty search results) instead of raised | `True` |

Pass a framework `MemoryServiceConfig` as the second constructor argument to control `enabled` / TTL settings; `TTL` eviction is delegated to the gateway (the memory engine owns retention).

## Security and behavior

- **Identity scoping**: every request carries the app/user resolved from `session.save_key`; these are provenance fields, not an authorization boundary — hard multi-tenant isolation depends on the gateway.
- **No cleartext credentials to remote hosts**: `http://` is only allowed for loopback gateways by default.
- **Fail-open by default**: store/search failures are logged and skipped so the agent loop never blocks; set `fail_open=False` when memory is a hard requirement.
- **Capture retries**: the per-session watermark advances only after a successful response, so failed captures are retried. Narrow duplicate window: if the gateway persists a turn but the response is lost, the retry resends the same delta (message IDs are server-assigned).
- **`enabled` gate**: `store_session` / `search_memory` are no-ops when the framework config disables the service, independent of the runner's own gating.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `GatewayError` on health check | Stack not running — start it and check `MEMORY_CORE_PORT` (8420). |
| Gateway returns 401 | Gateway started with `TDAI_GATEWAY_API_KEY` — pass it via `TDAiConfig(api_key=...)`. |
| Nothing captured | Verify the service is enabled (`memory.enabled`) — the runner gates persistence on it; and check that sessions carry a non-empty `id` and `save_key`. |
| No memory recalled in new sessions | Extraction is asynchronous — wait a few seconds and retry. |
| Duplicate captures | Rare: the gateway persisted a turn but its response was lost, so the retry resent the delta. |

## Testing

Tests run against a fake gateway and real `trpc_agent_sdk` classes (no stack or LLM needed) — 36 cases across five files:

```bash
cd adapters/trpc-agent-python
pip install -e ".[test]"
pytest
```

## Notes

- **Upstream**: this adapter is self-contained (subclasses the published PyPI package). Moving it into `trpc_agent_sdk/memory/` upstream remains a natural follow-up.
- **Version**: verified with `trpc-agent-py` 1.1.17 and TencentDB Agent Memory v2 images (`feat/server_team` branch).

## License

MIT, same as the main repository.
