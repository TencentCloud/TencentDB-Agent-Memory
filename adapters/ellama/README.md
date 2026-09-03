# TencentDB Agent Memory — Ellama Adapter

Give [Ellama](https://github.com/s-kostyaev/ellama) (the Emacs LLM assistant) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every session automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
Ellama ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                         │
                                         ├─ auth        (validates sk-mem-... user_key)
                                         ├─ sessionInit (Team/Agent/Task picker)
                                         └─ injection   (L2/L3 memory + skills + knowledge)
```

Ellama talks to models through the [llm](https://elpa.gnu.org/packages/llm.html) package, and "OpenAI-compatible" is one of its built-in provider choices ([Ellama README](https://github.com/s-kostyaev/ellama); `M-x ellama-select-model` lists it directly). The `llm-openai-compatible` provider takes a `:url` — the base URL **leading up to** the `chat/completions` command, with a trailing slash ([llm docs §3.2](https://elpa.gnu.org/packages/llm.html)) — plus `:chat-model` and `:key` (inherited from `llm-openai`, sent as `Authorization: Bearer`; verified in the [llm-openai.el source](https://github.com/ahyatt/llm)). Pointing `:url` at the proxy's `/codebuddy/<spaceId>/v1/` base connects it — **no code changes required**.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. Ellama is installed (`M-x package-install RET ellama RET`), which pulls in the `llm` package.

## Setup

### 1. Export the API key

```bash
export TDB_MEM_USER_KEY=sk-mem-xxxxxxxx   # your business user key
```

Emacs must inherit the variable — start it from that shell, or use `exec-path-from-shell`. Alternatively, keep the key in `auth-source` (see Notes) and read it there instead of `getenv`.

### 2. Configure the provider

Add to your Emacs init file:

```elisp
(require 'llm-openai-compatible)

(setopt ellama-provider
        (make-llm-openai-compatible
         :url "http://127.0.0.1:8096/codebuddy/default/v1/"
         :chat-model "claude-sonnet-4-20250514"
         :key (getenv "TDB_MEM_USER_KEY")))
```

Replace `default` with your memory space ID if you use another space.

**Note**: the `:url` is the base **including the trailing slash** — `llm` appends `chat/completions` itself, exactly like its documented example `https://api.openai.com/v1/` (llm docs §3.2). Do not add `chat/completions` to the URL.

### 3. Align the model name

The `:chat-model` value **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The example uses `claude-sonnet-4-20250514`; change it if your proxy targets a different upstream.

### 4. Verify

1. Restart Emacs / re-evaluate the config, then run `M-x ellama-chat` in any buffer.
2. Send a first prompt. The proxy triggers the session picker in the request interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask Ellama what it remembers from previous sessions to confirm.

## Configuration reference

| Item | Value | Notes |
|---|---|---|
| Provider constructor | `make-llm-openai-compatible` | From the `llm` package (`(require 'llm-openai-compatible)`) |
| `:url` | `http://127.0.0.1:8096/codebuddy/default/v1/` | Base URL **with trailing slash**; `llm` appends `chat/completions`; `default` is the memory space ID — change it per space |
| `:chat-model` | `claude-sonnet-4-20250514` | Must equal `PROXY_UPSTREAM_MODEL`, otherwise the proxy rejects with an upstream mismatch |
| `:key` | `(getenv "TDB_MEM_USER_KEY")` | `sk-mem-...` business user key; sent as `Authorization: Bearer` |
| `ellama-provider` | the provider above | All Ellama commands use it; extra named providers can go in `ellama-providers` |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `404` / wrong endpoint | `:url` must be the base with a trailing slash — `http://<host>:8096/codebuddy/<spaceId>/v1/` — no `chat/completions` suffix, no missing `/v1` |
| "Invalid API Key" / auth failures | The key must be a business user key (`sk-mem-...`) from the Panel — not the admin key from `./.admin-key`; confirm `TDB_MEM_USER_KEY` is exported in the environment Emacs starts from |
| "Model Not Found" / upstream mismatch | `:chat-model` differs from `PROXY_UPSTREAM_MODEL` — align them |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new task to re-pick |
| Key resolves to `nil` | GUI Emacs does not inherit shell exports — launch Emacs from the exporting shell or use `exec-path-from-shell` / `auth-source` |

## Notes

- **Docs-only adapter**: the provider lives in your own Emacs config, so the key never lands in version-controlled files; this adapter ships documentation only (same as the gptel adapter).
- **Interactive switching still works**: `M-x ellama-select-model` lists OpenAI-compatible as a built-in choice with URL editing, so you can also point a transient provider at the proxy without touching `ellama-provider`.
- **auth-source alternative**: store an entry like `machine 127.0.0.1 port 8096 login ellama password sk-mem-...` in `~/.authinfo.gpg` and read it via `(auth-source-search :host "127.0.0.1" :port "8096" :max 1)` instead of `getenv`.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
