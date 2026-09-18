# TencentDB Agent Memory — Text Generator Adapter

Give [Text Generator](https://github.com/nhaouari/obsidian-textgenerator-plugin) (the Obsidian AI text-generation plugin) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every generation automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
Text Generator ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                                 │
                                                 ├─ auth        (validates sk-mem-... user_key)
                                                 ├─ sessionInit (Team/Agent/Task picker)
                                                 └─ injection   (L2/L3 memory + skills + knowledge)
```

Text Generator has a **Custom** LLM provider whose defaults are already an OpenAI chat-completions request: the endpoint is a full URL (default `https://api.openai.com/v1/chat/completions`), the API key is injected as `Authorization: Bearer`, and the request body carries the model name (verified in source: `src/LLMProviders/custom/base.tsx` + `custom.tsx` — endpoint, header template, and body template are all editable fields). Pointing the endpoint at the proxy's `/codebuddy/<spaceId>/v1/chat/completions` route connects it — **no code changes required**.

**Session binding** (an interactive Team → Agent → Task picker on first message), **memory injection** (the bound agent's L2/L3 memory, skills and knowledge blended into the system prompt every turn) and **automatic capture** (L0 raw dialogue persisted into memory-core) all work with no code changes.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. The [Text Generator](https://github.com/nhaouari/obsidian-textgenerator-plugin) plugin is installed in your vault (Community Plugins → Browse → "Text Generator").

## Setup

### 1. Configure the Custom provider

In Obsidian, open **Text Generator → Settings → Providers** and add (or edit) a provider of type **Custom**, then set:

- **Endpoint**: `http://127.0.0.1:8096/codebuddy/default/v1/chat/completions` — replace `default` with your memory space ID if you use another space. This is the **full** request URL: Text Generator's custom provider takes a complete chat-completions endpoint, exactly like its OpenAI default.
- **API Key**: your business user key (`sk-mem-...`) — it is injected into the default header template as `Authorization: Bearer {{api_key}}`.
- **Model**: your proxy's `PROXY_UPSTREAM_MODEL` value (e.g. `claude-sonnet-4-20250514`). It **must match** the proxy's upstream model, otherwise the proxy rejects with an upstream mismatch.

Leave the default header/body templates as they are — they already produce a standard OpenAI chat-completions request.

### 2. Verify

1. Open a note, run a Text Generator command (e.g. *Generate & Insert*) with the Custom provider active.
2. The proxy triggers the session picker in the chat interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Generate something that leans on earlier conversations to confirm.

## Configuration reference

| Field | Value | Notes |
|---|---|---|
| Endpoint | `http://127.0.0.1:8096/codebuddy/default/v1/chat/completions` | **Full** request URL; `default` is the memory space ID — change it per space |
| API Key | `sk-mem-...` | Business user key from the Panel; injected as `Authorization: Bearer` via the header template |
| Model | `PROXY_UPSTREAM_MODEL` value (e.g. `claude-sonnet-4-20250514`) | Must equal the proxy's upstream model; free-text field, no model listing required |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401` / "Invalid API Key" | The key must be a business user key (`sk-mem-...`) from the Panel — not the admin key from `./.admin-key` |
| "Network request failed — this is usually a CORS error" | Obsidian's renderer follows browser CORS rules — enable the **CORS Bypass** option in the provider settings (the plugin ships its own bypass proxy for this) |
| Empty AI responses / upstream mismatch | Model differs from `PROXY_UPSTREAM_MODEL` — align them |
| `404` on every request | The endpoint must be the **full** URL including `/v1/chat/completions`; a bare host or base URL will 404 |
| Connection refused | Proxy not running on `:8096` — check `./start-all.sh` logs and `PROXY_UPSTREAM_*` env vars |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new chat to re-pick |

## Notes

- **Vault-local config**: the endpoint and key live only in your plugin settings, never in a committed file; this adapter therefore ships docs only (same as the LobeChat / Open WebUI / Obsidian Copilot adapters).
- **All generations flow through it**: every Text Generator template and command that uses the Custom provider gets memory injection.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
