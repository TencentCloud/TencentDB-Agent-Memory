# TencentDB Agent Memory for Pi

This is a local Pi extension that gives future Pi conversations durable, scoped memory through TencentDB Agent Memory. It is an independent adapter: it does not import, modify, or upload your existing Claude Code, Codex, or Pi history.

## Project introduction

**In one line:** adapt TencentDB Agent Memory to Pi, giving Pi durable cross-session memory and learnable skills — what you tell it does not vanish when the session ends, and what it learns can grow into reusable capabilities.

**Why it exists.** Pi (`@earendil-works/pi-coding-agent`) has no memory across sessions by default. Each new session forgets who you are, what you did, and what it already solved — the same pitfalls get re-hit, the same context gets re-explained. This project gives Pi a long-term memory through TencentDB Agent Memory.

**What it solves.**

- **Cross-session memory**: preferences and conclusions from earlier sessions come back when you ask again.
- **Memory that evolves**: rather than storing raw chat, the server mines captured conversations into atomic memories (L1), scenario notes (L2), and a durable profile (L3).
- **Skill learning**: tool-heavy turns are distilled by a server review model into reusable `SKILL.md` files — injected into context automatically when relevant, and syncable into Pi's native skills.
- **Branch isolation**: Pi `/tree` branches hold independent memory identities, so they never leak into each other.

**Architecture.** The adapter is a local Pi extension talking to MemoryCore through the official SDK — no hand-rolled HTTP, no private protocol:

```text
Pi session ── adapter (local extension) ── official SDK ── MemoryCore (memory + skill engine)
   │
   ├─ before_agent_start → recall L0-L3 + relevant skills, injected as UNTRUSTED context
   ├─ agent_settled      → capture the turn (L0 via a durable outbox; skills at-most-once)
   └─ commands / tools   → setup / status / sync-skills / 4 read-only search tools
```

**Design values (why you can trust it).**

- **Fail-open**: if the memory service is down, times out, or misconfigured, Pi still answers — it only loses memory, never adds a blocker.
- **Untrusted boundary**: recalled memory is always marked `untrusted`; injected content is never treated as instructions.
- **Reliability**: L0 flows through a cross-process file outbox (at-least-once, offline catch-up, dead-letter quarantine); skill writes are at-most-once, so a retry never pollutes the server's cumulative buffer.
- **Official SDK, no reinvention**: authentication, isolation, and TLS all go through the official client; the adapter only translates a Pi turn into the protocol Memory understands.
- **Secure by default**: secrets are redacted before persistence, project config can never touch credentials, and remote endpoints require HTTPS.

**Quick start.** Details below. The simplest path: start MemoryCore → run `/tdai-memory-setup` in Pi and finish the wizard → start using it. To try skill learning, add `"skills": { "enabled": true }`, complete a tool-heavy task, then run `/tdai-memory-sync-skills`.

## Common questions (why nothing shows up yet)

**"It seems to do nothing after install?"**
The adapter *accumulates* memory; it is not instant feedback. Seeing no recall in the first few sessions is normal — memories only appear once the server mines them from your conversations.

**"How long until memories show up?"**
After a few settled sessions (one user + assistant pair each), the server asynchronously distills L1/L2/L3. Open a new session and ask something related — the adapter injects matching memories into context and the status shows `memory: recalled`.

**"What are skills for? Do I need to install them?"**
**No.** There are two "skills" concepts:
- **Pi's native skills**: hand-written or downloaded skill packages in `<agentDir>/skills/` — that's Pi's own system, and yes you'd install those yourself.
- **Skills the Memory server learns**: a review model *automatically* distills `SKILL.md` files from your tool-heavy conversations — nothing to install or write.
The adapter bridges the two: the server learns automatically → when you want those learned skills as visible, editable Pi-native files under `/skills`, run `/tdai-memory-sync-skills` once.

