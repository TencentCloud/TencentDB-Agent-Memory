# TencentDB Agent Memory — Continue Adapter

Give [Continue](https://docs.continue.dev) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every session automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
Continue ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                       │
                                       ├─ auth        (validates sk-mem-... user_key)
                                       ├─ sessionInit (Team/Agent/Task picker)
                                       └─ injection   (L2/L3 memory + skills + knowledge)
```

[Continue](https://docs.continue.dev) supports OpenAI-compatible providers in `config.yaml` via `provider: openai` plus a custom `apiBase`. Pointing `apiBase` at the proxy's `/codebuddy/<spaceId>` endpoint routes chat/edit/apply through TencentDB Agent Memory — no code changes required.

**Session binding** (an interactive Team → Agent → Task picker on first message), **memory injection** (the bound agent's L2/L3 memory, skills and knowledge blended into the system prompt every turn) and **automatic capture** (L0 raw dialogue persisted into memory-core) all work with no code changes.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. The Continue extension is installed in VS Code / JetBrains (see [docs.continue.dev](https://docs.continue.dev)).

## Setup

### 1. Register the model in Continue

Copy `config.example.yaml` from this directory into `~/.continue/config.yaml` (or merge the `models` entry into your existing config), then export the key:

```bash
export TDB_MEM_USER_KEY=sk-mem-...     # your business user key
```

Continue auto-reloads the config on save; the key stays in the environment and never lands in version control.

### 2. Align the model id

The `model` field **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The example uses `claude-sonnet-4-20250514`; change it if your proxy targets a different upstream.

### 3. Verify

1. Reload the VS Code window (`Ctrl/Cmd+Shift+P` → `Developer: Reload Window`).
2. Open the Continue sidebar and pick **TencentDB Memory** in the model dropdown.
3. Send a first chat message. The proxy triggers the session picker in the chat interaction: choose your **Team → Agent → Task**.
4. From this turn on, memory for the bound agent is injected automatically. Ask Continue what it remembers from previous sessions to confirm.

## Configuration reference

| Item | Value | Notes |
|---|---|---|
| `provider` | `openai` | Continue's OpenAI-compatible adapter |
| `apiBase` | `http://127.0.0.1:8096/codebuddy/default` | Proxy endpoint; trailing `default` is the memory space ID — change it per space |
| `apiKey` | `${TDB_MEM_USER_KEY}` | Env-var reference; the variable holds the `sk-mem-...` business user key |
| `model` | `claude-sonnet-4-20250514` | Must equal `PROXY_UPSTREAM_MODEL`, otherwise the proxy rejects with an upstream mismatch |
| `roles` | `chat`, `edit`, `apply` | All three roles route through the proxy |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "No models configured" / config not loaded | `name`, `version`, `schema` are required top-level fields — missing any of them makes the whole config fail to parse; also check YAML indentation |
| `401` from proxy | Wrong or missing key — `TDB_MEM_USER_KEY` must be exported in the shell that launched VS Code and hold a business user key (`sk-mem-...`) |
| `404` / connection refused | Proxy not running on `:8096`, or `apiBase` set to the full `/chat/completions` route — use the endpoint root `http://127.0.0.1:8096/codebuddy/default` only |
| Model mismatch error | The `model` field differs from `PROXY_UPSTREAM_MODEL` — align them |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new chat to re-pick |

## Notes

- **Maintenance status**: the `continuedev/continue` repository concluded with its final 2.0.0 release; installed extensions keep working with custom `apiBase`, which this adapter relies on.
- **Autocomplete excluded**: inline autocomplete is latency-sensitive — route only `chat`/`edit`/`apply` through the proxy and keep autocomplete on a direct provider.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
