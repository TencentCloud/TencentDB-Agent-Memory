# TencentDB Agent Memory — Open WebUI Adapter

Give [Open WebUI](https://github.com/open-webui/open-webui) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every session automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
Open WebUI ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                       │
                                       ├─ auth        (validates sk-mem-... user_key)
                                       ├─ sessionInit (Team/Agent/Task picker)
                                       └─ injection   (L2/L3 memory + skills + knowledge)
```

[Open WebUI](https://github.com/open-webui/open-webui) connects to OpenAI-compatible APIs through its **OpenAI API connection** ([official docs](https://docs.openwebui.com/reference/env-configuration)): setting `OPENAI_API_BASE_URL` to the proxy's `/codebuddy/<spaceId>` endpoint routes every chat turn (and optional background tasks) through TencentDB Agent Memory — no code changes required.


**Session binding** (an interactive Team → Agent → Task picker on first message), **memory injection** (the bound agent's L2/L3 memory, skills and knowledge blended into the system prompt every turn) and **automatic capture** (L0 raw dialogue persisted into memory-core) all work with no code changes.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. Open WebUI is running (`docker run -d -p 3000:8080 -v open-webui:/app/backend/data --add-host=host.docker.internal:host-gateway ghcr.io/open-webui/open-webui:main`, or pip; see [docs.openwebui.com](https://docs.openwebui.com)).

## Setup

### 1. Point Open WebUI at the proxy

Environment variables (first boot; see `env.example` in this directory):

```bash
OPENAI_API_BASE_URL=http://127.0.0.1:8096/codebuddy/default
OPENAI_API_KEY=sk-mem-...        # your business user key
TASK_MODEL_EXTERNAL=claude-sonnet-4-20250514      # optional: title / follow-up generation via the proxy
```

Or configure the same values in the UI: **Admin Panel → Settings → Connections → OpenAI API** — set the URL and key, then press the verify button.

### 2. Align the model id

The proxy exposes one upstream model per space: its ID **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The example uses `claude-sonnet-4-20250514`; change it if your proxy targets a different upstream. `TASK_MODEL_EXTERNAL` should use the same ID so background tasks also flow through memory.

### 3. Verify

1. Start (or restart) Open WebUI; open a new chat.
2. Select the model served by the connection in the model picker.
3. Send a first message. The proxy triggers the session picker in the chat interaction: choose your **Team → Agent → Task**.
4. From this turn on, memory for the bound agent is injected automatically. Ask the assistant what it remembers from previous sessions to confirm.

## Configuration reference

| Item | Value | Notes |
|---|---|---|
| `OPENAI_API_BASE_URL` | `http://127.0.0.1:8096/codebuddy/default` | Proxy endpoint; trailing `default` is the memory space ID — change it per space |
| `OPENAI_API_KEY` | `sk-mem-...` | Business user key; sent as `Authorization: Bearer` |
| `TASK_MODEL_EXTERNAL` | `claude-sonnet-4-20250514` | Optional: model for title / follow-up generation through the proxy |
| Persistence | PersistentConfig | First-boot env values are stored in the DB; later changes go through **Admin Panel → Settings** |
| UI equivalent | Admin Panel → Settings → Connections | Same fields as the env vars |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Connection check fails | Verify the URL includes the full space path (`/codebuddy/default`) and the key is a business user key (`sk-mem-...`), not the admin key |
| `404` / connection refused (Docker) | The proxy runs on the host — use `host.docker.internal` instead of `127.0.0.1` in `OPENAI_API_BASE_URL`, with `--add-host=host.docker.internal:host-gateway` |
| Env changes have no effect | `OPENAI_API_BASE_URL` is a PersistentConfig value — once stored, update it in **Admin Panel → Settings → Connections** |
| No models listed for the connection | The model list comes from the connection's models endpoint; if your proxy build does not serve it, register the model manually (Admin Panel → Models) with ID = `PROXY_UPSTREAM_MODEL` |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a chat already bound a task, the binding is reused — start a new chat to re-pick |

## Notes

- **Chat-first surface**: Open WebUI is a conversational UI, so the adapter turns the memory proxy into a team-memory chatbot — every conversation is captured as L0 dialogue and gets L2/L3 injection.
- **Background tasks**: with `TASK_MODEL_EXTERNAL` set, auto-titles and follow-up suggestions also flow through the proxy and land in memory.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
