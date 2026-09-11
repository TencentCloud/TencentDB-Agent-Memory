# TencentDB Agent Memory — Obsidian Copilot Adapter

Give [Obsidian Copilot](https://github.com/logancyang/obsidian-copilot) persistent team memory. This adapter routes the plugin's LLM traffic through the TencentDB Agent Memory proxy, so every conversation automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
Obsidian Copilot ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                                 │
                                                 ├─ auth        (validates sk-mem-... user_key)
                                                 ├─ sessionInit (Team/Agent/Task picker)
                                                 └─ injection   (L2/L3 memory + skills + knowledge)
```

Obsidian Copilot's **BYOK** (bring your own key) settings support adding a **custom provider** backed by any OpenAI-compatible endpoint — the plugin drives it with a generic OpenAI chat client that appends `/chat/completions` to the configured Base URL ([official LLM providers docs](https://github.com/logancyang/obsidian-copilot/blob/master/docs/llm-providers.md)). Pointing that Base URL at the proxy's `/codebuddy/<spaceId>/v1` endpoint connects it — **no code changes required**.

**Session binding** (an interactive Team → Agent → Task picker on first message), **memory injection** (the bound agent's L2/L3 memory, skills and knowledge blended into the system prompt every turn) and **automatic capture** (L0 raw dialogue persisted into memory-core) all work with no code changes.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. The [Obsidian Copilot](https://github.com/logancyang/obsidian-copilot) plugin is installed in your vault (Community Plugins → Browse → "Copilot").

## Setup

### 1. Add the proxy as a custom provider

1. Open Obsidian → **Settings → Copilot → BYOK**.
2. Click **Add a provider** and choose **Add a custom provider**.
3. Fill in:
   - **Base URL**: `http://127.0.0.1:8096/codebuddy/default/v1` — replace `default` with your memory space ID if you use another space. Keep the trailing `/v1`: the plugin's OpenAI client appends `/chat/completions` to the Base URL, which lands exactly on the proxy's `/codebuddy/<spaceId>/v1/chat/completions` route.
   - **API key**: your business user key (`sk-mem-...`).
4. For the model, enter your proxy's `PROXY_UPSTREAM_MODEL` value (e.g. `claude-sonnet-4-20250514`) as an exact model ID. Model discovery queries `<Base URL>/models`; if your proxy deployment does not serve the model-list endpoint, type the model ID directly instead of relying on discovery.
5. Click **Test**, then **Save**.

### 2. Enable the model for chat

New models are enabled for Quick Chat by default; verify under **Settings → Copilot → Basic → Agents → Quick Chat** that the proxy model appears and, if you use it often, set it as the **Default model**.

### 3. Verify

1. Open the Copilot chat pane, pick the proxy model, and send a first message.
2. The proxy triggers the session picker in the chat interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask Copilot what it remembers from previous conversations to confirm.

## Configuration reference

| Field | Value | Notes |
|---|---|---|
| Base URL | `http://127.0.0.1:8096/codebuddy/default/v1` | Proxy endpoint; `default` is the memory space ID — change it per space; **keep** the trailing `/v1` |
| API key | `sk-mem-...` | Business user key from the Panel; sent as `Authorization: Bearer` |
| Model ID | `PROXY_UPSTREAM_MODEL` value (e.g. `claude-sonnet-4-20250514`) | Must equal the proxy's upstream model, otherwise the proxy rejects with an upstream mismatch |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401` / "Invalid API Key" | The key must be a business user key (`sk-mem-...`) from the Panel — not the admin key from `./.admin-key` |
| Test succeeds but Quick Chat cannot send a message | Obsidian's renderer applies browser CORS rules — edit the provider and turn on **Enable CORS** (responses then arrive after completion instead of streaming) |
| Model discovery finds nothing | Enter the exact model ID manually — discovery needs the `/models` listing endpoint, which the proxy does not require |
| Empty AI responses / upstream mismatch | Model name differs from `PROXY_UPSTREAM_MODEL` — align them |
| `404` / connection refused | Proxy not running on `:8096` — check `./start-all.sh` logs and `PROXY_UPSTREAM_*` env vars |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new chat to re-pick |

## Notes

- **Vault-local config**: the provider and key live only in your Obsidian plugin settings (`data.json` of the vault), never in a committed file; this adapter therefore ships docs only (same as the LobeChat / Open WebUI / LibreChat adapters).
- **All chats flow through it**: every chat (and agent feature) that uses the configured model gets memory injection.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
