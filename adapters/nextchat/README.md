# TencentDB Agent Memory — NextChat Adapter

Give [NextChat](https://github.com/ChatGPTNextWeb/NextChat) persistent team memory. NextChat (ChatGPT-Next-Web) is a widely-used self-hostable / desktop / mobile ChatGPT web UI. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every conversation gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
NextChat ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                           │
                                           ├─ auth        (validates sk-mem-... user_key)
                                           ├─ sessionInit (Team/Agent/Task picker)
                                           └─ injection   (L2/L3 memory + skills + knowledge)
```

NextChat's default OpenAI provider builds its request URL by joining the configured interface address with `v1/chat/completions` (verified in source: `app/client/platforms/openai.ts` — `path()` takes the custom interface address from the access store, strips a trailing slash, then joins `OpenaiPath.ChatPath` = `"v1/chat/completions"` defined in `app/constant.ts`), and sends the key as a standard `Authorization` header (verified in source: `app/client/api.ts` — `getHeaders()`). Pointing the interface address at the proxy's `/codebuddy/<spaceId>` endpoint connects it — **no code changes required**.

Note that the client appends `v1/chat/completions` itself, so the interface address must **not** end with `/v1`.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. NextChat is running — either the [desktop app](https://github.com/ChatGPTNextWeb/NextChat/releases), any hosted instance you control, or a self-hosted deployment (docker / Vercel, see the [official docs](https://github.com/ChatGPTNextWeb/NextChat#getting-started)).

## Setup (in-app custom interface)

### 1. Configure the custom interface

Open **Settings → Custom Interface** (自定义接口), enable it, and fill in:

- **Interface Address** — `http://127.0.0.1:8096/codebuddy/default`
- **API Key** — your `sk-mem-...` business user key

Replace `default` with your memory space ID if you use another space. Keep the full `http://` prefix: a bare host is auto-prefixed with `https://` (verified in `app/client/platforms/openai.ts` — `path()` prepends `https://` when the address does not start with `http`). Do **not** add a trailing `/v1` — the client appends `v1/chat/completions` itself, which lands exactly on the proxy's `/codebuddy/<spaceId>/v1/chat/completions` route.

### 2. Declare the model manually

The model picker's *fetch models* button calls `GET <address>/v1/models` (verified in `app/client/platforms/openai.ts` — `ListModelPath`), which the proxy does not expose — the list stays empty. That is expected: fill the **Custom Models** field (设置中的自定义模型) with the model id instead, e.g. `claude-sonnet-4-20250514`. Custom model entries are parsed into the selectable model list (verified in source: `app/store/access.ts` — `customModels` field, consumed by `app/utils/model.ts`).

Keep the model provider as **OpenAI** (the default) so requests use the OpenAI-compatible path described above.

The model id **must match** the proxy's `PROXY_UPSTREAM_MODEL` value, otherwise the proxy rejects with an upstream mismatch.

### 3. Chat and verify

1. Pick the custom model in the model selector and start a new chat.
2. Send a first message. The proxy triggers the session picker in the chat interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask NextChat what it remembers from previous conversations to confirm.

## Setup (self-hosted deployment, alternative)

For a self-hosted NextChat (docker / Vercel), the same wiring can be set through server environment variables — the app's server-side route forwards default OpenAI calls to `BASE_URL` (verified in source: `app/config/server.ts` — `baseUrl: process.env.BASE_URL`; `app/api/common.ts` — `requestOpenai()` joins it with the request path after stripping the `/api/openai/` prefix):

```bash
BASE_URL=http://<proxy-host>:8096/codebuddy/default
OPENAI_API_KEY=sk-mem-...
CUSTOM_MODELS=claude-sonnet-4-20250514   # must match PROXY_UPSTREAM_MODEL
```

Use this only when the NextChat server can reach the proxy over the network; otherwise prefer the in-app custom interface.

## Configuration reference

| Field | Value | Notes |
|---|---|---|
| Interface Address | `http://127.0.0.1:8096/codebuddy/default` | Proxy endpoint; `default` is the memory space ID — change it per space; **no trailing `/v1`** |
| API Key | `sk-mem-...` | Business user key from the Panel |
| Custom Models | `PROXY_UPSTREAM_MODEL` value (e.g. `claude-sonnet-4-20250514`) | Entered manually — the fetch-models button has nothing to list |
| Model provider | OpenAI (default) | Uses the OpenAI-compatible path |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Model list stays empty after pressing *fetch models* | Expected — the proxy exposes no `GET /v1/models` route; declare the model id in the Custom Models field |
| Requests go to `https://…` although you entered a plain host | The client auto-prepends `https://` for addresses without a scheme — always enter the full `http://…` address |
| `401` / "Invalid API Key" | The key must be a business user key (`sk-mem-...`) from the Panel — not the admin key from `./.admin-key` |
| Empty responses / upstream mismatch | Model id differs from `PROXY_UPSTREAM_MODEL` — align the Custom Models entry |
| Connection refused | Proxy not running on `:8096` — check `./start-all.sh` logs and `PROXY_UPSTREAM_*` env vars |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new chat to re-pick |

## Notes

- **User-local config**: the custom interface lives in NextChat's local settings store / deployment env, never in a committed file; this adapter therefore ships docs only (same as the LobeChat / Open WebUI / LibreChat / aichat / Witsy adapters).
- **All chats flow through it**: every new topic using the configured model gets memory injection.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
