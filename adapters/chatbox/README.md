# TencentDB Agent Memory — Chatbox Adapter

Give [Chatbox](https://chatboxai.app/) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every conversation automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
Chatbox ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                        │
                                        ├─ auth        (validates sk-mem-... user_key)
                                        ├─ sessionInit (Team/Agent/Task picker)
                                        └─ injection   (L2/L3 memory + skills + knowledge)
```

Chatbox (the cross-platform desktop/mobile AI client) supports custom providers with the **OpenAI API Compatible** API type: you supply an **API Host** plus **API Key**, and Chatbox appends the API path itself (defaulting to `/v1/chat/completions`) — see the [official model configuration guide](https://docs.chatboxai.app/en/guides/providers). Pointing the API Host at the proxy's `/codebuddy/<spaceId>` endpoint connects it — **no code changes required**, and the default API path lands exactly on the proxy's canonical route.

**Session binding** (an interactive Team → Agent → Task picker on first message), **memory injection** (the bound agent's L2/L3 memory, skills and knowledge blended into the system prompt every turn) and **automatic capture** (L0 raw dialogue persisted into memory-core) all work with no code changes.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. Chatbox is installed — download from [chatboxai.app](https://chatboxai.app/) (Windows / macOS / Linux / Android / iOS).

## Setup

### 1. Register the proxy as a custom provider

1. Open **Settings** (gear icon in the sidebar) and go to the **Model** tab.
2. In **Model Provider**, click **Add** (or pick **OpenAI API Compatible** if listed).
3. Fill in:
   - **API type**: `OpenAI API Compatible`
   - **API Key**: your business user key (`sk-mem-...`)
   - **API Host**: `http://127.0.0.1:8096/codebuddy/default`
     (replace `default` with your memory space ID if you use another space)
   - **API path**: leave the default `/v1/chat/completions` — Chatbox appends it to the host, which lands exactly on the proxy's canonical route
4. Add a model with the name `claude-sonnet-4-20250514`.
5. Save and click **Check** — it should report a successful connection.

### 2. Align the model name

The model name **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The example uses `claude-sonnet-4-20250514`; change it if your proxy targets a different upstream.

### 3. Verify

1. Return to the home page, create a new conversation, and select the custom model.
2. Send a first message. The proxy triggers the session picker in the chat interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask Chatbox what it remembers from previous conversations to confirm.

## Configuration reference

| Field (custom provider) | Value | Notes |
|---|---|---|
| API type | `OpenAI API Compatible` | OpenAI Chat Completions protocol |
| API Key | `sk-mem-...` | Business user key from the Panel; sent as `Authorization: Bearer` |
| API Host | `http://127.0.0.1:8096/codebuddy/default` | Proxy endpoint; `default` is the memory space ID — change it per space; root only, no `/v1` and no API path |
| API path | `/v1/chat/completions` (default) | Appended by Chatbox — matches the proxy's canonical route, no change needed |
| Model name | `claude-sonnet-4-20250514` | Must equal `PROXY_UPSTREAM_MODEL`, otherwise the proxy rejects with an upstream mismatch |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Invalid API Key" / check fails | The key must be a business user key (`sk-mem-...`) from the Panel — not the admin key from `./.admin-key` |
| `404` | API Host must be the root endpoint only — exactly `http://<host>:8096/codebuddy/<spaceId>`, without `/v1` and without an API path |
| "Model Not Found" / upstream mismatch | Model name differs from `PROXY_UPSTREAM_MODEL` — align them |
| Connection refused | Proxy not running on `:8096` — check `./start-all.sh` logs and `PROXY_UPSTREAM_*` env vars |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new conversation to re-pick |

## Notes

- **UI-configured**: Chatbox stores provider profiles (including the API key) in its local app storage, so the key never lands in workspace files; this adapter therefore ships docs only (same as the Open WebUI / LobeChat adapters).
- **Every conversation flows through it**: all chats using the custom model get memory injection — across desktop and mobile clients sharing the same provider config.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
