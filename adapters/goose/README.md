# TencentDB Agent Memory — Goose Adapter

Give [Goose](https://github.com/block/goose) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every session automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
Goose ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                       │
                                       ├─ auth        (validates sk-mem-... user_key)
                                       ├─ sessionInit (Team/Agent/Task picker)
                                       └─ injection   (L2/L3 memory + skills + knowledge)
```

[Goose](https://github.com/block/goose) has a built-in `openai` provider whose host and base path are configurable (`OPENAI_HOST` + `OPENAI_BASE_PATH`). Pointing them at the proxy's `/codebuddy/<spaceId>` endpoint routes all of Goose's LLM traffic through TencentDB Agent Memory — no code changes required.

**Session binding** (an interactive Team → Agent → Task picker on first message), **memory injection** (the bound agent's L2/L3 memory, skills and knowledge blended into the system prompt every turn) and **automatic capture** (L0 raw dialogue persisted into memory-core) all work with no code changes.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. Goose is installed (`brew install block-goose-cli` or the install script from [block.github.io/goose](https://block.github.io/goose)).

## Setup

### 1. Point Goose at the proxy

Environment variables (quick start):

```bash
export GOOSE_PROVIDER=openai
export GOOSE_MODEL=claude-sonnet-4-20250514
export OPENAI_HOST=http://127.0.0.1:8096
export OPENAI_BASE_PATH=/codebuddy/default
export OPENAI_API_KEY=sk-mem-...        # your business user key
```

Or persist the first four in `~/.config/goose/config.yaml` (see `config.example.yaml` in this directory) and keep only `OPENAI_API_KEY` in the environment/keyring so the key never lands in version control. The Desktop app reads the same config file.

### 2. Align the model name

`GOOSE_MODEL` **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The example uses `claude-sonnet-4-20250514`; change it if your proxy targets a different upstream.

### 3. Verify

1. Start a session with `goose session` (or run the Desktop app).
2. Send a first prompt. The proxy triggers the session picker in the terminal interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask Goose what it remembers from previous sessions to confirm. `goose info -v` also shows the resolved provider settings.

## Configuration reference

| Item | Value | Notes |
|---|---|---|
| `GOOSE_PROVIDER` | `openai` | Use Goose's built-in OpenAI provider (not a custom provider entry) |
| `OPENAI_HOST` | `http://127.0.0.1:8096` | Proxy host; combined with the base path it forms the endpoint URL |
| `OPENAI_BASE_PATH` | `/codebuddy/default` | `default` is the memory space ID — change it per space |
| `OPENAI_API_KEY` | `sk-mem-...` | Business user key; sent as `Authorization: Bearer` |
| `GOOSE_MODEL` | `claude-sonnet-4-20250514` | Must equal `PROXY_UPSTREAM_MODEL`, otherwise the proxy rejects with an upstream mismatch |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Goose refuses to start / "no model configured" | `GOOSE_MODEL` must be set — Goose will not start without it |
| Requests still hit api.openai.com | `OPENAI_HOST` not picked up — set it in the shell that launches Goose, or persist it in `~/.config/goose/config.yaml` |
| `401` from proxy | Wrong or missing key — check `OPENAI_API_KEY` is a business user key (`sk-mem-...`), not the admin key |
| `404` / connection refused | Proxy not running on `:8096`, or wrong `OPENAI_BASE_PATH` — check `./start-all.sh` logs |
| Model mismatch error | `GOOSE_MODEL` differs from `PROXY_UPSTREAM_MODEL` — align them |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new Goose session to re-pick |

## Notes

- **Terminal + Desktop**: Goose CLI and the Desktop app share `~/.config/goose/config.yaml`, so configuring once covers both.
- **MCP unaffected**: Goose's MCP extensions keep working; only the LLM leg is routed through the proxy.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
