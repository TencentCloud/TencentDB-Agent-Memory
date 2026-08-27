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

# 2) One-shot boot (interactive)
./start-all.sh
```

`start-all.sh` is **interactive**. When run, it automatically:

1. Copies `.env.example` to `.env` if `.env` doesn't exist
2. Walks you through both LLM groups (press Enter to keep the current default):
   - `memory` group: `MEMORY_LLM_BASE_URL` / `MEMORY_LLM_API_KEY` / `MEMORY_LLM_MODEL` (used internally by memory + hub)
   - `proxy` group: `PROXY_UPSTREAM_URL` / `PROXY_UPSTREAM_API_KEY` / `PROXY_UPSTREAM_MODEL` (upstream the proxy forwards to; can reuse the memory group)
3. **Immediately probes the LLM connectivity** after each group — if it fails, you're prompted to re-enter until it passes (or you abort)
4. Writes the values back to `.env` for persistence
5. Boots the three containers once everything passes

> Dry-run validation (optional, checks without starting): `./verify.sh` (`--skip-llm` to skip the LLM probe).

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

Starting the containers is just half the job. To make coding agents
actually consume team memory, you also need to (a) create the
org structure in the panel and (b) pick them from within an agent session.

---

> **⚠️ This section uses Claude Code as an example.** If you're using a different agent, jump to its doc directly:
>
> | Agent | Docs |
> |-------|------|
> | CodeBuddy | [`agents/codebuddy/`](./agents/codebuddy/) |
> | WorkBuddy | [`agents/workbuddy/`](./agents/workbuddy/) |
> | Codex | [`agents/codex/`](./agents/codex/) |
> | DeepSeek Harness | [`agents/dsh/`](./agents/dsh/) |
> | OpenCode | [`agents/opencode/`](./agents/opencode/) |
> | Hermes / OpenClaw / Others | [`agents/README.md`](./agents/README.md) |

---

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

## Using Proxy with Agents

The Proxy supports 9 agent clients. **Full setup instructions, adaptation details, and FAQs** for each agent are in the [`agents/`](./agents/) directory:

| Agent | Config method | Docs |
|-------|---------------|------|
| **Claude Code** | env vars or `~/.claude/settings.json` | [`agents/claude-code/`](./agents/claude-code/) |
| **CodeBuddy** | `~/.codebuddy/models.json` | [`agents/codebuddy/`](./agents/codebuddy/) |
| **WorkBuddy** | `~/.workbuddy/models.json` | [`agents/workbuddy/`](./agents/workbuddy/) |
| **Codex** | `~/.codex/config.toml` (⚠️ first turn requires Plan mode) | [`agents/codex/`](./agents/codex/) |
| **DeepSeek Harness (dsh)** | `~/.dsh/settings.yaml` + `.credentials.yaml` | [`agents/dsh/`](./agents/dsh/) |
| **OpenCode** | `~/.config/opencode/opencode.json` | [`agents/opencode/`](./agents/opencode/) |
| **Hermes** | `~/.hermes/config.yaml` + header preselect | [`agents/hermes/`](./agents/hermes/) |
| **OpenClaw** | `~/.openclaw/openclaw.json` + header preselect | [`agents/openclaw/`](./agents/openclaw/) |
| **Pi** | `pi-plugin` extension (env vars) | [`MemoryCore/pi-plugin/`](./MemoryCore/pi-plugin/) |
| **Other platforms** | Header preselect (generic) | [`agents/README.md`](./agents/README.md) |

The proxy pipeline in order: `auth` (validates user_key) → `sessionInit`
(interactive team/agent/task picker) → `injection` (L2/L3 memory + skill +
knowledge blended into the system prompt) → forward to the upstream LLM.

Disable the full pipeline (passthrough only): `PROXY_FULL_STACK=0 ./start-proxy.sh`.

## Using Proxy with Pi

[Pi](https://github.com/earendil-works/pi-coding-agent) is an open-source AI coding-agent harness. Pi is a first-class agent-source (`pi`) — its system prompts use a label-line format (`Available tools:`, `Guidelines:`) that is distinct from Claude Code (markdown headings) and CodeBuddy (XML tags), so the proxy ships a dedicated `PiProfile` parser. By installing the `pi-plugin` extension and pointing Pi at a custom `tdai` provider, Pi chat requests route through the Proxy for team memory — L3 persona, L2 scene index, L0 conversation capture, and on-demand L0/L1/L2 search.

### Connection

Point Pi at the Proxy via the `pi-plugin` extension:

```text
http://<proxy-host>:<port>/pi/<spaceId>/v1
```

- `<agent-source>`: `pi` (first-class)
- `<spaceId>`: memory instance ID (`default` for local deployments)
- The `/v1` suffix is required in the base URL: the OpenAI-completions provider appends `/chat/completions` but does not insert `/v1`, so including `/v1` makes the request hit the Proxy's explicit `/:agent/:spaceId/v1/chat/completions` route.

### Setup

1. Install the pi-plugin (see [`MemoryCore/pi-plugin/README.md`](./MemoryCore/pi-plugin/README.md)).
2. Set the env vars (no secrets in files): `TDAI_PROXY_URL`, `TDAI_SPACE_ID`, `TDAI_TEAM_ID`, `TDAI_AGENT_ID`, `TDAI_USER_KEY`, `TDAI_MODEL`, and optionally `TDAI_TASK_ID`.
3. Load the extension: `pi -e /path/to/pi-plugin` (or auto-discover from `~/.pi/agent/extensions/`).
4. Run: `pi --provider tdai --model <model>`.

### Required Headers

Injected automatically by the `pi-plugin` extension:

| Header | Source |
|---|---|
| `Authorization: Bearer` | `TDAI_USER_KEY` (the user's API key, not the admin/gateway key) |
| `x-team-id` / `x-agent-id` | env vars (static per host) |
| `x-task-id` | `TDAI_TASK_ID` — **optional**. Omit for broad recall across the agent's memories; set to narrow recall to a task. A stale/unknown `task_id` is dropped (not a hard mismatch), so it never blocks registration. (See [`Known limitation: x-task-id`](#known-limitation-x-task-id) for the header preselect agents that still require it.) |
| `x-conversation-id` | dynamic per Pi session (extension `before_provider_headers` hook) |

Unlike the header-preselect agents (Hermes / OpenClaw), Pi does **not** require `x-task-id`: `task_id` is an optional business dimension in the kernel, and the proxy registers from `team + agent` alone (broad recall when the task is absent). If the required identity env vars (`TDAI_USER_KEY`, `TDAI_TEAM_ID`, `TDAI_AGENT_ID`) are missing, the plugin warns at load and skips registration so Pi still starts.

## Optional: `sessionInit.defaultTaskId` (the "no task binding" option)

**What it does.** By default, the Task pick in the session-init form
only lists the Tasks the user actually created in the panel. If they
haven't created any, or they simply don't want to bind this session to
any Task, the form gets stuck / bypasses. Setting
`sessionInit.defaultTaskId` fixes that: the proxy **prepends a virtual
Task entry** — labeled `本次不关联任务` (*"Don't bind a task this
time"*) — to the head of every team's task list. Picking it registers
the session against that fallback `task_id`, so the flow completes
cleanly without any real Task being attached.

**When to enable it.** Turn it on when:

- You have Agents but no Tasks yet, and want CC / CodeBuddy users to
  finish the first-run picker without being blocked;
- You want a "one-click skip Task" option on every session so users
  don't have to type or arrow-nav out of the picker;
- You're running L2/L3 memory + skill without needing the Task
  dimension (Task is optional across the whole memory model — see
  Step 2 above).

**How it behaves.**

- The virtual entry always appears **first** in the task list under
  every team. Real Tasks follow after it.
- Picking it binds this session to `task_id = <your defaultTaskId>`.
  This ID does **not** need to exist in the control plane — the proxy
  skips `getTask` for it and injects no `[Task]` block into the
  system prompt. `team / agent` binding is still fully active, so
  memory / skill / knowledge injection all work normally.
- Not configured → the picker only shows real Tasks (unchanged
  legacy behavior). Prior to this feature there was no
  "don't-bind-a-task" option at all — the picker simply couldn't
  produce a Task-less session through the standard form path.

### Configuration

Add `defaultTaskId` under the existing `sessionInit` block of your
proxy `config.yaml` (`start-proxy.sh`'s generated config already has
`sessionInit`; just append one line):

```yaml
sessionInit:
  enabled: true
  maxRetries: 3
  injectAgentContext: true
  injectTaskContext: true
  defaultTaskId: "no-task"     # any stable string; not required to exist in the kernel
  headerAutoSelect:
    enabled: true
    teamHeader: "x-team-id"
    agentHeader: "x-agent-id"
    taskHeader: "x-task-id"
    onMismatch: "form"
