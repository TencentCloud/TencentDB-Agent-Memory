# TencentDB Agent Memory — Cline Adapter

Give [Cline](https://cline.bot) (the open-source VS Code AI agent) persistent team memory. This adapter routes Cline's LLM traffic through the TencentDB Agent Memory proxy, so every task automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
Cline ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                        │
                                        ├─ auth        (validates sk-mem-... user_key)
                                        ├─ sessionInit (Team/Agent/Task picker)
                                        └─ injection   (L2/L3 memory + skills + knowledge)
```

Cline has a built-in **"OpenAI Compatible"** provider in its settings panel. The proxy speaks OpenAI Chat Completions on its `/codebuddy/<spaceId>` endpoint, so Cline connects through the UI with **no files and no code changes** — this adapter is a setup guide.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. The Cline extension is installed in VS Code ([marketplace](https://marketplace.visualstudio.com/items?itemName=Continue.continue) or `clines` — see [cline.bot](https://cline.bot)).

## Setup

### 1. Configure the provider

Open the Cline panel in VS Code, click the settings icon (⚙️), and fill in:

| Field | Value |
|---|---|
| **API Provider** | `OpenAI Compatible` |
| **Base URL** | `http://127.0.0.1:8096/codebuddy/default` |
| **API Key** | your `sk-mem-...` business user key |
| **Model** | `claude-sonnet-4-20250514` |

The trailing `default` in the Base URL is the memory space ID (`x-tdai-service-id`) — change it if you run multiple spaces.

### 2. Align the model ID

The **Model** field **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The default example uses `claude-sonnet-4-20250514`. A mismatched model is rejected by the proxy with an upstream error.

### 3. Model configuration (recommended)

Still in Cline's settings, under **Model Configuration**, set:

- **Context Window size**: `200000` (align with your upstream model)
- **Max Output Tokens**: `16384`
- **Computer Use / tool calling**: enabled (Cline's agentic file edits need it)
- **Input/Output price**: leave at 0 — upstream billing doesn't flow through Cline

Click **Verify** to confirm the connection before saving.

### 4. Verify memory

1. Start a new Cline task and send a first message. The proxy triggers the session picker rendered in the Cline panel: choose your **Team → Agent → Task**.
2. From this turn on, memory for the bound agent is injected automatically. Ask Cline what it remembers from previous sessions to confirm.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Invalid API Key" | Wrong key — confirm it is a business user key (`sk-mem-...`), not the admin key from `./.admin-key` |
| "Model Not Found" | The Model field differs from `PROXY_UPSTREAM_MODEL` — align them |
| Connection error / `404` | Proxy not running on `:8096` — check `./start-all.sh` logs and `PROXY_UPSTREAM_*` env vars; also verify the Base URL includes the space ID path |
| Verify button fails | Same three causes above — Base URL typo is the most common |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous task already bound a session, the binding is reused — start a new Cline task to re-pick |

## Notes

- **UI-based config**: Cline stores provider settings in VS Code's secret storage, which is why this adapter ships a guide instead of a config file — the key never lands in version control.
- **Endpoint prefix**: reuses the proxy's OpenAI-compatible endpoint (`/codebuddy/<spaceId>`); when a dedicated prefix lands upstream, only the Base URL needs to change.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.
- **Version**: tested with Cline's "OpenAI Compatible" provider (per the official docs) and TencentDB Agent Memory v3 (`feat/server_team` branch, v2.0.0 images).

## License

MIT, same as the main repository.
