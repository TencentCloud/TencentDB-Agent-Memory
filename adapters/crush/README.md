# TencentDB Agent Memory — Crush Adapter

Give [Crush](https://github.com/charmbracelet/crush) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every session automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
Crush ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                       │
                                       ├─ auth        (validates sk-mem-... user_key)
                                       ├─ sessionInit (Team/Agent/Task picker)
                                       └─ injection   (L2/L3 memory + skills + knowledge)
```

[Crush](https://github.com/charmbracelet/crush) supports custom providers of type `openai-compat` in its JSON config. The proxy speaks OpenAI Chat Completions on its `/codebuddy/<spaceId>` endpoint, so Crush connects with **one provider entry** — no code changes required.

**Session binding** (an interactive Team → Agent → Task picker on first message), **memory injection** (the bound agent's L2/L3 memory, skills and knowledge blended into the system prompt every turn) and **automatic capture** (L0 raw dialogue persisted into memory-core) all work with no code changes.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. Crush is installed (`brew install charmbracelet/tap/crush` or `npm install -g @charmland/crush`).

## Setup

### 1. Register the proxy as a Crush provider

Copy `crush.example.json` from this directory into `~/.config/crush/crush.json` (global) or `crush.json` in your project root (per-project, takes priority), then keep the key out of the file:

```bash
export TDB_MEM_USER_KEY=sk-mem-...     # your business user key
```

Crush expands `$TDB_MEM_USER_KEY` from the environment, so the key never lands in version control.

### 2. Align the model id

The model `id` **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The example uses `claude-sonnet-4-20250514`; change it if your proxy targets a different upstream.

### 3. Verify

1. Launch `crush` in your project directory.
2. Open the model switcher with `Ctrl+L` (or `/model`), pick **TencentDB Agent Memory** and the model entry.
3. Send a first chat message. The proxy triggers the session picker in the terminal interaction: choose your **Team → Agent → Task**.
4. From this turn on, memory for the bound agent is injected automatically. Ask Crush what it remembers from previous sessions to confirm.

## Configuration reference

| Item | Value | Notes |
|---|---|---|
| `providers.*.type` | `openai-compat` | Crush's OpenAI-compatible provider type |
| `base_url` | `http://127.0.0.1:8096/codebuddy/default` | Proxy endpoint; trailing `default` is the memory space ID — change it per space |
| `api_key` | `$TDB_MEM_USER_KEY` | Env-var reference; the variable holds the `sk-mem-...` business user key |
| `models[].id` | `claude-sonnet-4-20250514` | Must equal `PROXY_UPSTREAM_MODEL`, otherwise the proxy rejects with an upstream mismatch |
| Config location | `~/.config/crush/crush.json` or `./crush.json` | Project file takes priority; see the Crush README |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Provider not listed in the model switcher | JSON syntax error in `crush.json` — validate with `python3 -m json.tool crush.json`; also check the file location matches the search order |
| `401` from proxy | Wrong or missing key — `TDB_MEM_USER_KEY` must be exported in the shell that launches Crush and hold a business user key (`sk-mem-...`), not the admin key |
| `404` / connection refused | Proxy not running on `:8096` — check `./start-all.sh` logs and `PROXY_UPSTREAM_*` env vars |
| Model mismatch error | `models[].id` differs from `PROXY_UPSTREAM_MODEL` — align them |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new Crush session to re-pick |

## Notes

- **Terminal-native**: the proxy's interactive Team → Agent → Task picker renders inline in Crush's TUI, same as CodeBuddy's terminal flow.
- **Multi-model**: you can list several `models[]` entries (one per upstream your proxy exposes) and switch mid-session with `/model` — context is preserved per session.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
