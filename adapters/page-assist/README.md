# TencentDB Agent Memory — Page Assist Adapter

Give [Page Assist](https://github.com/n4ze3m/page-assist) persistent team memory. This adapter routes the extension's LLM traffic through the TencentDB Agent Memory proxy, so every sidebar or web-UI chat automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
Page Assist ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                             │
                                             ├─ auth        (validates sk-mem-... user_key)
                                             ├─ sessionInit (Team/Agent/Task picker)
                                             └─ injection   (L2/L3 memory + skills + knowledge)
```

Page Assist supports **OpenAI Compatible API** endpoints: in Settings → **OpenAI Compatible API** you can add a **Custom** provider with your own API URL and API key ([official provider docs](https://github.com/n4ze3m/page-assist/blob/main/docs/providers/openai.md)). The extension drives custom providers with an OpenAI chat client that appends `/chat/completions` to the configured API URL (verified in source: `src/models/CustomChatOpenAI.ts` builds the client from the provider's `baseUrl`). Pointing that URL at the proxy's `/codebuddy/<spaceId>/v1` endpoint connects it — **no code changes required**.

**Session binding** (an interactive Team → Agent → Task picker on first message), **memory injection** (the bound agent's L2/L3 memory, skills and knowledge blended into the system prompt every turn) and **automatic capture** (L0 raw dialogue persisted into memory-core) all work with no code changes.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. The [Page Assist](https://github.com/n4ze3m/page-assist) extension is installed in your browser (Chrome / Edge / Brave / Firefox).

## Setup

### 1. Add the proxy as a custom provider

1. Click the Page Assist icon in the browser toolbar, then the **Settings** icon.
2. Go to the **OpenAI Compatible API** tab.
3. Click **Add Provider** and select **Custom** from the dropdown.
4. Enter:
   - **API URL**: `http://127.0.0.1:8096/codebuddy/default/v1` — replace `default` with your memory space ID if you use another space. Keep the trailing `/v1`: the extension's OpenAI client appends `/chat/completions` to the API URL, which lands exactly on the proxy's `/codebuddy/<spaceId>/v1/chat/completions` route.
   - **API Key**: your business user key (`sk-mem-...`).
5. Click **Save**.

### 2. Add the model

Custom providers don't auto-discover models (only the Ollama / LM Studio / Llamafile presets do), so add the model manually in the same tab:

- **Model ID**: your proxy's `PROXY_UPSTREAM_MODEL` value (e.g. `claude-sonnet-4-20250514`). It **must match** the proxy's upstream model, otherwise the proxy rejects with an upstream mismatch.

### 3. Verify

1. Open the Page Assist sidebar (or web UI) and pick the proxy model.
2. Send a first message. The proxy triggers the session picker in the chat interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask Page Assist what it remembers from previous conversations to confirm.

## Configuration reference

| Field | Value | Notes |
|---|---|---|
| API URL | `http://127.0.0.1:8096/codebuddy/default/v1` | Proxy endpoint; `default` is the memory space ID — change it per space; **keep** the trailing `/v1` |
| API Key | `sk-mem-...` | Business user key from the Panel; sent as `Authorization: Bearer` |
| Model ID | `PROXY_UPSTREAM_MODEL` value (e.g. `claude-sonnet-4-20250514`) | Must equal the proxy's upstream model |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401` / "Invalid API Key" | The key must be a business user key (`sk-mem-...`) from the Panel — not the admin key from `./.admin-key` |
| Requests blocked by the browser | The provider settings include a **Fix CORS** option (the extension otherwise follows browser CORS rules); toggle it if the sidebar can't reach `127.0.0.1:8096` |
| Empty AI responses / upstream mismatch | Model ID differs from `PROXY_UPSTREAM_MODEL` — align them |
| Model list empty | Expected for Custom providers — add the model ID manually (only Ollama / LM Studio / Llamafile presets auto-fetch) |
| `404` / connection refused | Proxy not running on `:8096` — check `./start-all.sh` logs and `PROXY_UPSTREAM_*` env vars |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new chat to re-pick |

## Notes

- **Browser-local config**: the provider and key live only in the extension's local storage, never in a committed file; this adapter therefore ships docs only (same as the LobeChat / Open WebUI / LibreChat adapters).
- **All chats flow through it**: every sidebar chat and web-UI conversation that uses the configured model gets memory injection.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
