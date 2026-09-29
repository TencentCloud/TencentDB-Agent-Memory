# TencentDB Agent Memory — Witsy Adapter

Give [Witsy](https://github.com/Kochava-Studios/witsy) persistent team memory. Witsy is a desktop AI assistant / universal MCP client (Windows, macOS, Linux) for chat, agents, commands and MCP servers. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every chat, agent run and command gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
Witsy ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                        │
                                        ├─ auth        (validates sk-mem-... user_key)
                                        ├─ sessionInit (Team/Agent/Task picker)
                                        └─ injection   (L2/L3 memory + skills + knowledge)
```

Witsy supports **custom LLM engines** with either an OpenAI or Azure API specification (Create Engine dialog). For an OpenAI-spec engine it instantiates the official OpenAI SDK client with the engine's `apiKey` and `baseURL` (verified in source: `src/renderer/services/llms/base.ts` — `igniteCustomEngine` → `new llm.OpenAI({ apiKey, baseURL })` via the [multi-llm-ts](https://github.com/nbonamy/multi-llm-ts) provider, which calls `client.chat.completions.create()` — i.e. `POST <baseURL>/chat/completions`). Pointing `baseURL` at the proxy's `/codebuddy/<spaceId>/v1` endpoint connects it — **no code changes required**.

The chat-model field is a free-text combobox: a manually typed model id is saved into the engine's model list (verified in source: `src/renderer/settings/SettingsCustomLLM.vue` — `save()` adds the typed model when it is not in the list), so no model-listing endpoint is involved.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. Witsy is installed (from the [releases](https://github.com/Kochava-Studios/witsy/releases) — Windows installer, macOS DMG or AppImage) and started once.

## Setup

### 1. Create the engine pointing at the proxy

In Witsy, create a new custom engine (Create Engine dialog — reachable from the model selector / engine settings):

- **API specification** — `OpenAI`
- **Name** — anything you like, e.g. `TencentDB Memory`
- **API Base URL** — `http://127.0.0.1:8096/codebuddy/default/v1`
- **API Key** — your `sk-mem-...` business user key

Replace `default` with your memory space ID if you use another space. Keep the trailing `/v1`: the client appends `/chat/completions` to the base URL, which lands exactly on the proxy's `/codebuddy/<spaceId>/v1/chat/completions` route.

### 2. Set the chat model manually

Witsy tries to fetch the model list after you enter the API key (`GET <baseURL>/models`), but the proxy does not expose a model-listing endpoint — the list stays empty. That is expected: the chat-model field is a free-text combobox, so **type the model id manually** in the engine settings (Chat Model), e.g. `claude-sonnet-4-20250514`. The typed value is saved into the engine's model list automatically.

The model id **must match** the proxy's `PROXY_UPSTREAM_MODEL` value, otherwise the proxy rejects with an upstream mismatch.

### 3. Chat and verify

1. Select the engine and model in the chat model picker.
2. Send a first message. The proxy triggers the session picker in the chat interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask Witsy what it remembers from previous conversations to confirm.

## Configuration reference

| Field | Value | Notes |
|---|---|---|
| API specification | `OpenAI` | The Azure variant is not used here |
| Name | `TencentDB Memory` (any) | Shown in the engine/model pickers |
| API Base URL | `http://127.0.0.1:8096/codebuddy/default/v1` | Proxy endpoint; `default` is the memory space ID — change it per space; keep the trailing `/v1` |
| API Key | `sk-mem-...` | Business user key from the Panel |
| Chat Model | `PROXY_UPSTREAM_MODEL` value (e.g. `claude-sonnet-4-20250514`) | Typed manually — typed values are persisted by the settings screen |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Model list stays empty after entering the key | Expected — the proxy exposes no `GET /v1/models` route; type the model id manually in the Chat Model field |
| `401` / "Invalid API Key" | The key must be a business user key (`sk-mem-...`) from the Panel — not the admin key from `./.admin-key` |
| Empty responses / upstream mismatch | Model id differs from `PROXY_UPSTREAM_MODEL` — align the Chat Model entry |
| Connection refused | Proxy not running on `:8096` — check `./start-all.sh` logs and `PROXY_UPSTREAM_*` env vars |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new chat to re-pick |

## Notes

- **User-local config**: engines live only in Witsy's local settings store, never in a committed file; this adapter therefore ships docs only (same as the LobeChat / Open WebUI / LibreChat / aichat adapters).
- **All surfaces flow through it**: chat, agents, commands and anything using the engine's model get memory injection.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
