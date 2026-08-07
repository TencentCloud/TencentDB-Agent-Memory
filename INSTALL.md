# TencentDB Agent Memory — Installation Guide

← Back to [README.md](./README.md) · 简体中文: [INSTALL_CN.md](./INSTALL_CN.md)

This document covers three installation modes:

1. **Full three-in-one stack**: `memory-core` + `memory-hub` + `proxy` in one
   shot (recommended — lets coding agents like Claude Code plug directly into
   your team memory / knowledge / skill injection).
2. **Memory Hub only**: lightweight deploy when Memory Core is already running.
3. **Using Proxy with Claude Code**: point a coding agent at the proxy.

---

## Full three-in-one stack: Memory Core + Memory Hub + Proxy (recommended)

Boot `memory-core` + `memory-hub` + `proxy` in one command so coding agents can
consume team memory / knowledge / skills through the proxy:

```bash
# 1) Fetch the scripts
git clone https://github.com/TencentCloud/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images

# 2) Prepare .env (fill in real LLM values)
cp .env.example .env
$EDITOR .env
#   MEMORY_LLM_BASE_URL   / MEMORY_LLM_API_KEY   / MEMORY_LLM_MODEL     ← used internally by memory + hub
#   PROXY_UPSTREAM_URL    / PROXY_UPSTREAM_API_KEY / PROXY_UPSTREAM_MODEL ← upstream the proxy forwards to

# 3) Dry-run validation (optional; also does a live LLM probe — use --skip-llm to skip)
./verify.sh

# 4) One-shot boot
./start-all.sh
```

When it finishes, the script automatically:

1. On the first boot, calls `init-admin` to create the admin user, generates a
   random 32-char `user_key` and persists it to `./.admin-key` (reused across
   restarts of the same volume).
2. Immediately runs `POST /v3/meta/auth/verify` to sanity-check the key. Once
   verified, it prints a ready-to-run block like:

    ```bash
    export ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default
    export ANTHROPIC_AUTH_TOKEN='sk-mem-<random 32 chars>'
    claude --model <whatever PROXY_UPSTREAM_MODEL is set to>
    ```

Default ports:

| Service     | Port  | Purpose                                              |
|---|---|---|
| Memory Core | `8420` | memory read/write, auth, skill/RAG data plane        |
| Panel UI    | `8125` | team memory control panel                            |
| Knowledge   | `8424` | wiki / code-graph service                            |
| Proxy       | `8096` | LLM request proxy (Anthropic / OpenAI dual-protocol) |

---

## After deploy: making it useful

Starting the containers is just half the job. To make coding agents like
Claude Code actually consume team memory, you also need to (a) create the
org structure in the panel and (b) pick them from within a CC session.

### Step 1: Log into the panel

Open **<http://localhost:8125>** in your browser (Panel UI).

- The first visit asks for a `user_key` — use the admin one printed at the
  end of `start-all.sh` (stored in `deploy/global-images/.admin-key`, a
  `sk-mem-...` string)
- Once logged in, admin can directly use asset management features like
  Wiki, CodeGraph, and Skill, and create business assets such as Team /
  Agent / Task.
- If you prefer to separate ops from business (recommended), create a
  `normal` business user → copy that user's `user_key` → log out → log
  back in as the new user.

> In short: admin is the "ops account" for managing users; business users
> are the "app accounts" for managing assets. Even in a single-machine
> local playground, keeping this split is recommended — don't use the
> admin key to drive CC.
> Note: in 2.0.0-beta.1, admin could not own business assets; starting
> from 2.0.0 stable, admin can directly operate on assets.

Knowledge Service Swagger (optional, for API poking):
<http://localhost:8424/docs>

### Step 1.5: Admin creates a business user (optional, recommended for ops/business separation)

Panel: top-left "Users" → "New" (or use the API directly):

```bash
ADMIN_KEY=$(cat ./.admin-key)
curl -sS -X POST http://localhost:8420/v3/meta/user/create \
  -H "x-tdai-user-key: $ADMIN_KEY" \
  -H "x-tdai-service-id: default" \
  -H "Content-Type: application/json" \
  -d '{"username":"you"}' | jq
```

