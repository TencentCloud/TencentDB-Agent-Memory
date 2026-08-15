# TencentDB Agent Memory — OpenCode Adapter

Give your [OpenCode](https://opencode.ai) agent persistent team memory. This adapter routes OpenCode's LLM traffic through the TencentDB Agent Memory proxy, so every session automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
OpenCode ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                         │
                                         ├─ auth        (validates sk-mem-... user_key)
                                         ├─ sessionInit (Team/Agent/Task picker)
                                         └─ injection   (L2/L3 memory + skills + knowledge)
```

The proxy speaks each client's native protocol. OpenCode connects through the OpenAI-compatible endpoint with a custom provider, so no OpenCode plugin code is required — only configuration.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. OpenCode is installed (`curl -fsSL https://opencode.ai/install | bash` or `npm i -g opencode-ai`).

## Setup

### 1. Add the provider config

Copy `opencode.json` from this directory into your project root (or merge it into your existing config):

```bash
cp adapters/opencode/opencode.json ./opencode.json
```

Then adjust one field: the model ID under `models` **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The default example uses `claude-sonnet-4-20250514`.

### 2. Authenticate

Inside OpenCode, run:

```
/connect tencentdb-agent-memory
```

and paste your `sk-mem-...` user_key when prompted. Keys are stored locally in `~/.local/share/opencode/auth.json`, never in the config file.

### 3. Verify

1. Launch `opencode` in any project directory.
2. Open the model picker (`/models`) — you should see **TencentDB Agent Memory / claude-sonnet-4 (via Memory Proxy)**.
3. Select it and send a first message. The proxy triggers the session picker: choose your **Team → Agent → Task** with arrow keys + Enter.
4. From this turn on, memory for the bound agent is injected automatically. Ask the agent what it remembers from previous sessions to confirm.

## Configuration reference

| Field | Value | Notes |
|---|---|---|
| `npm` | `@ai-sdk/openai-compatible` | OpenCode loads this AI SDK package for the custom provider |
| `options.baseURL` | `http://127.0.0.1:8096/codebuddy/default` | Proxy OpenAI-compatible endpoint. `default` is the memory space ID (`x-tdai-service-id`); change it if you run multiple spaces |
| `options.headers` | `x-tdai-service-id: default` | Explicit service ID header for multi-space deployments |
| `models.<id>` | must equal `PROXY_UPSTREAM_MODEL` | Otherwise the proxy rejects the model with an upstream mismatch |
| Auth | via `/connect tencentdb-agent-memory` | Bearer token = business user's `sk-mem-...` user_key |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Model not listed in `/models` | Config JSON invalid — check `opencode.json` parses, and the file is in the project root or `~/.config/opencode/opencode.json` |
| `401` from proxy | Wrong or missing key — re-run `/connect tencentdb-agent-memory`; confirm the key is a business user key, not the admin key |
| `404` / connection refused | Proxy not running on `:8096` — check `./start-all.sh` logs and `PROXY_UPSTREAM_*` env vars |
| Model mismatch error | The model selected in OpenCode differs from `PROXY_UPSTREAM_MODEL` — align the `models` key in `opencode.json` |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new OpenCode session to re-pick |

## Notes

- **Endpoint prefix**: this adapter currently reuses the proxy's OpenAI-compatible endpoint (`/codebuddy/<spaceId>`), which is protocol-identical for any OpenAI-compatible client. When a dedicated `/opencode/<spaceId>` prefix lands upstream, only `options.baseURL` needs to change.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.
- **Version**: tested with OpenCode ≥ 0.6 and TencentDB Agent Memory v3 (`feat/server_team` branch, v2.0.0 images).

## License

MIT, same as the main repository.
