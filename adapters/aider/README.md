# TencentDB Agent Memory — aider Adapter

Give [aider](https://aider.chat) persistent team memory. This adapter routes aider's LLM traffic through the TencentDB Agent Memory proxy, so every session automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
aider ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                       │
                                       ├─ auth        (validates sk-mem-... user_key)
                                       ├─ sessionInit (Team/Agent/Task picker)
                                       └─ injection   (L2/L3 memory + skills + knowledge)
```

aider can connect to any OpenAI-compatible endpoint. The proxy speaks OpenAI Chat Completions on its `/codebuddy/<spaceId>` endpoint, so aider connects with **environment variables + config only** — no code changes required.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. aider is installed (`python -m pip install aider-install && aider-install`).

## Setup

### 1. Point aider at the proxy

```bash
export OPENAI_API_BASE=http://127.0.0.1:8096/codebuddy/default
export OPENAI_API_KEY=sk-mem-...        # your business user key
```

Or copy `aider.conf.yml` from this directory to your project root (it sets `model` and `openai-api-base`), and keep only `OPENAI_API_KEY` as an env var so the key never lands in version control.

### 2. Align the model name

The model after the `openai/` prefix **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The default example uses `claude-sonnet-4-20250514`:

```bash
aider --model openai/claude-sonnet-4-20250514
```

### 3. Verify

1. Launch aider in your project directory.
2. Send a first chat message. The proxy triggers the session picker in the terminal interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask aider what it remembers from previous sessions to confirm.

## Configuration reference

| Item | Value | Notes |
|---|---|---|
| `OPENAI_API_BASE` | `http://127.0.0.1:8096/codebuddy/default` | Proxy OpenAI-compatible endpoint; trailing `default` is the memory space ID — change it per space |
| `OPENAI_API_KEY` | `sk-mem-...` | Business user key from the Panel; aider sends it as `Authorization: Bearer` |
| `--model` | `openai/<PROXY_UPSTREAM_MODEL>` | Otherwise the proxy rejects the model with an upstream mismatch |
| `aider.conf.yml` | optional convenience | Sets `model` + `openai-api-base`; never put the key in it |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Unknown model" warning at startup | Expected for custom models — aider warns about models it doesn't know; editing still works if the upstream model is capable |
| `401` from proxy | Wrong or missing key — check `OPENAI_API_KEY` is a business user key (`sk-mem-...`), not the admin key |
| `404` / connection refused | Proxy not running on `:8096` — check `./start-all.sh` logs and `PROXY_UPSTREAM_*` env vars |
| Model mismatch error | The `openai/<model>` name differs from `PROXY_UPSTREAM_MODEL` — align them |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new aider session to re-pick |

## Notes

- **Terminal-native**: aider is a terminal tool, so the proxy's interactive Team → Agent → Task picker renders inline in the same way CodeBuddy's terminal flow does.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.
- **Version**: tested with aider's OpenAI-compatible path (`OPENAI_API_BASE` + `openai/<model>`, per the official docs) and TencentDB Agent Memory v3 (`feat/server_team` branch, v2.0.0 images).

## License

MIT, same as the main repository.
