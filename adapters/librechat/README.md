# TencentDB Agent Memory — LibreChat Adapter

Give [LibreChat](https://github.com/danny-avila/LibreChat) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every session automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
LibreChat ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                       │
                                       ├─ auth        (validates sk-mem-... user_key)
                                       ├─ sessionInit (Team/Agent/Task picker)
                                       └─ injection   (L2/L3 memory + skills + knowledge)
```

[LibreChat](https://github.com/danny-avila/LibreChat) supports OpenAI-compatible services as **custom endpoints** in `librechat.yaml` ([official docs](https://www.librechat.ai/docs/quick_start/custom_endpoints)): a `endpoints.custom` entry with `baseURL` pointing at the proxy's `/codebuddy/<spaceId>` endpoint turns it into a memory-aware chat endpoint — no code changes required.


**Session binding** (an interactive Team → Agent → Task picker on first message), **memory injection** (the bound agent's L2/L3 memory, skills and knowledge blended into the system prompt every turn) and **automatic capture** (L0 raw dialogue persisted into memory-core) all work with no code changes.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. LibreChat is running (Docker or npm per [www.librechat.ai/docs](https://www.librechat.ai/docs)).

## Setup

### 1. Add the custom endpoint

Copy `librechat.example.yaml` from this directory to the LibreChat project root as `librechat.yaml` (or merge the `endpoints.custom` entry into your existing config). Add the key to `.env`:

```bash
TDB_MEM_USER_KEY=sk-mem-...     # your business user key
```

The `.${TDB_MEM_USER_KEY}` reference keeps the key out of version control.

### 2. Mount the config (Docker only)

Ensure `docker-compose.override.yml` mounts the file:

```yaml
services:
  api:
    volumes:
      - type: bind
        source: ./librechat.yaml
        target: /app/librechat.yaml
```

### 3. Align the model id

`models.default[0]` **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The example uses `claude-sonnet-4-20250514`; change it if your proxy targets a different upstream. Keep `fetch: false` unless your proxy build serves a models-list endpoint.

### 4. Verify

1. Restart: `docker compose down && docker compose up -d` (or restart `npm run backend`).
2. **TencentDB Agent Memory** appears in the endpoint selector dropdown — select it and the model.
3. Send a first message. The proxy triggers the session picker in the chat interaction: choose your **Team → Agent → Task**.
4. From this turn on, memory for the bound agent is injected automatically. Ask the assistant what it remembers from previous sessions to confirm.

## Configuration reference

| Item | Value | Notes |
|---|---|---|
| `endpoints.custom[].name` | `TencentDB Agent Memory` | Shown in the endpoint selector dropdown |
| `baseURL` | `http://127.0.0.1:8096/codebuddy/default` | Proxy endpoint; trailing `default` is the memory space ID — change it per space |
| `apiKey` | `${TDB_MEM_USER_KEY}` | Env-var reference resolved from `.env`; holds the `sk-mem-...` business user key |
| `models.default[0]` | `claude-sonnet-4-20250514` | Must equal `PROXY_UPSTREAM_MODEL`, otherwise the proxy rejects with an upstream mismatch |
| `models.fetch` | `false` | Only enable if your proxy build serves a models-list endpoint |
| `titleConvo` | `false` | Optional: auto-title generation issues extra calls through the proxy |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Endpoint missing from the selector | Check `docker compose logs api` — usually YAML syntax errors, a missing `.env` entry, or `librechat.yaml` not mounted in Docker |
| `401` from proxy | Wrong or missing key — `TDB_MEM_USER_KEY` in `.env` must hold a business user key (`sk-mem-...`), not the admin key |
| `404` / connection refused | Proxy not running on `:8096`, or `baseURL` typo — check `./start-all.sh` logs |
| Model mismatch error | `models.default[0]` differs from `PROXY_UPSTREAM_MODEL` — align them |
| Title generation errors | Set `titleConvo: false` (as in the example) or point `titleModel` at the same proxy model |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a conversation already bound a task, the binding is reused — start a new conversation to re-pick |

## Notes

- **Chat-first surface**: LibreChat is a conversational UI, so the adapter turns the memory proxy into a team-memory chatbot — every conversation is captured as L0 dialogue and gets L2/L3 injection.
- **Multi-user safe**: LibreChat keeps per-user UI auth; the proxy key lives server-side in `.env`, and each user picks their Team → Agent → Task binding in the first message.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
