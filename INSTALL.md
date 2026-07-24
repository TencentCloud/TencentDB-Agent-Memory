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
- Once logged in you are `system_admin`. It can **create Teams and
  sub-users**, but at this stage **cannot directly create other business
  assets such as Agent / Wiki / Skill** (the business APIs enforce
  `owner_user_id === caller`, and `system_admin` isn't yet in the
  allow-list; this restriction will be lifted in a future release).
- **Correct pattern**: admin creates a `normal` user → copy that user's
  `user_key` → log out → log back in as the new user → everything from
  here on (Team / Agent / Task) is owned by the new user.

> In short: admin is the "ops account" for managing users; business users
> are the "app accounts" for managing assets. Even in a single-machine
> local playground, keep this split — don't use the admin key to drive CC.

Knowledge Service Swagger (optional, for API poking):
<http://localhost:8424/docs>

### Step 1.5: Admin creates a business user (required once)

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

Use the **business user's** `user_key` (not the admin key — admin can't
own assets yet, and proxy's sessionInit will show an empty picker):

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
You're likely driving CC with the admin key. Admin **cannot own business
assets** (current limitation), so its team list is empty. Fix: follow
Step 1.5 to create a business user, then use that user's
`default_user_key` as `ANTHROPIC_AUTH_TOKEN`. The business user must also
have created at least one Team/Agent in the panel.

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

## Stop / cleanup

```bash
./stop-all.sh            # stop containers, keep volumes & admin key
./stop-all.sh --purge    # nuke volumes, admin key, and generated proxy config
```

## More

Additional installation modes (OpenClaw, Hermes, SDK, running from source,
K8s, platform notes) — see
[`deploy/global-images/README.md`](./deploy/global-images/README.md) and
[`MemoryCore/README.md`](./MemoryCore/README.md).
