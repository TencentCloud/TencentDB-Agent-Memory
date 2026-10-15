# Issue drafts — two product fixes, decoupled from the OpenHands adapter PR

> Paste-ready GitHub issues following `.github/ISSUE_TEMPLATE/bug_report.yml`
> fields. They describe **upstream product gaps** found while integrating
> OpenHands; neither depends on the adapter landing. Env for both:
> `agentmemory/memory-proxy` v2.0.x via `deploy/global-images/start-proxy.sh`,
> Linux, single node. Verified 2026-10-05 on one host; marks below where the
> claim is general (**UNVERIFIED** beyond that box).

---

## Issue 1

**Title:** [Bug] Proxy session store lives on the container writable layer — every `start-proxy.sh` re-run silently wipes all sessions

**Labels:** bug | **Version:** memory-proxy v2.0.x (image), repo tip `8b86874` | **OS:** Linux + Docker

### Describe the bug | 问题描述

The proxy's SQLite store (sessions, identity bindings, rate-limit buckets) is
configured by the image at `PROXY_DB_PATH=/data/tdai-memory-proxy/proxy.db`
(`MemoryProxy/Dockerfile:84` creates the dir, `:93` bakes the env).
`deploy/global-images/start-proxy.sh` mounts **only** the generated config
(`-v "$CONFIG_FILE:/data/config.yaml:ro"`, line 158 at base) — but it also does
`rm_container_if_exists` (line 44) before every `docker run`. Result: each run
recreates the container and with it the writable layer:

- all initialized sessions disappear → `/skill-bridge/*` and `/memory-bridge/*`
  calls that worked minutes before now return `401 {"code":40101, "session not
  initialized"}`;
- re-initializing a session costs a **paid upstream LLM call** (session-init
  happens only inside the chat handler; there is no free binding endpoint —
  verified: no `/v3/*` route in `MemoryProxy/src/server.ts` creates bindings);
- this hits any workflow that re-generates proxy config (the documented way to
  toggle `skillRuntime.allowLlmWrite` etc.): flip one env flag → lose all
  sessions. Sibling services (`memory-core`, `memory-hub`) already solve this
  with named volumes (`start-memory-core.sh:208`, `start-memory-hub.sh:98`);
  the proxy was the odd one out.

### To Reproduce | 复现步骤

1. `cd deploy/global-images && PROXY_FULL_STACK=1 ./start-proxy.sh`
2. Send one chat request with all four identity headers
   (`x-team-id/x-agent-id/x-task-id/x-conversation-id: repro-1`) to
   `http://127.0.0.1:8096/hermes/default/v1/chat/completions` → session
   registers (log: `preset hit ... → register directly`).
3. `curl -sS -X POST http://127.0.0.1:8096/skill-bridge/v3/skill/listing -H 'x-conversation-id: repro-1' -H 'x-tdai-service-id: default' -d '{}'` → resolves identity (40302/200 depending on write gate) — **not** 40101.
4. Edit `.env` (any value) and re-run `./start-proxy.sh`.
5. Repeat step 3 → `401 {"code":40101,...}`. `docker exec tdai-proxy ls /data/tdai-memory-proxy` shows a fresh empty store.

### Expected behavior | 预期行为

Recreating the proxy container must not lose durable state by default — either
the script mounts a volume at the baked `PROXY_DB_PATH` location, or the docs
state loudly that sessions are per-container-lifetime.

### Error Logs / Screenshots | 日志

Pilot log (ids masked): `session=hermes:m1-retry-1` initialized → after
config-flip recreate → same key `40101 session not initialized`; store dir empty
in new container. Full digest kept off-repo.

### Additional context | 其他说明

