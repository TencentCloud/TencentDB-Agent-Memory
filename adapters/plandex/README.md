# TencentDB Agent Memory — Plandex Adapter

Give [Plandex](https://github.com/plandex-ai/plandex) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every plan automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
Plandex ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                        │
                                        ├─ auth        (validates sk-mem-... user_key)
                                        ├─ sessionInit (Team/Agent/Task picker)
                                        └─ injection   (L2/L3 memory + skills + knowledge)
```

Plandex is a terminal-based AI coding engine. Its default OpenAI provider honors the `OPENAI_API_BASE` environment variable ([official README](https://github.com/plandex-ai/plandex)), and since v2.2 any OpenAI-compatible endpoint can also be registered as a custom provider via `plandex models custom`. Pointing either at the proxy's `/codebuddy/<spaceId>` endpoint connects it — **no code changes required**.

**Session binding** (an interactive Team → Agent → Task picker on first message), **memory injection** (the bound agent's L2/L3 memory, skills and knowledge blended into the system prompt every turn) and **automatic capture** (L0 raw dialogue persisted into memory-core) all work with no code changes.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. Plandex is installed (`curl -sL https://plandex.ai/install.sh | bash`, or build from source — see the [README](https://github.com/plandex-ai/plandex)).

## Setup — Option A: environment variables (quickest)

Plandex's default OpenAI provider accepts a custom base URL through `OPENAI_API_BASE`:

```bash
cd your-project
export OPENAI_API_KEY=sk-mem-xxxxxxxx        # business user key from the Panel
export OPENAI_API_BASE=http://127.0.0.1:8096/codebuddy/default
plandex new
```

Replace `default` with your memory space ID if you use another space. Plandex appends the chat-completions path itself — pass the base endpoint exactly as above.

Then select a model whose name equals the proxy's `PROXY_UPSTREAM_MODEL`:

```bash
plandex models          # list available models and current selection
```

## Setup — Option B: custom provider (v2.2+, explicit)

`plandex models custom` opens the custom models config. Register the proxy as a custom provider and map a model onto it:

```json
{
  "$schema": "https://plandex.ai/schemas/models-input.schema.json",
  "providers": [
    {
      "name": "tdb-agent-memory",
      "baseUrl": "http://127.0.0.1:8096/codebuddy/default",
      "apiKeyEnvVar": "TDB_MEM_API_KEY"
    }
  ],
  "models": [
    {
      "modelId": "claude-sonnet-4-20250514",
      "publisher": "TencentDB Agent Memory",
      "description": "Upstream model via TencentDB Agent Memory proxy",
      "maxTokens": 200000,
      "maxOutputTokens": 8192,
      "providers": [
        {
          "provider": "custom",
          "customProvider": "tdb-agent-memory",
          "modelName": "claude-sonnet-4-20250514"
        }
      ]
    }
  ]
}
```

Export the key before use:

```bash
export TDB_MEM_API_KEY=sk-mem-xxxxxxxx
```

## Align the model ID

The model name sent to the proxy **must match your `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The example uses `claude-sonnet-4-20250514`; change it if your proxy targets a different upstream.

## Verify

1. Start a plan: `plandex new`, then give it a task (`plandex tell '...'`).
2. On the first model call, the proxy triggers the session picker in the terminal interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask Plandex what it remembers from previous sessions to confirm.

## Configuration reference

| Item | Value | Notes |
|---|---|---|
| `OPENAI_API_BASE` (Option A) | `http://127.0.0.1:8096/codebuddy/default` | Proxy endpoint; `default` is the memory space ID — change it per space |
| `OPENAI_API_KEY` (Option A) | `sk-mem-...` | Business user key; sent as `Authorization: Bearer` |
| `providers[].baseUrl` (Option B) | `http://127.0.0.1:8096/codebuddy/default` | Same endpoint, declared in the custom models config |
| `providers[].apiKeyEnvVar` (Option B) | `TDB_MEM_API_KEY` | Env var holding the business user key — the key never lands in the config file |
| Model name / `modelName` | `claude-sonnet-4-20250514` | Must equal `PROXY_UPSTREAM_MODEL`, otherwise the proxy rejects with an upstream mismatch |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401` / auth rejected | The key must be a business user key (`sk-mem-...`) from the Panel — not the admin key from `./.admin-key`; for Option B check `TDB_MEM_API_KEY` is exported |
| `404` | Base URL typo — it must be exactly `http://<host>:8096/codebuddy/<spaceId>` with no `/v1` or `/chat/completions` suffix appended |
| "Model Not Found" / upstream mismatch | Model name differs from `PROXY_UPSTREAM_MODEL` — align them |
| Connection refused | Proxy not running on `:8096` — check `./start-all.sh` logs and `PROXY_UPSTREAM_*` env vars |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new task to re-pick |

## Notes

- **Env-var only secrets**: both options reference the API key through an environment variable — the key never lands in a committed file.
- **Every plan flows through it**: all `plandex tell` / `plandex continue` turns use the selected model, so the whole plan gets memory injection.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
