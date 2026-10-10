# TencentDB Agent Memory — codecompanion.nvim Adapter

Give [codecompanion.nvim](https://github.com/olimorris/codecompanion.nvim) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every session automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
codecompanion.nvim ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                                    │
                                                    ├─ auth        (validates sk-mem-... user_key)
                                                    ├─ sessionInit (Team/Agent/Task picker)
                                                    └─ injection   (L2/L3 memory + skills + knowledge)
```

codecompanion.nvim ships an `openai_compatible` adapter precisely for self-hosted and third-party OpenAI-compatible endpoints — you extend it with your `url`, `api_key` (environment variable name) and `chat_url` ([official docs — Configuring HTTP Adapters](https://codecompanion.olimorris.dev/configuration/adapters_http.html); the built-in llama.cpp example follows the same pattern). Pointing it at the proxy's `/codebuddy/<spaceId>` base connects it — **no code changes required**.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. codecompanion.nvim is installed in Neovim (0.10+) with its `plenary.nvim` and tree-sitter `markdown` / `markdown_inline` dependencies, as described in the [README](https://github.com/olimorris/codecompanion.nvim#installation).

## Setup

### 1. Export the API key

```bash
export MEMORY_PROXY_API_KEY=sk-mem-xxxxxxxx   # your business user key
```

The adapter's `env.api_key` names this environment variable; codecompanion reads it at request time.

### 2. Declare the adapter

In your setup, extend `openai_compatible` and select it as the strategy adapter:

```lua
require("codecompanion").setup({
  adapters = {
    http = {
      tencentdb_memory = function()
        return require("codecompanion.adapters").extend("openai_compatible", {
          env = {
            url = "http://127.0.0.1:8096/codebuddy/default",
            api_key = "MEMORY_PROXY_API_KEY",
            chat_url = "/v1/chat/completions",
          },
          schema = {
            model = { default = "claude-sonnet-4-20250514" },
          },
        })
      end,
    },
  },
  strategies = {
    chat = { adapter = "tencentdb_memory" },
    inline = { adapter = "tencentdb_memory" },
    cmd = { adapter = "tencentdb_memory" },
  },
})
```

Replace `default` with your memory space ID if you use another space.

### 3. Align the model ID

The `schema.model.default` value **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The example uses `claude-sonnet-4-20250514`; change it if your proxy targets a different upstream.

### 4. Verify

1. Restart Neovim (or re-source your config) so the adapter takes effect.
2. Open a chat buffer (`:CodeCompanionChat`) and send a first message. The proxy triggers the session picker in the chat interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask codecompanion what it remembers from previous sessions to confirm.

## Configuration reference

| Field (adapters.http entry) | Value | Notes |
|---|---|---|
| `env.url` | `http://127.0.0.1:8096/codebuddy/default` | Base URL without the chat path; `default` is the memory space ID — change it per space |
| `env.api_key` | `MEMORY_PROXY_API_KEY` | Name of the env var holding the `sk-mem-...` key; sent as `Authorization: Bearer` |
| `env.chat_url` | `/v1/chat/completions` | Appended to `env.url`; the default of `openai_compatible`, kept explicit for clarity |
| `schema.model.default` | `claude-sonnet-4-20250514` | Must equal `PROXY_UPSTREAM_MODEL`, otherwise the proxy rejects with an upstream mismatch |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `404` / connection refused | URL typo or proxy not running on `:8096` — the effective chat endpoint must be `http://<host>:8096/codebuddy/<spaceId>/v1/chat/completions` (`env.url` + `env.chat_url`); check `./start-all.sh` logs |
| "Invalid API Key" / authentication error | The key must be a business user key (`sk-mem-...`) from the Panel — not the admin key from `./.admin-key`; confirm the env var is exported in the environment Neovim starts from |
| "Model Not Found" / upstream mismatch | `schema.model.default` differs from `PROXY_UPSTREAM_MODEL` — align them |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new task to re-pick |

## Notes

- **Docs-only adapter**: the adapter lives in your own Neovim config, so the key never lands in workspace files; this adapter ships documentation only (same as the Kilo Code / Roo Code adapters).
- **Chat, inline and cmd strategies all flow through it**: point each `strategies` entry at the adapter and every interaction gets memory injection.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