```

Pick any short, stable value — `no-task`, `default`, or your own
UUID all work. The value ends up recorded on session-init requests
and in logs / telemetry, so if you look at traces later you'll see
this ID marking sessions that opted out of Task binding.

> 💡 Same regeneration caveat as the `/analyse` marker: if you rely on
> `deploy/global-images/start-proxy.sh`, the generated `config.yaml`
> is overwritten on every start — either patch the script's YAML
> template to include `defaultTaskId`, or point `PROXY_CONFIG_DIR` at
> a directory holding your own hand-edited `config.yaml`.

## Optional: `/analyse` URL marker (asset injection effectiveness review)

**What it does.** The Proxy ships a debug/evaluation feature called
**asset reflection**. When enabled, any request whose URL contains an
`/analyse/` path segment gets a `<asset_reflection>` block appended to
the end of its system prompt. That block instructs the LLM, in its
final reply, to add a short debrief calling out — for **each cloud
asset tool it actually invoked this turn** (`<skill_tools>`,
`<tdai_memory_tools>`, `<knowledge_tools>`) — whether the tool helped
or not (what key info it got, what detour it avoided, or why the call
missed). Tools that were **not** invoked are omitted; if nothing was
invoked, the reply must still emit the fixed line
`【资产反思】本轮未使用任何云端资产工具。`

This is designed as an **internal effectiveness probe**: you point a
subset of traffic (a benchmark run, an ad-hoc curl, a Team's staging
CC session) at the `/analyse` URL and read back the model's own
per-tool debrief, so you can measure whether the memory / skill /
knowledge injections are earning their tokens. It is intentionally
opt-in and **not** meant for production user traffic.

### Path shape

Insert `/analyse` as a segment between `/{agent}/{spaceId}` and the
protocol tail. Structure is identical to `/cost-guard`. Examples:

```text
# Claude Code (Anthropic Messages)
http://<proxy-host>:<port>/claude-code/<spaceId>/analyse/v1/messages