**"Why do skills take so long to appear?"**
The server archives only after ~40 KB of cumulative conversation *or* 10 tool calls per session. Casual short chats accumulate slowly; a **single tool-heavy task** is the fastest path.

**"What do the status numbers mean?"**
- `Memory: no conversations yet` → nothing captured yet; have a few sessions with Pi.
- `Skills: pending N · uncertain N · dead N` → pending = awaiting delivery; uncertain = an ambiguous network failure that is never auto-retried (next turn continues, usually nothing to do); dead = a permanently-failed record that was quarantined (check if you want to clear it).

**"Does a memory outage break Pi?"**
No. Fail-open — Pi answers normally, it just has no memory to inject for that turn.

## What it does

- Before a Pi run, automatically recalls bounded L0 conversation evidence, L1 atomic memories, relevant L2 scenario files, and the L3 core profile. All recalled text is added as explicitly **untrusted** context.
- After Pi has settled, queues the final successful user/assistant exchange locally first, then delivers it to an isolated Pi-session scope. A temporary Memory outage leaves a sanitized record for retry instead of silently losing it; after three consecutive failures, the record is retained as a local `.dead` file so it cannot block newer captures forever.
- Pi `/tree` branches receive distinct Memory session identities; returning to a prior branch restores its identity, while `/fork` is naturally isolated by Pi's new session ID.
- Redacts common `sk-*`, Bearer-token, and private-key forms before persistence; secret values are never shown in the status command.
- Fails open: memory configuration or network failures do not prevent Pi from answering.

L1–L3 are generated by MemoryCore from the captured conversation stream; the adapter reads them but does not fabricate, edit, or delete them. Apart from the setup wizard optionally creating a private Agent, it does not auto-create teams/agents or migrate historical chats. Delivery is at-least-once: if the service accepts a record but its response is lost, a retry can create a duplicate.

## Requirements

- Node.js `>= 22.19.0`
- Pi `0.84.1` was used for development and verification. The adapter relies on Pi's extension API contract (hooks, `registerTool`/`registerCommand`, `ctx.ui`, message shapes) and declares a `peerDependencies` range of `>=0.84.1 <0.85`; run `npm run verify:pi-load` and the end-to-end checks before upgrading Pi.
- A running TencentDB Agent Memory core and an existing Team, Agent, User, and User Key.

## Reproducible maintainer setup

The following flow starts from a clean clone and does not need a globally installed Pi:

```powershell
git clone https://github.com/TencentCloud/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory\adapters\pi
node --version # must be v22.19.0 or later
npm ci
npm run check
npm run verify:pi-load
```

`verify:pi-load` launches the pinned Pi development dependency in offline RPC mode and asserts that `/tdai-memory-setup` and `/tdai-memory-status` are registered. It does not need Memory credentials or make a model request.

### Load modes

For iterative adapter development, load the checked-out source for one Pi invocation:

```powershell
cd E:\path\to\TencentDB-Agent-Memory
./adapters/pi/node_modules/.bin/pi.cmd -e (Resolve-Path ./adapters/pi)
```

To install the same local package for one project (Pi writes only `<project>/.pi/settings.json`), run this from that project directory:

```powershell
pi install -l E:\path\to\TencentDB-Agent-Memory\adapters\pi --approve
pi list
```

After changing extension source, use the first command again for a fresh development load, or update the local package with `pi update E:\path\to\TencentDB-Agent-Memory\adapters\pi --approve`.

The package remains `private` during development and is therefore not yet an npm/Gallery release.

## Configure it

For manual setup, copy [`tdai-memory.example.json`](./tdai-memory.example.json) to the global location: `~/.pi/agent/tdai-memory.json` (Windows: `%USERPROFILE%\.pi\agent\tdai-memory.json`). Environment variables override global values. Do not commit either a key file or a config file containing local IDs to source control.

### Recommended: interactive setup

Start Pi and run:

```text
/tdai-memory-setup
```

