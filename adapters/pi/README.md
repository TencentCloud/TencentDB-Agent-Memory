# TencentDB Agent Memory — Pi Adapter

Give your [Pi coding agent](https://pi.dev) persistent team memory. This adapter routes Pi's LLM traffic through the TencentDB Agent Memory proxy, so every session automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
Pi ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                    │
                                    ├─ auth        (validates sk-mem-... user_key)
                                    ├─ sessionInit (Team/Agent/Task picker)
                                    └─ injection   (L2/L3 memory + skills + knowledge)
```

Pi supports custom OpenAI-compatible providers via `~/.pi/agent/models.json`. The proxy speaks OpenAI Chat Completions on its `/codebuddy/<spaceId>` endpoint, so Pi connects with **configuration only** — no extension code required.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. Pi is installed (`curl -fsSL https://pi.dev/install.sh | bash`, or see [pi.dev](https://pi.dev)).

## Setup

### 1. Register the provider

Merge `models.json` from this directory into `~/.pi/agent/models.json` (create the file if it doesn't exist — Pi reloads it every time you open `/model`, no restart needed):

```bash
mkdir -p ~/.pi/agent
# if ~/.pi/agent/models.json does not exist yet:
cp adapters/pi/models.json ~/.pi/agent/models.json
# otherwise merge the "tencentdb-agent-memory" block into your existing "providers" object
```

Then adjust one field: the model `id` **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The default example uses `claude-sonnet-4-20250514`.

### 2. Provide the API key

Either export the env var referenced by the config (resolved at request time):

```bash
export TDS_AGENT_MEMORY_KEY="sk-mem-..."   # your business user key
```

…or omit `apiKey` in `models.json` and run `/login tencentdb-agent-memory` inside Pi to store the key in `auth.json`.

### 3. Verify

1. Launch `pi` in any project directory.
2. Open the model picker (`/model` or `Ctrl+L`) — you should see **tencentdb-agent-memory / claude-sonnet-4 (via Memory Proxy)**. Models without auth stay unavailable, so if it's greyed out, check the key.
3. Select it and send a first message. The proxy triggers the session picker: choose your **Team → Agent → Task**.
4. From this turn on, memory for the bound agent is injected automatically. Ask Pi what it remembers from previous sessions to confirm.

## Configuration reference

| Field | Value | Notes |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8096/codebuddy/default` | Proxy OpenAI-compatible endpoint. `default` is the memory space ID (`x-tdai-service-id`); change it if you run multiple spaces |
| `api` | `openai-completions` | Pi's most-compatible API type for OpenAI Chat Completions servers |
| `apiKey` | `$TDS_AGENT_MEMORY_KEY` | Env-var resolution; Pi also supports `!command`, `${VAR}` or a literal `sk-mem-...` |
| `headers` | `x-tdai-service-id: default` | Explicit service ID header for multi-space deployments |
| `models[].id` | must equal `PROXY_UPSTREAM_MODEL` | Otherwise the proxy rejects the model with an upstream mismatch |
| `models[].contextWindow` | `200000` | Adjust to your upstream model |
| `models[].cost` | all zeros | Upstream billing happens outside Pi; zeros keep Pi's cost display honest about the proxy hop |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Model not in `/model` list | `models.json` doesn't parse, or the file isn't at `~/.pi/agent/models.json`; check with `pi --list-models` |
| Model listed but unavailable | No auth — export `TDS_AGENT_MEMORY_KEY` or run `/login tencentdb-agent-memory` |
| `401` from proxy | Wrong or missing key — confirm it is a business user key (`sk-mem-...`), not the admin key |
| `404` / connection refused | Proxy not running on `:8096` — check `./start-all.sh` logs and `PROXY_UPSTREAM_*` env vars |
| Model mismatch error | The selected model differs from `PROXY_UPSTREAM_MODEL` — align `models[].id` |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new Pi session to re-pick |

## Notes

- **Endpoint prefix**: this adapter currently reuses the proxy's OpenAI-compatible endpoint (`/codebuddy/<spaceId>`), which is protocol-identical for any OpenAI-compatible client. When a dedicated `/pi/<spaceId>` prefix lands upstream, only `baseUrl` needs to change.
- **No MCP needed**: Pi deliberately ships without MCP; this adapter follows Pi's native `models.json` provider model instead.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.
- **Version**: tested with Pi's `models.json` provider spec (custom providers with `baseUrl` + `api`) and TencentDB Agent Memory v3 (`feat/server_team` branch, v2.0.0 images).

## License

MIT, same as the main repository.
