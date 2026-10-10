# TencentDB Agent Memory — gp.nvim Adapter

Give [gp.nvim](https://github.com/Robitx/gp.nvim) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every session automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
gp.nvim ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                         │
                                         ├─ auth        (validates sk-mem-... user_key)
                                         ├─ sessionInit (Team/Agent/Task picker)
                                         └─ injection   (L2/L3 memory + skills + knowledge)
```

gp.nvim supports any "OpenAI chat/completions" compatible endpoint through its `providers` table — each entry declares an `endpoint` (the **full chat completions URL**) and a `secret` (an API key, an `os.getenv` call, or a command that prints one), and an agent selects the provider by name ([official README](https://github.com/Robitx/gp.nvim#multiple-providers); the built-in `ollama` entry — `endpoint = "http://localhost:11434/v1/chat/completions"` — is the canonical local-endpoint example). Pointing `endpoint` at the proxy's `/codebuddy/<spaceId>/v1/chat/completions` route connects it — **no code changes required**.

**Session binding**, **memory injection** and **automatic capture** all work with no code changes.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. gp.nvim is installed and loaded in Neovim via your plugin manager (see the [README](https://github.com/Robitx/gp.nvim# Installation)).

## Setup

### 1. Export the API key

```bash
export MEMORY_PROXY_API_KEY=sk-mem-xxxxxxxx   # your business user key
```

Neovim must inherit the variable — start it from that shell, or use `exec-path-from-shell` / `vim.fn` alternatives. The key is read with `os.getenv` in the config below, so it never lands in your dotfiles.

### 2. Declare the provider and an agent

In your gp.nvim setup, add a provider entry whose `endpoint` is the proxy's full chat completions URL, and an agent that uses it:

```lua
local conf = {
  providers = {
    tencentdb_memory = {
      endpoint = "http://127.0.0.1:8096/codebuddy/default/v1/chat/completions",
      secret = os.getenv("MEMORY_PROXY_API_KEY"),
    },
  },
  agents = {
    {
      name = "TencentDBMemory",
      provider = "tencentdb_memory",
      chat = true,
      command = true,
      model = { model = "claude-sonnet-4-20250514" },
      system_prompt = "You are a general assistant with persistent team memory.",
    },
  },
}
require("gp").setup(conf)
```

Replace `default` with your memory space ID if you use another space.

**Note**: unlike base-URL clients (which append `/chat/completions` themselves), gp.nvim's `endpoint` is the **complete URL** — including the `/v1/chat/completions` suffix, exactly like its built-in `ollama` entry.

### 3. Align the model name

The agent's `model.model` value **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The example uses `claude-sonnet-4-20250514`; change it if your proxy targets a different upstream.

### 4. Verify

1. Restart Neovim (or re-source your config) so the provider takes effect.
2. Open a gp.nvim chat (`:GpChatNew`) using the `TencentDBMemory` agent and send a first message. The proxy triggers the session picker in the chat interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask gp what it remembers from previous sessions to confirm.

## Configuration reference

| Field | Value | Notes |
|---|---|---|
| `providers.<name>.endpoint` | `http://127.0.0.1:8096/codebuddy/default/v1/chat/completions` | **Full URL** — gp.nvim posts to it verbatim; `default` is the memory space ID — change it per space |
| `providers.<name>.secret` | `os.getenv("MEMORY_PROXY_API_KEY")` | Env-var lookup; also accepts a string or a command table; sent as `Authorization: Bearer` |
| `agents[].provider` | `"tencentdb_memory"` | Links the agent to the provider entry (default `"openai"`) |
| `agents[].model.model` | `claude-sonnet-4-20250514` | Must equal `PROXY_UPSTREAM_MODEL`, otherwise the proxy rejects with an upstream mismatch |
| `agents[].chat` / `command` | `true` | Route both the chat and command workflows through the provider |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `404` / connection refused | `endpoint` must be the complete URL `http://<host>:8096/codebuddy/<spaceId>/v1/chat/completions` — check for a missing `/v1` or path typo, and that the proxy is running on `:8096` |
| "Invalid API Key" / auth failures | The key must be a business user key (`sk-mem-...`) from the Panel — not the admin key from `./.admin-key`; confirm `MEMORY_PROXY_API_KEY` is exported in the environment Neovim starts from |
| "Model Not Found" / upstream mismatch | `model.model` differs from `PROXY_UPSTREAM_MODEL` — align them |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new task to re-pick |
| Key resolves to `nil` | `os.getenv` runs inside Neovim — GUI Neovim does not inherit shell exports unless launched from that shell (`exec-path-from-shell` fixes it) |

## Notes

- **Docs-only adapter**: the provider lives in your own Neovim config, so the key never lands in workspace files; this adapter ships documentation only (same as the avante.nvim / codecompanion.nvim adapters).
- **Chat and command modes both flow through it**: agents with `chat = true` and `command = true` both use the selected provider, so each workflow gets memory injection.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
