# TencentDB Agent Memory — LobeChat Adapter

Give [LobeChat](https://github.com/lobehub/lobe-chat) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every conversation automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
LobeChat ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                         │
                                         ├─ auth        (validates sk-mem-... user_key)
                                         ├─ sessionInit (Team/Agent/Task picker)
                                         └─ injection   (L2/L3 memory + skills + knowledge)
```

LobeChat's built-in OpenAI provider honors `OPENAI_PROXY_URL` — the environment variable that overrides the default OpenAI API base URL ([official deployment docs](https://lobehub.com/docs/self-hosting/environment-variables/basic)). Pointing it at the proxy's `/codebuddy/<spaceId>` endpoint connects it — **no code changes required**.

**Session binding** (an interactive Team → Agent → Task picker on first message), **memory injection** (the bound agent's L2/L3 memory, skills and knowledge blended into the system prompt every turn) and **automatic capture** (L0 raw dialogue persisted into memory-core) all work with no code changes.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. LobeChat is deployed (Docker or Vercel — see the [official docs](https://lobehub.com/docs/self-hosting/platform/docker-compose)).

## Setup

### 1. Point LobeChat's OpenAI provider at the proxy

For a Docker deployment:

```bash
docker run -d -p 3210:3210 \
  -e OPENAI_API_KEY=sk-mem-xxxxxxxx \
  -e OPENAI_PROXY_URL=http://127.0.0.1:8096/codebuddy/default \
  -e OPENAI_MODEL_LIST=+claude-sonnet-4-20250514 \
  -e ACCESS_CODE=your-access-code \
  --name lobe-chat lobehub/lobe-chat
```

- `OPENAI_API_KEY` — your business user key (`sk-mem-...`)
- `OPENAI_PROXY_URL` — the proxy endpoint; replace `default` with your memory space ID if you use another space. Pass it exactly as shown, **without** a trailing `/v1` (the proxy's `/codebuddy/<spaceId>` path has no `/v1` segment; LobeChat appends the chat-completions path itself)
- `OPENAI_MODEL_LIST` — adds the proxy's upstream model to the model picker
- `ACCESS_CODE` — access protection for your LobeChat instance (recommended)

For an existing deployment, set the same variables in your `docker-compose.yml` / hosting env, or configure them at runtime in **Settings → Language Model → OpenAI** (API Proxy URL + API Key).

### 2. Align the model ID

The model name **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The example uses `claude-sonnet-4-20250514`; change it if your proxy targets a different upstream.

### 3. Verify

1. Open LobeChat (`http://localhost:3210`), enter the access code, and pick `claude-sonnet-4-20250514` as the model.
2. Send a first message. The proxy triggers the session picker in the chat interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask LobeChat what it remembers from previous conversations to confirm.

## Configuration reference

| Variable | Value | Notes |
|---|---|---|
| `OPENAI_PROXY_URL` | `http://127.0.0.1:8096/codebuddy/default` | Proxy endpoint; `default` is the memory space ID — change it per space; no trailing `/v1` |
| `OPENAI_API_KEY` | `sk-mem-...` | Business user key from the Panel; sent as `Authorization: Bearer` |
| `OPENAI_MODEL_LIST` | `+claude-sonnet-4-20250514` | Must equal `PROXY_UPSTREAM_MODEL`, otherwise the proxy rejects with an upstream mismatch |
| `ACCESS_CODE` | any strong code | Protects your LobeChat instance (optional but recommended) |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401` / "Invalid API Key" | The key must be a business user key (`sk-mem-...`) from the Panel — not the admin key from `./.admin-key` |
| Empty AI responses | `OPENAI_PROXY_URL` suffix mismatch — do **not** append `/v1`; pass exactly `http://<host>:8096/codebuddy/<spaceId>` |
| "Model Not Found" / upstream mismatch | Model name differs from `PROXY_UPSTREAM_MODEL` — align them and re-check `OPENAI_MODEL_LIST` |
| `404` / connection refused | Proxy not running on `:8096` — check `./start-all.sh` logs and `PROXY_UPSTREAM_*` env vars |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new topic to re-pick |

## Notes

- **Env-configured**: the key lives only in LobeChat's environment / runtime settings, never in a committed file; this adapter therefore ships docs only (same as the Open WebUI / LibreChat adapters).
- **All conversations flow through it**: every topic using the configured model gets memory injection — assistants, agents and plugins included.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