The adapter PR (agents/openhands) contains a candidate fix: `PROXY_VOLUME`
(default `tdai-proxy-data`) mounted at `/data/tdai-memory-proxy`, `PROXY_VOLUME`
added to `.env.example` and to the `stop-all.sh --purge` loop so "purge" still
means "nuke everything". Happy to split it out as its own PR if maintainers
prefer it decoupled. Persistence of the *fs binding fallback*
(`ensureBindingRepoPersistent`, `MemoryProxy/src/injection/index.ts:211-230`,
root `~/.memory-tencentdb/proxy-state` or `PROXY_DATA_DIR`) has the same shape —
also unmounted; a volume on `/data` (or documented `PROXY_DATA_DIR` mount)
covers both. UNVERIFIED whether Redis/COS deployments intentionally treat
bindings as expendable.

---

## Issue 2

**Title:** [Bug] skill/memory bridge L1 lookup can't see sessions of header-preselect agents (`hermes`, `openclaw`) — hard-coded `codebuddy`/`claude-code` prefix candidates

**Labels:** bug | **Version:** MemoryProxy @ tip `8b86874` | **OS:** n/a (source-level)

### Describe the bug | 问题描述

The chat path stores session state under the composite key
`${agentSource}:${sessionId}` (`MemoryProxy/src/handler.ts:810, :877`). The two
bridge lookups probe **in-memory L1** with a hard-coded candidate list for bare
ids:

```ts
// skill/skill-bridge.ts loadSessionIdsL1 (also memory/memory-bridge.ts)
: [sessionId, `codebuddy:${sessionId}`, `claude-code:${sessionId}`]
```

So a `hermes:` (or `openclaw:`, or a future `openhands:`) session is invisible
to L1 **by prefix mismatch, not by absence**. The fallback is L2b — but L2b is
gated on `spaceId`, taken **only** from the `x-tdai-service-id` header
(`skill-bridge.ts:503-506` at base; gate `if (!ids && bindingRepoInline &&
spaceId)`), and the injected curl template carries that header only when the
session had a space id at init (`injection/injectors/skill-tools-injector.ts:70-72`).
When L1 misses on prefix **and** the caller doesn't send `x-tdai-service-id`,
the bridge answers `40101 session not initialized` for a session that is very
much initialized — misleading and agent-source-dependent.

Nuance, stated honestly: when L2b **is** reachable it keys on the bare
`(spaceId, sessionId)` (`db/binding-repo.ts:43-48,65-79`; written at
`session/store.ts:244` — `agentSource` is stored *inside* the binding, not in
the key), so prefix parity is moot on that path. The gap is the L1 fast path
(and the config default `redis.enabled: false` + sqlite/kv fallback makes L1 the
common path on single-node deployments — UNVERIFIED for COS/Redis topologies).

### To Reproduce | 复现步骤

1. Register a session as a header-preselect client (Issue 1 repro step 2, agent
   `hermes`, conv `repro-2`) — verify initialized in logs.
2. `curl -X POST :8096/skill-bridge/v3/skill/listing -H 'x-conversation-id: repro-2' -d '{}'` (note: no `x-tdai-service-id`)
   → `401 40101 session not initialized`, while `-H 'x-conversation-id: hermes:repro-2'`
   (prefixed id) **hits L1** and resolves — the tell-tale of prefix probing.
3. Same call **plus** `-H 'x-tdai-service-id: default'` → L2b resolves the bare id.

### Expected behavior | 预期行为

Bridge session resolution should not depend on guessing `agentSource` prefixes:
either probe the stored key space generically (iterate L1 keys ending with
`:${sessionId}`), or always require+use the `x-tdai-service-id` L2b path. The
flatten design (`docs/design/2026-08-03-binding-flatten.md`, referenced at
`skill-bridge.ts:230-233` but **not present in this repo clone** — UNVERIFIED)
is exactly this direction; L1 candidates are flagged in-code as "过渡期兼容".

### Additional context | 其他说明

Adapter PR ships the minimal band-aid (append `hermes:` / `openclaw:` /
`openhands:` candidates, with an observed-behavior comment, separate commit)
so header-preselect clients work today; a generic-suffix or flatten-complete
fix is the proper product answer and supersedes the band-aid. Filed decoupled
on purpose.