The wizard asks for the endpoint, service ID, an existing User Key **file path**, and an optional Gateway bearer-key file path. It verifies the identity, lets you select an accessible Team and Agent (or creates a private `Pi` Agent), then verifies read access to L0, L1, L2, and L3 before saving global configuration and reloading Pi. It never asks you to paste a key into the Pi UI or writes a key into JSON. For the local Docker deployment, select its generated `deploy/global-images/.admin-key` file.

If your remote gateway requires a distinct bearer key, put it in a separate regular file and provide its path when prompted. Leaving that prompt blank intentionally reuses the User Key, which is appropriate only when the gateway accepts it.

> Cold start auto-creates a team-visible `default-agent-<username>` on the server. The wizard confirms before reusing a **non-private** agent, because personal memory written to a team-visible agent is shared with the team. Creating a private `Pi` agent is the safer default — personal memory stays yours.

### Manual configuration

The adapter ignores `<project>/.pi/tdai-memory.json` by default. If the global file explicitly sets `"allowProjectConfig": true`, a trusted project file may contain **only** the `recall` object. It cannot override an endpoint, any Team/Agent/User identity, key-file path, TLS setting, or `captureTools`.

Put the User Key in a separate regular text file, then refer to it by absolute path. A minimal Windows configuration:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "endpoint": "http://127.0.0.1:8420",
  "serviceId": "default",
  "teamId": "team-...",
  "agentId": "agt-...",
  "userId": "usr-...",
  "userKeyFile": "C:\\Users\\you\\.secrets\\tdai-user-key",
  "allowProjectConfig": false,
  "captureTools": false,
  "timeoutMs": 3000,
  "rejectUnauthorized": true
}
```

For a remote endpoint, use HTTPS with a certificate trusted by the operating system. You may instead provide `TDAI_MEMORY_USER_KEY`; `TDAI_MEMORY_GATEWAY_API_KEY` is optional and otherwise falls back to the User Key. Other supported overrides are `TDAI_MEMORY_ENDPOINT`, `TDAI_MEMORY_SERVICE_ID`, `TDAI_MEMORY_TEAM_ID`, `TDAI_MEMORY_AGENT_ID`, `TDAI_MEMORY_USER_ID`, `TDAI_MEMORY_TIMEOUT_MS`, `TDAI_MEMORY_USER_KEY_FILE`, and `TDAI_MEMORY_GATEWAY_API_KEY_FILE`. `TDAI_MEMORY_REJECT_UNAUTHORIZED` is read but only `true` is supported; disabling TLS verification is intentionally unsupported.

## Verify

Start Pi and run:

```text
/tdai-memory-setup
/tdai-memory-status
```

Run setup once first. `/tdai-memory-status` reports configuration, authentication, metadata visibility, and L0 read access while masking IDs and never echoing keys. A status of `memory: captured` after a completed response means that exchange was accepted for the configured agent. Start a new prompt on the same agent to let relevant memory be recalled.

Recall is bounded by the optional `recall` object in the configuration. The defaults are a 3,000 ms global deadline, L0=4, L1=6, L2=2, and 12,000 characters across all layers. At the deadline Pi continues with completed layers; timed-out or failed layers do not prevent Pi itself from answering.

`captureTools` defaults to `false`. Enable it only when successful tool-result text should be captured with the conversation. Failed output, image/binary content, and oversized text are excluded or bounded; common credentials are redacted before data reaches the local retry queue.

### Skills learning loop

Skills are off by default (`skills.enabled` defaults to `false`). When enabled, the adapter captures each settled turn as a five-role conversation, posts it to the Memory gateway's `/v3/skill/conversation/add`, and lets the server's asynchronous extraction mine reusable executable capabilities (SKILL.md) from it. On recall, the adapter searches those skills with `skills.routingMode` and injects the best matches as the fifth, untrusted `[Skill]` layer of the recalled-memory block.

The optional `skills` object in the global configuration:

```json
{
  "skills": {
    "enabled": true,
    "capture": true,
    "runtimeTools": true,
    "routingMode": "bm25",
    "allowTeamSearch": false,
    "includeFailedTools": false,
    "maxMessageBytes": 32768,
    "maxToolItems": 16,
    "flushTimeoutMs": 1500
  }
}
```

- `enabled` — master switch; the `tdai_skill_search` / `tdai_skill_read` tools and capture are gated on it.
- `capture` — post settled turns for skill extraction. When `false`, recall still works but nothing new is learned.
- `runtimeTools` — expose the in-session `tdai_skill_search` / `tdai_skill_read` tools. They share the per-turn 3-call limit with the memory tools.
- `routingMode` — `bm25` (default) | `embedding` | `hybrid`; must match what the gateway's skill router is configured with.
- `allowTeamSearch` — scope skill searches across the whole team instead of the current agent.
- `includeFailedTools` — keep failed tool calls in the captured transcript (default excludes them).
- `maxMessageBytes` — per-message byte bound (1 KiB–1 MiB), default 32 KiB.
- `maxToolItems` — cap on tool_call/tool_result pairs captured per turn (0–100), default 16.
- `flushTimeoutMs` — deadline for a single conversation/add delivery (100 ms–30 s), default 1500 ms.

Delivery is at-most-once: each captured turn is written to a local pending file, sent exactly once, and only then removed. A deterministic 4xx from the gateway moves the record to a dead-letter path; a timeout or 5xx leaves it marked `uncertain` and is never auto-retried, because re-appending would pollute the server's cumulative session buffer. Nothing is ever human-confirmed; the server's review agent decides what becomes a skill.

### Syncing skills into Pi's native skills

Server-side skills live on the gateway and are used indirectly via recall injection. Run:

```text
/tdai-memory-sync-skills
```

The command lists the server's skills, lets you pick (or take all) and confirm, then downloads each remote `SKILL.md` (and optional resources) into `<agentDir>/skills/<name>/` and reloads Pi. Downloads are validated (valid frontmatter, no path traversal, bounded sizes, no executable bits) and installed via a temp dir + atomic replace — any failure rolls back and keeps the previous version. Synced skills enter Pi's native discovery chain: they show up under `/skills` and are loaded by Pi itself like any hand-written skill. **A hand-written skill with the same name (a directory without the `tdai-remote.json` marker) is never overwritten**; only previously-synced skills are replaced by newer versions.

### Maintainer acceptance checklist

1. `npm run check` passes.
2. `npm run verify:pi-load` reports that `/tdai-memory-setup` and `/tdai-memory-status` are registered.
3. With a dedicated test Agent configured through `/tdai-memory-setup`, `/tdai-memory-status` reports `memory: ready`.
4. Make one short Pi request, then make a related second request in a new session. The status should show `memory: captured` after the first and `memory: recalled` before the second.

Steps 3–4 require a running Memory stack and may consume model tokens; they must use a disposable Agent, never shared memory.

## Development checks

```powershell
cd adapters\pi
npm ci
npm run check
npm run verify:pi-load
npm run pack:check
```

The test suite has no external-memory or model requirement. End-to-end usage should use a dedicated test agent, never a production/shared one.

### Real L0-L3 end-to-end check

The managed E2E starts a disposable `agentmemory/memory-core` container and data directory, initializes a one-use admin identity, lets the configured LLM generate real L1/L2/L3 data from a real L0 conversation, and finally loads this extension in the pinned Pi CLI. A trailing observer extension verifies that all four non-empty sections reach Pi's final `before_agent_start` system prompt. It exits before any Pi provider request, so model usage is limited to MemoryCore extraction.

Docker must be running. Pass the existing deployment environment file, or export `MEMORY_LLM_BASE_URL`, `MEMORY_LLM_API_KEY`, and `MEMORY_LLM_MODEL` directly:

```powershell
cd adapters\pi
npm run e2e:l0-l3 -- --managed-core --env-file ../../deploy/global-images/.env
```

The command hard-fails if any layer is empty, the Pi hook does not contain all L0-L3 sections, or the untrusted-memory boundary is missing. It prints only masked disposable IDs, never the LLM or Memory key. Its temporary container and data are removed on both success and failure. This check makes real model requests and therefore consumes tokens.

### Managed-server setup and real-Pi lifecycle E2E

The same disposable MemoryCore container powers two more managed checks:

- `npm run e2e:setup` scripts the `/tdai-memory-setup` wizard against the real server (`ctx.ui` is scripted, the SDK clients stay real). It runs four scenarios — creating a private agent, reusing a preselected agent, a wrong key rejected by real identity verification, and a clean cancel — and asserts the written global config round-trips through `loadConfig` and never embeds the secret key (only its path).
- `npm run e2e:lifecycle` drives the pinned real Pi 0.84.1 in RPC mode to verify three reliability guarantees: (1) a restart never re-captures a settled turn — a record pre-seeded in the filesystem outbox is flushed exactly once on startup, a second restart delivers nothing, and Pi is observed never re-emitting `agent_settled` on load; (2) the RPC `fork` command produces a new session id, records the source file as `parentSession`, and preserves the `tdai-memory/branch@1` marker, so a fork lands in its own isolated memory session; (3) an outage never loses or duplicates a capture — MemoryCore is stopped with a capture still queued, Pi still comes up (fail-open) and the record stays pending, then a fresh Pi delivers it exactly once after the service returns, and a further restart delivers nothing new.

```powershell
cd adapters\pi
npm run e2e:setup -- --env-file ../../deploy/global-images/.env
npm run e2e:lifecycle -- --env-file ../../deploy/global-images/.env
```

### Real Skill learning-loop E2E

- `npm run e2e:skill` uses the same disposable MemoryCore container to verify the complete Skill learning loop: (1) it posts a realistic "triage an intermittent Node CI build OOM" conversation (including a 40 KB+ build log) to `/v3/skill/conversation/add` and asserts a single append trips the byte-archive threshold and returns `archived`; (2) it waits for the real LLM review agent to mine a reusable skill from the conversation and asserts the skill appears via `/v3/skill/list` and `/v3/skill/search`; (3) it loads the pinned real Pi 0.84.1 with the adapter and `skills.enabled`, and asserts the skill reaches `before_agent_start` as the fifth, untrusted `[Skill]` recall layer. As with the L0–L3 check, Pi never makes an answer-model request; the only model consumption is MemoryCore's extraction.

```powershell
cd adapters\pi
npm run e2e:skill -- --managed-core --env-file ../../deploy/global-images/.env
```

## Uninstall

Uninstalling the adapter does not delete server-side memory — your data stays in the Memory service you configured. To remove the adapter fully, in order:

1. Stop loading it: drop `-e <adapter dir>` from Pi's startup arguments (or remove the extension from Pi's extension configuration) and restart Pi.
2. Delete the global config file `~/.pi/agent/tdai-memory.json` (Windows: `%USERPROFILE%\.pi\agent\tdai-memory.json`; honor `PI_CODING_AGENT_DIR` if set). If you explicitly enabled project config with `allowProjectConfig`, also delete `.pi/tdai-memory.json` in the project directory.
3. Review the local outbox `<agentDir>/tdai-memory-outbox/`: on the next adapter start, pending records are re-delivered to the server; `*.json.dead` files are records quarantined after repeated delivery failures. Delete the directory once you are sure nothing is still needed.
4. Your User Key is a file you manage — the adapter never writes keys. Revoking it or cleaning up server-side memory are Memory-service operations.

## Security notes

- Treat a User Key as a password. Do not paste it into issues, chat logs, committed JSON, or screenshots.
- Use a separate Agent for experiments; memory is scoped by Team, Agent, and User.
- TLS verification cannot be disabled. Use loopback HTTP for local development, or install a trusted certificate for HTTPS.
