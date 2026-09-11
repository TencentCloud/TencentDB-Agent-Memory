# TencentDB Agent Memory — OpenHands Adapter

Give [OpenHands](https://github.com/All-Hands-AI/OpenHands) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every session automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
OpenHands ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                       │
                                       ├─ auth        (validates sk-mem-... user_key)
                                       ├─ sessionInit (Team/Agent/Task picker)
                                       └─ injection   (L2/L3 memory + skills + knowledge)
```

[OpenHands](https://github.com/All-Hands-AI/OpenHands) routes all LLM calls through LiteLLM. Setting `LLM_MODEL=openai/<model>` together with `LLM_BASE_URL` points that OpenAI-compatible client at the proxy's `/codebuddy/<spaceId>` endpoint — no code changes required.

**Session binding** (an interactive Team → Agent → Task picker on first message), **memory injection** (the bound agent's L2/L3 memory, skills and knowledge blended into the system prompt every turn) and **automatic capture** (L0 raw dialogue persisted into memory-core) all work with no code changes.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. OpenHands is installed (`docker pull openhands/all-hands-ai` or `pip install openhands-ai`, per [docs.openhands.dev](https://docs.openhands.dev)).

## Setup

### 1. Point OpenHands at the proxy

Environment variables (recommended — they also work for the Docker image):

```bash
export LLM_MODEL=openai/claude-sonnet-4-20250514
export LLM_BASE_URL=http://127.0.0.1:8096/codebuddy/default
export LLM_API_KEY=sk-mem-...        # your business user key
```

Or persist them in `config.toml` (see `config.example.toml` in this directory). In the UI the same fields live under **Settings → LLM**: set Provider/Model and API Key there, with **Base URL** under *Advanced*.

### 2. Align the model name

The part after `openai/` **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The example uses `claude-sonnet-4-20250514`; change it if your proxy targets a different upstream. The `openai/` prefix is what makes LiteLLM use the OpenAI-compatible client with your base URL.

### 3. Verify

1. Start a new OpenHands conversation/task.
2. Send the first message. The proxy triggers the session picker in the conversation interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask OpenHands what it remembers from previous sessions to confirm.

## Configuration reference

| Item | Value | Notes |
|---|---|---|
| `LLM_MODEL` | `openai/claude-sonnet-4-20250514` | The `openai/` prefix selects LiteLLM's OpenAI-compatible client |
| `LLM_BASE_URL` | `http://127.0.0.1:8096/codebuddy/default` | Proxy endpoint; trailing `default` is the memory space ID — change it per space |
| `LLM_API_KEY` | `sk-mem-...` | Business user key; sent as `Authorization: Bearer` |
| `LLM_DROP_PARAMS` | `true` (optional) | Drops params the upstream rejects (e.g. caching headers) instead of erroring |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401` from proxy | Wrong or missing key — `LLM_API_KEY` must be a business user key (`sk-mem-...`), not the admin key |
| `404` / connection refused | Proxy not running on `:8096` — check `./start-all.sh` logs and `PROXY_UPSTREAM_*` env vars |
| Model mismatch error | The `openai/<model>` name differs from `PROXY_UPSTREAM_MODEL` — align them |
| Provider errors on unknown params | Set `LLM_DROP_PARAMS=true` so LiteLLM drops unsupported params instead of failing |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous conversation already bound a task, the binding is reused — start a new conversation to re-pick |

## Notes

- **Agent-heavy workload**: OpenHands issues many LLM calls per task; every one of them lands in the bound agent's L0 raw dialogue, which is exactly what memory distillation expects.
- **UI parity**: the Settings UI serializes into the same `LLM_*` schema, so UI-configured and env-configured setups behave identically.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
