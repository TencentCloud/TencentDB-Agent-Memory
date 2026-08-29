# TencentDB Agent Memory — aichat Adapter

Give [aichat](https://github.com/sigoden/aichat) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every chat, shell-assistant command, and RAG session automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
aichat ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                        │
                                        ├─ auth        (validates sk-mem-... user_key)
                                        ├─ sessionInit (Team/Agent/Task picker)
                                        └─ injection   (L2/L3 memory + skills + knowledge)
```

aichat supports **any OpenAI-compatible provider** through its `openai-compatible` provider type in `~/.aichat/config.yaml` ([official config example](https://github.com/sigoden/aichat/blob/main/config.example.yaml)). The client builds its request URL as `<api_base>/chat/completions` and sends the API key as a `Bearer` token (verified in source: `src/client/openai_compatible.rs` — `format!("{api_base}/chat/completions")`). Pointing `api_base` at the proxy's `/codebuddy/<spaceId>/v1` endpoint connects it — **no code changes required**.

**Session binding** (an interactive Team → Agent → Task picker on first message), **memory injection** (the bound agent's L2/L3 memory, skills and knowledge blended into the system prompt every turn) and **automatic capture** (L0 raw dialogue persisted into memory-core) all work with no code changes.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. aichat is installed (`cargo install aichat`, or a binary from the [releases](https://github.com/sigoden/aichat/releases)) and initialized (`aichat` once creates `~/.aichat/`).

## Setup

### 1. Add the proxy as an openai-compatible provider

Append this to the `providers:` list in `~/.aichat/config.yaml`:

```yaml
  - type: openai-compatible
    name: tencentdb-mem
    api_base: http://127.0.0.1:8096/codebuddy/default/v1
    api_key: sk-mem-xxxxxxxx
    models:
      - name: claude-sonnet-4-20250514
        max_input_tokens: 200000
```

- `api_base` — the proxy endpoint; replace `default` with your memory space ID if you use another space. Keep the trailing `/v1`: aichat appends `/chat/completions` to `api_base`, which lands exactly on the proxy's `/codebuddy/<spaceId>/v1/chat/completions` route.
- `api_key` — your business user key (`sk-mem-...`), sent as `Authorization: Bearer`.
- `models` — declare the proxy's `PROXY_UPSTREAM_MODEL` value (e.g. `claude-sonnet-4-20250514`) as the model name. The name **must match** the proxy's upstream model, otherwise the proxy rejects with an upstream mismatch. Models are declared manually — no model-listing endpoint is involved.

### 2. Switch to the model and verify

1. Select the model: `aichat --model tencentdb-mem:claude-sonnet-4-20250514`, or run `.model tencentdb-mem:claude-sonnet-4-20250514` inside the REPL.
2. Send a first message. The proxy triggers the session picker in the chat interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask aichat what it remembers from previous conversations to confirm.

## Configuration reference

| Field | Value | Notes |
|---|---|---|
| `type` | `openai-compatible` | aichat's generic OpenAI-compatible client |
| `name` | `tencentdb-mem` (any name you like) | Prefixes the model selector: `tencentdb-mem:<model>` |
| `api_base` | `http://127.0.0.1:8096/codebuddy/default/v1` | Proxy endpoint; `default` is the memory space ID — change it per space; **keep** the trailing `/v1` |
| `api_key` | `sk-mem-...` | Business user key from the Panel |
| `models[].name` | `PROXY_UPSTREAM_MODEL` value (e.g. `claude-sonnet-4-20250514`) | Must equal the proxy's upstream model |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401` / "Invalid API Key" | The key must be a business user key (`sk-mem-...`) from the Panel — not the admin key from `./.admin-key` |
| Empty responses / upstream mismatch | Model name differs from `PROXY_UPSTREAM_MODEL` — align the `models[].name` entry |
| `404` on every request | Missing trailing `/v1` in `api_base` (requests then hit `/codebuddy/<spaceId>/chat/completions`); keep the URL exactly as shown |
| Connection refused | Proxy not running on `:8096` — check `./start-all.sh` logs and `PROXY_UPSTREAM_*` env vars |
| Model not found in selector | aichat only lists models you declared under the provider — add the model entry and restart aichat |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new session (`.new`) to re-pick |

## Notes

- **User-local config**: the provider block lives only in your `~/.aichat/config.yaml`, never in a committed file; this adapter therefore ships docs only (same as the LobeChat / Open WebUI / LibreChat adapters).
- **All modes flow through it**: REPL chat, CMD mode (`-m` / `--model`), shell assistant, RAG sessions, and agents that use the provider's model all get memory injection.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
