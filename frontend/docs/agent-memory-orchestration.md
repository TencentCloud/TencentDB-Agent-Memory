# TencentDB-Agent-Memory — Wiring Imported Skills

> Provenance: this file is the version-controlled copy of
> `.workbuddy-ai/MEMORY-WORKFLOW.md`. Edit here and mirror back to the working
> note; keep both in sync.

Operationalizes two imported skills (`agentmemory-config`, `subagent-orchestration`)
for the local TencentDB-Agent-Memory stack in this checkout. Project-root references:
`AGENTS.md` (hierarchical sub-AGENTS per module). Local ports: Gateway **8420**,
Proxy **8096**, Panel **8321** (code) / **8125** (docker), Knowledge **8421** (code) /
**8424** (docker).

---

## 1. `agentmemory-config` → capture / injection tuning

The `agentmemory` plugin (rohitg00/agentmemory) is a *lightweight* companion memory
system that can run alongside the heavy TencentDB stack. It reads `~/.agentmemory/.env`
and restarts its server on change.

### Recommended `~/.agentmemory/.env`

```env
# Zero-LLM baseline: BM25 + local embeddings, no API key required.
AGENTMEMORY_TOOLS=all

# Capture is ON by default. The two token-spenders stay OFF unless recall quality
# demands them (they cost tokens proportional to tool-use frequency).
AGENTMEMORY_AUTO_COMPRESS=false
AGENTMEMORY_INJECT_CONTEXT=false

# Enable REST auth so other local agents / the stack must present a Bearer token.
AGENTMEMORY_SECRET=__SET_WITH__ openssl rand -hex 32
```

### Port map (no conflict with the TencentDB stack)

| System | REST | Streams | Viewer | Engine |
|---|---|---|---|---|
| agentmemory | 3111 | 3112 | 3113 | 49134 |
| TencentDB stack | 8420 | — | 8321/8125 | 8421/8424 |

### Mapping `agentmemory` flags → TencentDB local stack

| agentmemory flag | TencentDB equivalent | Notes |
|---|---|---|
| capture (always on) | MemoryCore L0 conversation capture | both record raw turns |
| `AGENTMEMORY_AUTO_COMPRESS` | L1→L2→L3 extraction pipeline (MemoryCore) | token-gated in both; keep gated |
| `AGENTMEMORY_INJECT_CONTEXT` | MemoryProxy injection / write-back | proxy injects recalled memory into agent context |
| `AGENTMEMORY_TOOLS=core\|all` | proxy tool surface (`tdai_memory_search`, etc.) | both expose search tools |
| `AGENTMEMORY_SECRET` | `PROXY_*`/`MEMORY_*` LLM keys + `.admin-key` | both require secrets for upstream/REST |

### Tuning guidance
- Keep `AUTO_COMPRESS` / `INJECT_CONTEXT` **OFF** by default (token cost); enable per
  namespace only when recall quality is poor.
- Always set `AGENTMEMORY_SECRET` so the REST API (3111) is not open.
- Verify with `agentmemory-rest-api`; confirm observations land via `agentmemory-hooks`.
- Don't overwrite unrelated sections of `~/.agentmemory/.env`; touch only the memory block.

---

## 2. `subagent-orchestration` → multi-agent team topology

The repo already defines hierarchical sub-AGENTS (one `AGENTS.md` per module). Map each
module to a standing sub-agent role and apply the orchestration patterns.

### Module → role mapping

| Module | Sub-agent role | Delegate when |
|---|---|---|
| `MemoryCore/` (gateway, L0–L3) | memory-core lead | pipeline changes, v2→v3 migration |
| `MemoryProxy/` | proxy lead | injection/write-back, provider wiring |
| `MemoryKnowledge/` (`/v3` wiki + code-graph) | knowledge lead | seeding wiki, indexing code graph |
| `MemoryPanel/` | panel lead | control backend / UI |
| `sdk/` (ts + py) | sdk lead | client changes, v2/v3 planes |
| `agents/<framework>/` | framework integrator | per-framework proxy wiring |

### Live team (TeamCreate: `agent-memory-team`)

| Role | Agent name | Module | Owns |
|---|---|---|---|
| 1 | memory-core-lead | `MemoryCore/` | L0–L3 pipeline, v2→v3 migration, gateway/auth |
| 2 | proxy-lead | `MemoryProxy/` | injection / write-back, upstream provider wiring |
| 3 | knowledge-lead | `MemoryKnowledge/` | `/v3` wiki + code-graph indexing |
| 4 | panel-lead | `MemoryPanel/` | control backend (Hono) + `web/` React UI |
| 5 | sdk-lead | `sdk/` | TS + Python clients, v2/v3 planes |
| 6 | framework-integrator | `agents/<framework>/` | per-framework proxy wiring |

### Apply the patterns
- **Fresh-context verifier**: after any module change, spawn a *separate* verifier
  subagent with the **spec + the diff** (not your reasoning). It catches regressions the
  author is blind to. Use the imported `verification-before-completion` and
  `requesting-code-review` as its checklist (run `npm test` + `npx tsc --noEmit`
  inside the touched module; rebuild Panel after backend changes).
- **Long-lived workers**: keep one sub-agent per module across related subtasks instead
  of respawning — mirrors the existing per-module `AGENTS.md` ownership and avoids
  repeated context loading.
- **Don't over-delegate**: tightly coupled edits across modules stay with one agent;
  split only independent, specifiable subtasks.

### Handoff template (use for every delegate)
- **Goal**: one sentence.
- **Inputs**: absolute paths + files.
- **Definition of done**: checkable (`npm test` green, `/health` 200, or PR opened).
- **Constraints**: files NOT to touch (e.g. machine-specific absolute paths inside
  `stack-*.cmd`, `MemoryCore/memory-core-start.cmd`).
- **Write results to**: this branch / a PR targeting `develop_server_team` or `master`.
