# TencentDB Agent Memory — Void Adapter

Give [Void](https://github.com/voideditor/void) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every session automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
Void ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                    │
                                    ├─ auth        (validates sk-mem-... user_key)
                                    ├─ sessionInit (Team/Agent/Task picker)
                                    └─ injection   (L2/L3 memory + skills + knowledge)
```

Void (the open-source AI editor, a VS Code fork) ships an **OpenAI-Compatible** provider in its AI settings whose `baseURL` accepts any OpenAI-compatible endpoint. Pointing it at the proxy's `/codebuddy/<spaceId>` endpoint connects it — **no code changes required**.

**Session binding** (an interactive Team → Agent → Task picker on first message), **memory injection** (the bound agent's L2/L3 memory, skills and knowledge blended into the system prompt every turn) and **automatic capture** (L0 raw dialogue persisted into memory-core) all work with no code changes.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. Void is installed — download from [voideditor.com](https://voideditor.com) or build from [voideditor/void](https://github.com/voideditor/void).

## Setup

### 1. Register the proxy as an OpenAI-Compatible provider

1. Open **Settings** (gear icon in the lower-left corner) → **AI Settings**.
2. Under providers, select **OpenAI-Compatible**.
3. Fill in:
   - **API Key**: your business user key (`sk-mem-...`)
   - **baseURL**: `http://127.0.0.1:8096/codebuddy/default`
     (replace `default` with your memory space ID if you use another space)
   - Do **not** append `/chat/completions` — Void adds the request path itself (the baseURL field is documented in Void's settings as "do not include /chat/completions")
4. Under **Models**, click **Add Model** and enter the model ID `claude-sonnet-4-20250514`.

### 2. Align the model ID

The model ID **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The example uses `claude-sonnet-4-20250514`; change it if your proxy targets a different upstream.

### 3. Select the model for Void's features

In the model selection dropdowns, pick the custom model for **Chat** (sidebar, `Ctrl+L` / `Cmd+L`), **Ctrl+K** inline edits and **Apply**. Autocomplete requires Fill-in-the-Middle models — leave it on its own provider.

### 4. Verify

1. Open the chat sidebar (`Ctrl+L` / `Cmd+L`) with the custom model selected.
2. Send a first chat message. The proxy triggers the session picker in the chat interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask Void what it remembers from previous sessions to confirm.

## Configuration reference

| Field (OpenAI-Compatible provider) | Value | Notes |
|---|---|---|
| API Key | `sk-mem-...` | Business user key from the Panel; sent as `Authorization: Bearer` |
| baseURL | `http://127.0.0.1:8096/codebuddy/default` | Proxy endpoint; `default` is the memory space ID — change it per space; no `/chat/completions` suffix |
| Model ID | `claude-sonnet-4-20250514` | Must equal `PROXY_UPSTREAM_MODEL`, otherwise the proxy rejects with an upstream mismatch |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401` / "Invalid API Key" | The key must be a business user key (`sk-mem-...`) from the Panel — not the admin key from `./.admin-key` |
| `404` | baseURL typo — it must be exactly `http://<host>:8096/codebuddy/<spaceId>` with no path suffix appended |
| "Model Not Found" / upstream mismatch | Model ID differs from `PROXY_UPSTREAM_MODEL` — align them |
| Connection refused | Proxy not running on `:8096` — check `./start-all.sh` logs and `PROXY_UPSTREAM_*` env vars |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new task to re-pick |

## Notes

- **UI-configured**: Void stores provider settings (including the API key, encrypted) in its own settings storage, so the key never lands in workspace files; this adapter therefore ships docs only (same as the Kilo Code / Trae adapters).
- **Chat / Ctrl+K / Apply flow through it**: each feature set to the custom model gets memory injection; Autocomplete stays on its dedicated FIM provider.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
