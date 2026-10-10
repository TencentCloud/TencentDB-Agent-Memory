# TencentDB Agent Memory — Kilo Code Adapter

Give [Kilo Code](https://github.com/Kilo-Org/kilocode) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every session automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
Kilo Code ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                       │
                                       ├─ auth        (validates sk-mem-... user_key)
                                       ├─ sessionInit (Team/Agent/Task picker)
                                       └─ injection   (L2/L3 memory + skills + knowledge)
```

[Kilo Code](https://github.com/Kilo-Org/kilocode) ships a **Custom provider** whose **Provider API** can be set to **OpenAI Compatible** ([official docs](https://kilocode.ai/docs/providers/openai-compatible)). Pointing its Base URL at the proxy's `/codebuddy/<spaceId>` endpoint connects it — **no code changes required**.


**Session binding** (an interactive Team → Agent → Task picker on first message), **memory injection** (the bound agent's L2/L3 memory, skills and knowledge blended into the system prompt every turn) and **automatic capture** (L0 raw dialogue persisted into memory-core) all work with no code changes.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. Kilo Code is installed in VS Code (search "Kilo Code" in the extension marketplace; see [kilocode.ai/docs](https://kilocode.ai/docs)).

## Setup

### 1. Register the proxy as a custom provider

1. Open **Settings** (gear icon) and go to the **Providers** tab.
2. Scroll to the bottom and click **Custom provider**.
3. Fill in the dialog:
   - **Provider ID**: `tdb-agent-memory`
   - **Display name**: `TencentDB Agent Memory`
   - **Provider API**: `OpenAI Compatible`
   - **Base URL**: `http://127.0.0.1:8096/codebuddy/default`
   - **API key**: your business user key (`sk-mem-...`)
   - **Models**: add a model whose ID is `claude-sonnet-4-20250514` — via automatic detection (Kilo queries the provider's models endpoint) or **Add model manually**
4. Click **Submit** to save; the provider's models appear in the model picker.

### 2. Align the model ID

The model ID **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The example uses `claude-sonnet-4-20250514`; change it if your proxy targets a different upstream. Token limits / tool-calling toggles for the entry can be refined in `kilo.jsonc` (Kilo's model config file) afterwards.

### 3. Verify

1. Open the Kilo Code panel and pick **TencentDB Agent Memory** + the model entry in the model picker.
2. Send a first chat message. The proxy triggers the session picker in the chat interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask Kilo Code what it remembers from previous sessions to confirm.

## Configuration reference

| Field (custom provider dialog) | Value | Notes |
|---|---|---|
| Provider API | `OpenAI Compatible` | Uses the OpenAI Chat Completions protocol |
| Base URL | `http://127.0.0.1:8096/codebuddy/default` | Proxy endpoint; trailing `default` is the memory space ID — change it per space |
| API key | `sk-mem-...` | Business user key from the Panel; sent as `Authorization: Bearer` |
| Model ID | `claude-sonnet-4-20250514` | Must equal `PROXY_UPSTREAM_MODEL`, otherwise the proxy rejects with an upstream mismatch |
| `kilo.jsonc` | optional | Refine context window / token limits for the added model entry |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Invalid API Key" | The key must be a business user key (`sk-mem-...`) from the Panel — not the admin key from `./.admin-key` |
| Auto model detection finds nothing | Detection needs the provider's models endpoint; if your proxy build does not serve it, use **Add model manually** with ID = `PROXY_UPSTREAM_MODEL` |
| "Model Not Found" / upstream mismatch | Model ID differs from `PROXY_UPSTREAM_MODEL` — align them |
| `404` / connection refused | Proxy not running on `:8096` — check `./start-all.sh` logs and `PROXY_UPSTREAM_*` env vars |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new task to re-pick |

## Notes

- **UI-configured**: Kilo Code stores custom provider profiles in VS Code's secret storage, so the key never lands in workspace files; this adapter therefore ships docs only (same as the Roo Code / Cline adapters).
- **Every mode flows through it**: Kilo Code modes (Orchestrator/Coder/Architect/Ask...) all use the selected provider, so each of them gets memory injection.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
