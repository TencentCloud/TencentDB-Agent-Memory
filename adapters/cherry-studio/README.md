# TencentDB Agent Memory — Cherry Studio Adapter

Give [Cherry Studio](https://github.com/CherryHQ/cherry-studio) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every session automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
Cherry Studio ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                               │
                                               ├─ auth        (validates sk-mem-... user_key)
                                               ├─ sessionInit (Team/Agent/Task picker)
                                               └─ injection   (L2/L3 memory + skills + knowledge)
```

Cherry Studio supports custom providers through its **custom provider** feature: `设置 → 模型服务 → + 添加`, pick the **OpenAI** provider type, then fill the **API 密钥** and **API 地址** (Base URL) and add model IDs manually ([official docs](https://docs.cherryai.com.cn/pre-basic/providers/zi-ding-yi-fu-wu-shang); the docs' vLLM example — API 地址 `http://localhost:8000/` — shows the base-URL convention). Pointing the API 地址 at the proxy's `/codebuddy/<spaceId>` endpoint connects it — **no code changes required**.

**Session binding**, **memory injection** and **automatic capture** all work with no code changes.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. Cherry Studio is installed and running (desktop app for Windows / macOS / Linux).

## Setup

### 1. Add the custom provider

1. Open `设置 → 模型服务` (Settings → Model Services).
2. Click **+ 添加** (Add) at the bottom of the provider list.
3. In the dialog:
   - **提供商名称** (Provider name): `TencentDB Agent Memory`
   - **提供商类型** (Provider type): `OpenAI`
4. Click **添加** (Add) to save, then enable the provider with the toggle on the right.

### 2. Fill in the connection details

On the provider's detail page:

- **API 密钥** (API Key): your business user key (`sk-mem-...`)
- **API 地址** (API Host): `http://127.0.0.1:8096/codebuddy/default`
  (replace `default` with your memory space ID if you use another space)

The proxy serves both the canonical route `/<spaceId>/v1/chat/completions` and a catch-all `/<spaceId>/chat/completions`, so the root endpoint above works regardless of which path Cherry Studio appends for OpenAI-type providers.

### 3. Add the model

Click **+ 添加** (Add) under 模型管理 (Model Management) and add a model with the ID `claude-sonnet-4-20250514`.

The model ID **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The example uses `claude-sonnet-4-20250514`; change it if your proxy targets a different upstream.

### 4. Verify

1. Click **检测** (Check) next to the API key — it should report a successful connection.
2. Open a new chat, select the `TencentDB Agent Memory` provider and the model you added, then send a first message. The proxy triggers the session picker in the chat interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask the chat what it remembers from previous sessions to confirm.

## Configuration reference

| Item | Value | Notes |
|---|---|---|
| 提供商类型 (Provider type) | `OpenAI` | OpenAI Chat Completions protocol |
| API 密钥 (API Key) | `sk-mem-...` | Business user key from the Panel; sent as `Authorization: Bearer` |
| API 地址 (API Host) | `http://127.0.0.1:8096/codebuddy/default` | Proxy endpoint root; `default` is the memory space ID — change it per space; no `/v1` suffix needed (the proxy serves both path shapes) |
| Model ID | `claude-sonnet-4-20250514` | Must equal `PROXY_UPSTREAM_MODEL`, otherwise the proxy rejects with an upstream mismatch |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| 检测 (Check) fails / "Invalid API Key" | The key must be a business user key (`sk-mem-...`) from the Panel — not the admin key from `./.admin-key` |
| `404` | API 地址 must be exactly `http://<host>:8096/codebuddy/<spaceId>` — no `/v1`, no `/chat/completions`; check the proxy is running on `:8096` |
| "Model Not Found" / upstream mismatch | The added model ID differs from `PROXY_UPSTREAM_MODEL` — align them |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new task to re-pick |
| Provider toggle won't enable | Save the provider first, then flip the 启用 (Enable) switch on the right of the provider list |

## Notes

- **Docs-only adapter**: the provider lives in your own Cherry Studio settings, so nothing ships with the adapter beyond this documentation (same as the Chatbox / LobeChat adapters).
- **All chat features flow through it**: regular chats, agents and topics created under the custom provider all use the configured endpoint, so each of them gets memory injection.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
