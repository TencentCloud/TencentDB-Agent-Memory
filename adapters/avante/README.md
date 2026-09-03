# TencentDB Agent Memory — avante.nvim Adapter

Give [avante.nvim](https://github.com/yetone/avante.nvim) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every session automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
avante.nvim ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                            │
                                            ├─ auth        (validates sk-mem-... user_key)
                                            ├─ sessionInit (Team/Agent/Task picker)
                                            └─ injection   (L2/L3 memory + skills + knowledge)
```

avante.nvim supports arbitrary OpenAI-compatible providers via its `providers` table — a custom entry inheriting from `openai` with an `endpoint` base URL and an `api_key_name` environment variable ([official README](https://github.com/yetone/avante.nvim#custom-providers); the built-in `moonshot` / `qwen` entries follow the same pattern in `lua/avante/config.lua`). Pointing `endpoint` at the proxy's `/codebuddy/<spaceId>/v1` base connects it — **no code changes required**.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. avante.nvim is installed and loaded in Neovim (0.10+) via your plugin manager, with its `render-markdown.nvim` / `nvim-web-devicons` dependencies as described in the [README](https://github.com/yetone/avante.nvim#installation).

## Setup

### 1. Export the API key

```bash
export MEMORY_PROXY_API_KEY=sk-mem-xxxxxxxx   # your business user key
```

avante resolves the key through `api_key_name`: it first tries the scoped `AVANTE_MEMORY_PROXY_API_KEY` and then the plain `MEMORY_PROXY_API_KEY` (see `lua/avante/providers/init.lua`), so either name works.

### 2. Declare the provider

In your avante setup (lazy.nvim shown), add a provider entry that inherits the OpenAI Chat Completions protocol and select it:

```lua
{
  "yetone/avante.nvim",
  opts = {
    provider = "tencentdb_memory",
    providers = {
      tencentdb_memory = {
        __inherited_from = "openai",
        endpoint = "http://127.0.0.1:8096/codebuddy/default/v1",
        model = "claude-sonnet-4-20250514",
        api_key_name = "MEMORY_PROXY_API_KEY",
      },
    },
  },
}
```

Replace `default` with your memory space ID if you use another space.

### 3. Align the model ID

The `model` value **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The example uses `claude-sonnet-4-20250514`; change it if your proxy targets a different upstream.

### 4. Verify

1. Restart Neovim (or re-source your config) so the provider takes effect.
2. Open an avante chat (`:AvanteAsk`) and send a first message. The proxy triggers the session picker in the chat interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask avante what it remembers from previous sessions to confirm.

## Configuration reference

| Field (providers entry) | Value | Notes |
|---|---|---|
| `__inherited_from` | `"openai"` | Uses the OpenAI Chat Completions request format |
| `endpoint` | `http://127.0.0.1:8096/codebuddy/default/v1` | Base URL; avante appends `/chat/completions`; `default` is the memory space ID — change it per space |
| `model` | `claude-sonnet-4-20250514` | Must equal `PROXY_UPSTREAM_MODEL`, otherwise the proxy rejects with an upstream mismatch |
| `api_key_name` | `MEMORY_PROXY_API_KEY` | Env var holding the `sk-mem-...` key; sent as `Authorization: Bearer` |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `404` / connection refused | Endpoint typo or proxy not running on `:8096` — the base must be `http://<host>:8096/codebuddy/<spaceId>/v1`; check `./start-all.sh` logs |
| "Invalid API Key" / login prompt loops | The key must be a business user key (`sk-mem-...`) from the Panel — not the admin key from `./.admin-key`; confirm the env var is exported in the environment Neovim starts from |
| "Model Not Found" / upstream mismatch | `model` differs from `PROXY_UPSTREAM_MODEL` — align them |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new task to re-pick |

## Notes

- **Docs-only adapter**: the provider lives in your own Neovim config, so the key never lands in workspace files; this adapter ships documentation only (same as the Kilo Code / Roo Code adapters).
- **Chat and agent modes both flow through it**: avante's ask, edit and agent workflows all use the selected provider, so each of them gets memory injection.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