# CodeBuddy (OpenAI Chat Completions)
http://<proxy-host>:<port>/codebuddy/<spaceId>/analyse/v1/chat/completions

# Codex (OpenAI Responses)
http://<proxy-host>:<port>/codex/<spaceId>/analyse/v1/responses
http://<proxy-host>:<port>/codex/<spaceId>/analyse/responses   # base_url without /v1

# OpenCode (OpenAI Chat Completions, same protocol as CodeBuddy)
http://<proxy-host>:<port>/opencode/<spaceId>/analyse/v1/chat/completions
http://<proxy-host>:<port>/opencode/<spaceId>/analyse/chat/completions   # base_url without /v1
```

Non-`/analyse` requests are untouched — the injector emits nothing and
the upstream KV-cache prefix stays byte-identical to normal traffic.

### Enabling it (dual gate)

**Gate 1 — config flag.** `injection.assetReflection.markerOptIn`
**defaults to `true`** — `start-proxy.sh`'s generated config and
`config.example.yaml` both set it to true, and dropping the key
altogether still resolves to true. You only need to add the block below
to the proxy `config.yaml` when you want to *explicitly disable* the
marker:

```yaml
injection:
  enabled: true
  injectors:
    - skill
    - knowledge
    - tdai-memory
  assetReflection:
    markerOptIn: false      # default true; set false to reject /analyse marker
```

When `markerOptIn` is explicitly set to `false`, any request carrying
an `/analyse/` segment is rejected with `404 analyse_marker_disabled` —
a safety net for deployments that don't want the reflection capability,
so a client that "thinks" it enabled the marker can't silently fall
through to plain forwarding.

**Gate 2 — URL segment.** Even with `markerOptIn: true`, the reflection
block is only appended when the request URL actually contains
`/analyse/`. Plain `/claude-code/<spaceId>/v1/messages` traffic runs
exactly as before.

### Effective tag list

The tags listed inside the reflection block are computed from the
injectors actually registered on this node (`skill` / `tdai-memory` /
`knowledge`). If none of these injectors is enabled, the block is empty
(the injector short-circuits). This means the marker is only useful
when at least one asset injector is on the pipeline.

> 💡 If you're using `start-proxy.sh` from `deploy/global-images/`, the
> generated `config.yaml` is regenerated on every launch. Either edit
> `start-proxy.sh` to include the `assetReflection` block, or point
> `PROXY_CONFIG_DIR` at a directory holding your own hand-edited
> `config.yaml` and skip regeneration.

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

Additional installation modes (OpenClaw, Hermes, CodeBuddy, WorkBuddy, SDK, running from source,
K8s, platform notes) — see
[`deploy/global-images/README.md`](./deploy/global-images/README.md) and
[`MemoryCore/README.md`](./MemoryCore/README.md).