The response body's `data.default_user_key` (`sk-mem-...`) is the login
key for the new user — **save it now**; the panel won't show the full
value again after creation.

Then log out of the panel and log back in with this new key — you're now
a `normal` user and can create Team / Agent / Task under your own name.
Of course, admin can also operate directly; this is just a recommended separation.

### Step 2: Create Team / Agent / Task in the panel

Every memory entry attaches to a `team / agent / task` triple:

1. **Team**: sidebar → "Team" → New
   - A Team owns everything: memory, skill, knowledge
2. **Agent**: enter a Team → "Agent" → New
   - Fill a clear `description` + `system prompt` (the agent's role)
   - e.g. `bug-fix engineer`, `frontend reviewer`, `SQL tuner`
3. **Task** (optional): Team → "Task" → New
   - A Task is the concrete piece of work: "fix login XSS", "ship v1.4"
   - Memories link to Tasks; skipping Task still works but L2/L3 lose the
     Task dimension

You'll want **at least 1 Team + 1 Agent** before you start; Task is optional.

### Step 3: Point Claude Code at the Proxy

Use admin's or the business user's `user_key` (starting from 2.0.0 stable, admin can also own assets):

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default
export ANTHROPIC_AUTH_TOKEN="<the sk-mem-... from Step 1.5>"
claude --model <whatever PROXY_UPSTREAM_MODEL is set to>
```

- `ANTHROPIC_BASE_URL` reroutes CC's API from anthropic.com to the local
  proxy; the trailing `default` is the memory instance ID
  (`x-tdai-service-id`) — always `default` in this local deploy
- `ANTHROPIC_AUTH_TOKEN` is the **business user's** `user_key` (the
  `default_user_key` returned in Step 1.5); proxy uses it to look up
  user_id via core, and only teams/agents/tasks owned by this user show
  up in the next step's picker
- `--model` uses the upstream model name you configured in
  `PROXY_UPSTREAM_MODEL` (proxy forwards to `PROXY_UPSTREAM_URL`)

> 💡 **You can also use CodeBuddy with the Proxy** — see the
> [Using Proxy with CodeBuddy](#using-proxy-with-codebuddy) section below.

### Step 4: First CC turn — pick Team → Agent → Task

**Every new CC session**, the proxy uses CC's native `AskUserQuestion`
tool to walk you through three consecutive picks:

```
┌─────────────────────────────────────────────────┐
│  1. Please pick the Team for this session:     │
│     ○ Team A                                    │
│     ○ Team B                                    │
│                                                 │
│  2. Please pick an Agent under Team A:         │
│     ○ bug-fix engineer                         │
│     ○ frontend reviewer                        │
│                                                 │
│  3. Optionally pick a Task:                    │
│     ○ Fix login XSS                            │
│     ○ [Skip task binding]                      │
└─────────────────────────────────────────────────┘
```

**Answer each with CC's usual arrow-key + Enter**. Once done:

- Proxy binds this session to that team/agent/task
- **Every subsequent turn, proxy auto-injects that agent's L2/L3 memory,
  skills, and knowledge into the system prompt**
- L0 (raw dialogue) is captured into memory-core's SQLite
- Background workers extract L1 (memory) → L2 (scene) → L3 (persona) as
  thresholds are hit

Only a **new CC session** triggers the picker; subsequent turns inside the
same `claude` process reuse the binding.

### Step 5: Watch memory grow

After a chat, look in the panel:

- Left sidebar → **Memory** → Chat Memory: L0 dialogue sliced into scenes
- **Agent detail** page → Profile: L2 scenes + L3 persona accumulate
- **Skill** list: if the LLM decides "this is a reusable how-to", it gets
  auto-extracted into a Skill

Memory-core `/health` also shows whether the pipeline is doing work:

```bash
curl -s http://localhost:8420/health | jq .services.pipelineWorker
```

Expect `tasksConsumed` / `tasksCompleted` to grow with dialogue.

### FAQ

**Q: CC session doesn't prompt me to pick anything?**
`PROXY_ENABLE_SESSION_INIT=1` isn't set. `start-all.sh` defaults to
`PROXY_FULL_STACK=1` which enables it; if you overrode `.env` or ran
`PROXY_FULL_STACK=0`, restart: `PROXY_FULL_STACK=1 ./start-proxy.sh`.

**Q: The picker is empty (or only shows entries owned by someone else)?**
Make sure the current account has created at least one Team and Agent in
the panel. If using the admin account, ensure you've created the relevant
assets; if using a business user, check that you've created Agents under
the corresponding team.

**Q: Panel shows "Panel API 8125 not started"?**
`docker ps` and check `tdai-memory-hub` is healthy. If not, look at
`docker logs tdai-memory-hub` — most commonly a mis-set
`REMOTE_INSTANCE_URL` or `LLM_BASE_URL`.

**Q: L1/L2 never runs, `records/` stays empty?**
Default `promptMode=chat` extracts memory from ordinary conversation. If
you set `code` but the dialogue is small talk, the LLM decides there is
nothing worth persisting and returns 0. Switch back to `chat` or have a
**real work-style conversation** with the agent (edit files, run tests,
give conclusions).

**Q: How do I switch to another team/agent mid-work?**
Start a fresh `claude` session (new window / new session ID) — the picker
runs again.

---

## Memory Hub only

When Memory Core is already running on port `8420`, one command pulls the
Memory Hub image so you get the team memory panel:

```bash
docker pull docker.io/agentmemory/memory-hub:latest
```

Boot Panel + Knowledge Service:

```bash
docker run -d --name tdai-memory-hub \
  --add-host=host.docker.internal:host-gateway \
  -p 8125:8125 -p 8424:8424 \
  -v tdai-panel-data:/data/knowledge \
  -e REMOTE_INSTANCE_URL=http://host.docker.internal:8420 \
  -e REMOTE_INSTANCE_KEY=local \
  -e KNOWLEDGE_PUBLIC_BASE_URL=http://host.docker.internal:8424/v3 \
  -e LLM_MODE=custom \
  -e LLM_BASE_URL=<OPENAI_COMPATIBLE_BASE_URL> \
  -e LLM_API_KEY=<YOUR_API_KEY> \
  -e LLM_MODEL=<MODEL_ID> \
  docker.io/agentmemory/memory-hub:latest
```

Open [http://localhost:8125](http://localhost:8125).

## Using Proxy with Claude Code

`start-all.sh` has already stored the admin user_key at
`deploy/global-images/.admin-key`. Point Claude Code straight at the proxy:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default
export ANTHROPIC_AUTH_TOKEN="$(cat ./.admin-key)"
claude --model <whatever PROXY_UPSTREAM_MODEL is set to>
```

The proxy pipeline in order: `auth` (validates user_key) → `sessionInit`
(interactive team/agent/task picker) → `injection` (L2/L3 memory + skill +
knowledge blended into the system prompt) → forward to the upstream LLM.

Disable the full pipeline (passthrough only): `PROXY_FULL_STACK=0 ./start-proxy.sh`.

## Using Proxy with CodeBuddy

[CodeBuddy](https://www.codebuddy.ai/) is Tencent's AI coding assistant IDE plugin. By configuring a custom model, you can route CodeBuddy's chat requests through the Proxy to get the same memory capabilities as Claude Code, directly within your IDE.

### ⚠️ Known Session-Init Limitation

CodeBuddy versions **4.10.2, 4.10.3, and 4.10.4** have a known bug: these
versions do not send a `sessionId` / conversation header in requests, preventing
the Proxy from completing session initialization. The Proxy mitigates this via a
[`SessionStart` hook](https://www.codebuddy.ai/docs/zh/ide/User-guide/Hooks) that
injects the conversation ID into the prompt, which the Proxy then extracts and
uses as a fallback (see [below](#optional-fix-conversation-id-for-broken-codebuddy-versions)).
If the hook is not configured on these versions, session init will fail.

### Configuration

Create or edit `~/.codebuddy/models.json` on your development machine (replace the API key):

```json
{
  "models": [
    {
      "id": "claude-sonnet-4-20250514",
      "name": "proxy-memory-agent",
      "vendor": "claude",
      "apiKey": "<business user's sk-mem-... user_key>",
      "maxInputTokens": 200000,
      "url": "http://127.0.0.1:8096/codebuddy/default",
      "supportsToolCall": true,
      "supportsImages": true
    }
  ]
}
```

- `id`: a model ID supported by the Proxy's upstream LLM (must match `PROXY_UPSTREAM_MODEL`
  or one of the models in the upstream configuration, e.g. `claude-sonnet-4-20250514`)
- `name`: display name shown in the CodeBuddy chat panel (can be customized freely, e.g. `proxy-memory-agent`)
- `vendor`: model provider label, used only for UI display (e.g. `claude`, `openai`) — does not affect actual requests
- `apiKey`: the **business user's** `user_key` (same one used as
  `ANTHROPIC_AUTH_TOKEN` for Claude Code; using the admin key directly
  is not recommended)
- `url`: Proxy address + `/codebuddy/default` path (same port as Claude Code,
  default `8096`); `default` is the memory instance ID

Once configured, select the model name in CodeBuddy's chat panel and start chatting.
The session init flow is the same as Claude Code (pick Team → Agent → Task).

#### Optional: fix conversation ID for broken CodeBuddy versions

For CodeBuddy **4.10.2 ~ 4.10.4** (which omit the conversation header), enable the
provided `SessionStart` hook so the conversation ID is injected into the prompt
and used by the Proxy as a fallback. Set the hook to point at
`deploy/global-images/hooks/session_start.py` (absolute path):

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python /absolute/path/to/deploy/global-images/hooks/session_start.py",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Place this under CodeBuddy's project-level config (or `settings.json`) on the
development machine. The hook only injects the session ID and never blocks
startup; newer versions (≥ 4.10.5 or ≤ 4.10.1) that already send the header are
unaffected.

## Using Proxy with Hermes

[Hermes](https://hermes-agent.nousresearch.com/docs/) is an open-source AI agent framework. By configuring extra headers, Hermes chat requests can be routed through the Proxy for team memory capabilities.

### Configuration

Edit `~/.hermes/config.yaml`:

```yaml
model:
  default: gpt-5.5
  provider: custom
  base_url: http://<proxy-host>:<port>/hermes/<spaceId>
  api_key: <API Key from admin panel>
  extra_headers:
    x-team-id: <team_id from admin panel>
    x-agent-id: <agent_id from admin panel>
    x-task-id: <task_id from admin panel>
    x-conversation-id: <user-defined session identifier>
```

- `base_url`: Proxy address + `/hermes/<spaceId>` path. `<spaceId>` is the memory instance ID (from the admin panel, usually `default`)
- `api_key`: user's `user_key` (from admin panel "API Key" page)
- `x-team-id` / `x-agent-id`: obtained from the admin panel, same as CodeBuddy / Claude Code
- `x-task-id`: obtained from admin panel "Task Management" page. **Required in the current version** — missing this field causes session registration to fail and memory features won't work (see [Known limitation: x-task-id](#known-limitation-x-task-id))
- `x-conversation-id`: user-defined session identifier (see [Known limitation: x-conversation-id](#known-limitation-x-conversation-id))

## Using Proxy with OpenClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an open-source AI coding agent. By configuring a custom provider, OpenClaw requests can be routed through the Proxy.

### Configuration

Edit `~/.openclaw/openclaw.json`, add a provider under `models.providers`:

```jsonc
{
  "models": {
    "mode": "merge",
    "providers": {
      "memory-proxy": {
        "baseUrl": "http://<proxy-host>:<port>/openclaw/<spaceId>",
        "apiKey": "<API Key from admin panel>",
        "api": "openai-completions",
        "headers": {
          "x-team-id": "<team_id from admin panel>",
          "x-agent-id": "<agent_id from admin panel>",
          "x-task-id": "<task_id from admin panel>",
          "x-conversation-id": "<user-defined session identifier>"
        },
        "request": {
          "allowPrivateNetwork": true
        },
        "models": [
          {
            "id": "gpt-5.5",
            "name": "GPT-5.5",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 128000,
            "maxTokens": 32000,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
          }
        ]
      }
    }
  }
}
```

- `baseUrl`: Proxy address + `/openclaw/<spaceId>` path
- `apiKey`: user's `user_key`
- `headers`: must include `x-team-id`, `x-agent-id`, `x-task-id`, `x-conversation-id`. `x-task-id` is required in the current version (see [Known limitation: x-task-id](#known-limitation-x-task-id))
- `models[].id`: must match the model ID configured in the Proxy upstream

## Using Proxy with Other Platforms (Generic)

Beyond ClaudeCode / CodeBuddy / Hermes / OpenClaw, any OpenAI-compatible platform or custom-built agent can connect to the Proxy to access team memory capabilities.

### Connection

Point the platform's API base URL at the Proxy:

```text
http://<proxy-host>:<port>/<agent-source>/<spaceId>
```

- `<agent-source>`: must be one of the Proxy-supported values: `claude-code`, `codebuddy`, `hermes`, `openclaw`. For other platforms, you can impersonate one of these (e.g. use `codebuddy` as the identifier)
- `<spaceId>`: memory instance ID (`default` for local deployments)

The request path is automatically appended: `/v1/chat/completions` (OpenAI protocol) or `/v1/messages` (Anthropic protocol).

### Required Headers

| Header | Description |
|--------|-------------|
| `Authorization: Bearer <user_key>` | User's API key (from admin panel "API Key" page) |
| `x-team-id` | Team ID |
| `x-agent-id` | Agent ID |
| `x-task-id` | Task ID (required in current version, see [Known limitation: x-task-id](#known-limitation-x-task-id)) |
| `x-conversation-id` | Session identifier, managed by the client |

All headers are required — the Proxy uses them to complete session registration directly, bypassing the interactive form. Platforms that cannot provide these headers will trigger session bypass (no memory injection or conversation recording).

## Known limitation: `x-task-id`

> ⚠️ **Current version limitation**: `x-task-id` is **required** for Hermes / OpenClaw.
>
> The Proxy's header auto-select mechanism requires all three of `x-team-id` + `x-agent-id` + `x-task-id` to complete session registration directly. Without `x-task-id`, the Proxy falls back to an interactive form flow — which Hermes / OpenClaw cannot respond to, resulting in session bypass (no memory injection or conversation recording).
>
> Inconveniences:
>
> 1. Users must create a Task in the admin panel beforehand and obtain the `task_id`, increasing onboarding friction.
> 2. Switching tasks requires manually editing the config file.
>
> In the next version, we will make `x-task-id` optional: when not provided, the Proxy will auto-select the agent's default task or skip task binding entirely.

## Known limitation: `x-conversation-id`

> ⚠️ **Current version limitation**: Hermes and OpenClaw require `x-conversation-id` to be statically specified in the config file. This differs from Claude Code / CodeBuddy (where the SDK automatically manages the session ID).
>
> Current limitations:
>
> 1. **All requests sharing the same conversation ID belong to the same session** — memory injection and conversation recording are bound to this ID.
> 2. **Starting a new conversation requires manually changing the conversation ID**, otherwise the previous session state continues.
> 3. **Some clients may not carry extra headers on tool-call follow-up requests**, causing those turns to skip memory injection and conversation recording.
>
> In the next version, the Proxy will support automatic generation and management of conversation IDs, eliminating the need for clients to specify this field manually.

## Stop / cleanup

```bash
./stop-all.sh            # stop containers, keep volumes & admin key
./stop-all.sh --purge    # nuke volumes, admin key, and generated proxy config
```

## More

Additional installation modes (OpenClaw, Hermes, CodeBuddy, SDK, running from source,
K8s, platform notes) — see
[`deploy/global-images/README.md`](./deploy/global-images/README.md) and
[`MemoryCore/README.md`](./MemoryCore/README.md).
