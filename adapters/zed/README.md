# TencentDB Agent Memory — Zed Adapter

Give the [Zed](https://zed.dev) editor's AI features persistent team memory. This adapter routes Zed's LLM traffic through the TencentDB Agent Memory proxy, so the Zed Agent, Inline Assistant and other model-backed features automatically get:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
Zed ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                      │
                                      ├─ auth        (validates sk-mem-... user_key)
                                      ├─ sessionInit (Team/Agent/Task picker)
                                      └─ injection   (L2/L3 memory + skills + knowledge)
```

Zed supports custom OpenAI-compatible providers under `language_models.openai_compatible` in `settings.json`. The proxy speaks OpenAI Chat Completions on its `/codebuddy/<spaceId>` endpoint, so Zed connects with **configuration only**.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. Zed is installed ([zed.dev/download](https://zed.dev/download)).

## Setup

### 1. Register the provider

Open Zed's settings file (`zed: open settings` in the command palette) and merge `settings.example.json` from this directory into your `settings.json`:

```json
{
  "language_models": {
    "openai_compatible": {
      "tencentdb-agent-memory": {
        "api_url": "http://127.0.0.1:8096/codebuddy/default",
        "custom_headers": { "x-tdai-service-id": "default" },
        "available_models": [
          {
            "name": "claude-sonnet-4-20250514",
            "display_name": "claude-sonnet-4 (via Memory Proxy)",
            "max_tokens": 200000,
            "max_output_tokens": 16384,
            "capabilities": { "tools": true, "images": false, "chat_completions": true }
          }
        ]
      }
    }
  }
}
```

Then adjust one field: the model `name` **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The default example uses `claude-sonnet-4-20250514`. `max_tokens` is the context window — align it with your upstream model.

### 2. Provide the API key

Zed derives an environment variable from the provider ID: **`tencentdb-agent-memory` → `TENCENTDB_AGENT_MEMORY_API_KEY`**. Either export it before launching Zed:

```bash
export TENCENTDB_AGENT_MEMORY_API_KEY="sk-mem-..."   # your business user key
```

…or run `agent: open settings` in Zed, add the provider there, and paste the key in the UI (stored in Zed's credential storage, never in `settings.json`).

### 3. Verify

1. Restart Zed (or reload), then open the assistant panel and pick the model **claude-sonnet-4 (via Memory Proxy)** under the `tencentdb-agent-memory` provider.
2. Send a first message. The proxy triggers the session picker: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask Zed what it remembers from previous sessions to confirm.

## Configuration reference

| Field | Value | Notes |
|---|---|---|
| `api_url` | `http://127.0.0.1:8096/codebuddy/default` | Proxy OpenAI-compatible endpoint; trailing `default` is the memory space ID — change it per space |
| `custom_headers` | `x-tdai-service-id: default` | Explicit service ID header for multi-space deployments (`Authorization` is managed by Zed) |
| `available_models[].name` | must equal `PROXY_UPSTREAM_MODEL` | Otherwise the proxy rejects the model with an upstream mismatch |
| `available_models[].max_tokens` | `200000` | Context window of the upstream model (Zed requires this field) |
| `capabilities.tools` | `true` | Zed Agent needs tool calls for agentic workflows |
| API key | `TENCENTDB_AGENT_MEMORY_API_KEY` env var or settings UI | Provider ID upper-snake-case + `_API_KEY` |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Provider not listed in assistant panel | `settings.json` doesn't parse or the block isn't under `language_models.openai_compatible` — check with `zed --foreground` logs |
| Model listed but auth fails | Key missing — export `TENCENTDB_AGENT_MEMORY_API_KEY` or add it via `agent: open settings` |
| `401` from proxy | Wrong key — confirm it is a business user key (`sk-mem-...`), not the admin key |
| `404` / connection refused | Proxy not running on `:8096` — check `./start-all.sh` logs and `PROXY_UPSTREAM_*` env vars |
| Model mismatch error | Selected model differs from `PROXY_UPSTREAM_MODEL` — align `available_models[].name` |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new assistant thread to re-pick |

## Notes

- **Scope**: this configures Zed-owned AI features (Zed Agent, Inline Assistant, commit generation). External agents and terminal threads manage their own model access.
- **Endpoint prefix**: reuses the proxy's OpenAI-compatible endpoint (`/codebuddy/<spaceId>`); when a dedicated prefix lands upstream, only `api_url` needs to change.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.
- **Version**: tested with Zed's `openai_compatible` settings schema (per the official LLM docs) and TencentDB Agent Memory v3 (`feat/server_team` branch, v2.0.0 images).

## License

MIT, same as the main repository.
