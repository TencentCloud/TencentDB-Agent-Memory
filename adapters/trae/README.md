# TencentDB Agent Memory — Trae Adapter

Give [Trae](https://trae.ai/) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every session automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
Trae ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                    │
                                    ├─ auth        (validates sk-mem-... user_key)
                                    ├─ sessionInit (Team/Agent/Task picker)
                                    └─ injection   (L2/L3 memory + skills + knowledge)
```

Trae supports adding models through **自定义配置 (Custom Config)** with the **OpenAI Chat Completions** API format and a custom request URL ([official docs](https://docs.trae.ai/docs/models)). Pointing the request URL at the proxy's `/codebuddy/<spaceId>` endpoint connects it — **no code changes required**.

**Session binding** (an interactive Team → Agent → Task picker on first message), **memory injection** (the bound agent's L2/L3 memory, skills and knowledge blended into the system prompt every turn) and **automatic capture** (L0 raw dialogue persisted into memory-core) all work with no code changes.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. Trae (the AI IDE from ByteDance) is installed — download from [trae.ai](https://www.trae.ai/).

## Setup

### 1. Add the proxy as a custom model

1. Open **Settings** → **Model** to enter the model management panel.
2. Click **Add Model**.
3. Select **Custom Config** (自定义配置).
4. Fill in the dialog:
   - **API format**: `OpenAI Chat Completions`
   - **Custom request URL**: turn on the **Full URL** toggle and enter the complete endpoint
     `http://127.0.0.1:8096/codebuddy/default/v1/chat/completions`
     (replace `default` with your memory space ID if you use another space)
   - **Model ID**: `claude-sonnet-4-20250514`
   - **API key**: your business user key (`sk-mem-...`)
   - *(optional)* expand **Advanced Config** to set a display name and context-window limits
5. Click **Add Model**. Trae calls the provider to validate the API key — on success the model appears in the model list; on failure the error and provider logs are shown in the dialog.

### 2. Align the model ID

The model ID **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The example uses `claude-sonnet-4-20250514`; change it if your proxy targets a different upstream.

### 3. Verify

1. In the chat panel, click the current model name (bottom-right of the input box) and select the custom model.
2. Send a first chat message. The proxy triggers the session picker in the chat interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask Trae what it remembers from previous sessions to confirm.

## Configuration reference

| Field (Add Model → Custom Config) | Value | Notes |
|---|---|---|
| API format | `OpenAI Chat Completions` | OpenAI `/v1/chat/completions` protocol |
| Custom request URL (Full URL on) | `http://127.0.0.1:8096/codebuddy/default/v1/chat/completions` | Proxy endpoint; `default` is the memory space ID — change it per space |
| Model ID | `claude-sonnet-4-20250514` | Must equal `PROXY_UPSTREAM_MODEL`, otherwise the proxy rejects with an upstream mismatch |
| API key | `sk-mem-...` | Business user key from the Panel; sent as `Authorization: Bearer` |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Invalid API Key" / validation fails on add | The key must be a business user key (`sk-mem-...`) from the Panel — not the admin key from `./.admin-key`; check the provider logs shown in the dialog |
| "Model Not Found" / upstream mismatch | Model ID differs from `PROXY_UPSTREAM_MODEL` — align them |
| `404` / connection refused | Full URL typo or proxy not running on `:8096` — the URL must be `http://<host>:8096/codebuddy/<spaceId>/v1/chat/completions`; check `./start-all.sh` logs |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new task to re-pick |

## Notes

- **UI-configured**: Trae stores custom model profiles in its own settings storage, so the key never lands in workspace files; this adapter therefore ships docs only (same as the Kilo Code / Roo Code adapters).
- **Chat and agent modes both flow through it**: Trae's chat, inline completion and agent workflows all use the selected model, so each of them gets memory injection.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
