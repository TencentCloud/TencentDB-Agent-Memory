# TencentDB Agent Memory — AnythingLLM Adapter

Give [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every workspace chat automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
AnythingLLM ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                             │
                                             ├─ auth        (validates sk-mem-... user_key)
                                             ├─ sessionInit (Team/Agent/Task picker)
                                             └─ injection   (L2/L3 memory + skills + knowledge)
```

AnythingLLM's **Generic OpenAI** LLM provider accepts any OpenAI-compatible endpoint — a Base URL and API key you configure in the UI or via environment variables. The provider is implemented with the OpenAI SDK, passing your Base URL through unchanged and appending `/chat/completions` to it (verified in source: `server/utils/AiProviders/genericOpenAi/index.js` builds the client with `baseURL: GENERIC_OPEN_AI_BASE_PATH`; the settings layer only URL-validates, it never rewrites the path). Pointing the Base URL at the proxy's `/codebuddy/<spaceId>/v1` endpoint connects it — **no code changes required**.

**Session binding** (an interactive Team → Agent → Task picker on first message), **memory injection** (the bound agent's L2/L3 memory, skills and knowledge blended into the system prompt every turn) and **automatic capture** (L0 raw dialogue persisted into memory-core) all work with no code changes.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. AnythingLLM is running (Desktop app or Docker — see the [official docs](https://docs.anythingllm.com/)).

## Setup

### 1. Point AnythingLLM's Generic OpenAI provider at the proxy

In the AnythingLLM UI: open **Settings → AI Providers → LLM**, select **Generic OpenAI**, and fill in:

- **Base URL**: `http://127.0.0.1:8096/codebuddy/default/v1` — replace `default` with your memory space ID if you use another space. Keep the trailing `/v1`: AnythingLLM passes the Base URL to the OpenAI SDK unchanged, which appends `/chat/completions` and lands exactly on the proxy's `/codebuddy/<spaceId>/v1/chat/completions` route.
- **API Key**: your business user key (`sk-mem-...`).
- **Chat Model**: your proxy's `PROXY_UPSTREAM_MODEL` value (e.g. `claude-sonnet-4-20250514`). It **must match** the proxy's upstream model, otherwise the proxy rejects with an upstream mismatch.

Save the settings.

For Docker deployments you can configure the same provider via environment variables instead:

```bash
GENERIC_OPEN_AI_BASE_PATH=http://127.0.0.1:8096/codebuddy/default/v1
GENERIC_OPEN_AI_API_KEY=sk-mem-xxxxxxxx
GENERIC_OPEN_AI_MODEL_PREF=claude-sonnet-4-20250514
```

### 2. Verify

1. Open an AnythingLLM workspace chat and make sure the Generic OpenAI model is the active one.
2. Send a first message. The proxy triggers the session picker in the chat interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask AnythingLLM what it remembers from previous conversations to confirm.

## Configuration reference

| Field / Variable | Value | Notes |
|---|---|---|
| Base URL / `GENERIC_OPEN_AI_BASE_PATH` | `http://127.0.0.1:8096/codebuddy/default/v1` | Proxy endpoint; `default` is the memory space ID — change it per space; **keep** the trailing `/v1` |
| API Key / `GENERIC_OPEN_AI_API_KEY` | `sk-mem-...` | Business user key from the Panel; sent as `Authorization: Bearer` |
| Chat Model / `GENERIC_OPEN_AI_MODEL_PREF` | `PROXY_UPSTREAM_MODEL` value (e.g. `claude-sonnet-4-20250514`) | Must equal the proxy's upstream model |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401` / "Invalid API Key" | The key must be a business user key (`sk-mem-...`) from the Panel — not the admin key from `./.admin-key` |
| Empty AI responses / upstream mismatch | Chat Model differs from `PROXY_UPSTREAM_MODEL` — align them |
| `404` on every request | Missing trailing `/v1` in the Base URL (requests then hit `/codebuddy/<spaceId>/chat/completions`); enter the Base URL exactly as shown above |
| Connection refused | Proxy not running on `:8096` — check `./start-all.sh` logs and `PROXY_UPSTREAM_*` env vars; for Docker, `127.0.0.1` must resolve to the host running the proxy (use `host.docker.internal` if the proxy is on the Docker host) |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new chat to re-pick |

## Notes

- **App-local config**: the Base URL and key live only in AnythingLLM's settings / environment, never in a committed file; this adapter therefore ships docs only (same as the LobeChat / Open WebUI / LibreChat adapters).
- **All workspace chats flow through it**: every chat using the Generic OpenAI model gets memory injection — agents included.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
