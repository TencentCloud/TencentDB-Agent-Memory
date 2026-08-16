# TencentDB Agent Memory — Roo Code Adapter

Give [Roo Code](https://roocode.com) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every session automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
Roo Code ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                       │
                                       ├─ auth        (validates sk-mem-... user_key)
                                       ├─ sessionInit (Team/Agent/Task picker)
                                       └─ injection   (L2/L3 memory + skills + knowledge)
```

[Roo Code](https://roocode.com) ships an **OpenAI Compatible** API provider in its settings panel. The proxy speaks OpenAI Chat Completions on its `/codebuddy/<spaceId>` endpoint, so Roo Code connects with **three settings fields** — no code changes required.

**Session binding** (an interactive Team → Agent → Task picker on first message), **memory injection** (the bound agent's L2/L3 memory, skills and knowledge blended into the system prompt every turn) and **automatic capture** (L0 raw dialogue persisted into memory-core) all work with no code changes.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. Roo Code is installed in VS Code (extension `RooVeterinaryInc.roo-cline` from the marketplace).

## Setup

### 1. Configure the provider

1. Open the Roo Code panel in the VS Code sidebar and click the settings gear icon.
2. **API Provider**: select `OpenAI Compatible`.
3. **Base URL**: `http://127.0.0.1:8096/codebuddy/default`
4. **API Key**: your business user key (`sk-mem-...`).
5. **Model ID**: `claude-sonnet-4-20250514`.

### 2. Align the model id

The **Model ID must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The example uses `claude-sonnet-4-20250514`; change it if your proxy targets a different upstream. Optionally open **Model Configuration** to set the context window and max output tokens to match the upstream model.

### 3. Verify

1. Send a first message in the Roo Code chat.
2. The proxy triggers the session picker in the chat interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask Roo Code what it remembers from previous sessions to confirm.

## Configuration reference

| Field (Roo Code settings) | Value | Notes |
|---|---|---|
| API Provider | `OpenAI Compatible` | Uses the OpenAI Chat Completions protocol |
| Base URL | `http://127.0.0.1:8096/codebuddy/default` | Proxy endpoint; trailing `default` is the memory space ID — change it per space |
| API Key | `sk-mem-...` | Business user key from the Panel; sent as `Authorization: Bearer` |
| Model ID | `claude-sonnet-4-20250514` | Must equal `PROXY_UPSTREAM_MODEL`, otherwise the proxy rejects with an upstream mismatch |
| Model Configuration | optional | Set context window / max output tokens to match the upstream model |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Invalid API Key" | The key must be a business user key (`sk-mem-...`) from the Panel — not the admin key from `./.admin-key` |
| "Model Not Found" / upstream mismatch | Model ID differs from `PROXY_UPSTREAM_MODEL` — align them |
| Tool-calling errors | The proxy forwards OpenAI-native tool calls; make sure `PROXY_UPSTREAM_MODEL` points to a tool-capable model (e.g. a Claude Sonnet class model) |
| `404` / connection refused | Proxy not running on `:8096` — check `./start-all.sh` logs and `PROXY_UPSTREAM_*` env vars |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new Roo Code task to re-pick |

## Notes

- **UI-configured**: Roo Code stores provider profiles in VS Code's secret storage, so the key never lands in workspace files; this adapter therefore ships docs only (same as the Cline adapter).
- **Mode presets**: Roo Code modes (Code/Architect/Ask/Debug) all flow through the same provider, so every mode gets memory injection.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
