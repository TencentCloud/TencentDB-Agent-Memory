# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@tencentdb-agent-memory/memory-tencentdb` — a memory plugin for the **OpenClaw** agent runtime (and **Hermes** via an HTTP gateway). It does two largely independent jobs:

1. **Layered long-term memory** (`src/core/`): a semantic pyramid that distills conversations into a user profile. `L0 Conversation` (raw dialogue) → `L1 Atom` (atomic facts) → `L2 Scene` (scene blocks) → `L3 Persona` (user profile). Lower layers are evidence in a database; upper layers are human-readable Markdown.
2. **Symbolic short-term memory / context offload** (`src/offload/`): offloads verbose tool logs to external `refs/*.md` files and keeps only a compact Mermaid "canvas" (with `node_id`s) in context, drilling back down via `node_id` when needed.

Both jobs are wired into host lifecycle hooks. The two subsystems share a data directory but have separate config, hooks, and code paths — when editing, know which one you're in.

## Commands

```bash
npm run build            # full build: tsdown bundles index.ts → dist/ + tsc builds the bin/ scripts
npm run build:plugin     # just the plugin bundle (tsdown)
npm test                 # vitest run (unit tests: src/**/*.test.ts)
npm run test:watch       # vitest watch
npm run test:coverage    # vitest with v8 coverage
npx vitest run path/to/file.test.ts          # single test file
npx vitest run -t "substring of test name"   # single test by name
npx vitest --config vitest.e2e.config.ts run # e2e tests (**/*.e2e.test.ts), excluded from default run
```

**No build is required for local development.** Node ≥ 22.16 strips TypeScript types natively and OpenClaw loads `.ts` source directly. Build only for publishing (`prepack` runs it). To dev against a real OpenClaw: `openclaw plugins install --link .`, then `openclaw gateway restart` after changes.

`tsdown` treats every declared dependency + `openclaw` + `node:*` as external (see `tsdown.config.ts`) — the bundle is intentionally thin.

## Architecture

### Host-neutral core + adapters
The central abstraction is `TdaiCore` (`src/core/tdai-core.ts`) — a host-neutral facade exposing `handleBeforeRecall`, `handleTurnCommitted`, search, and pipeline management. It depends only on the `HostAdapter` / `LLMRunner` interfaces in `src/core/types.ts`, never on a specific runtime. Two adapters implement those interfaces:

- **`src/adapters/openclaw/`** — in-process. `index.ts` (the plugin entry) is a thin shell: it registers tools/hooks via `api.registerTool` / `api.on(...)`, translates OpenClaw events into `TdaiCore` calls, and manages prompt/recall caches keyed by session.
- **`src/adapters/standalone/`** — used by `src/gateway/server.ts`, a native-`http` server (no Express) that exposes `TdaiCore` over HTTP (`/recall`, `/capture`, `/search/*`, `/session/end`, `/seed`) for the Hermes sidecar.

When changing memory behavior, put logic in `TdaiCore` / `src/core/`, not in `index.ts` or the gateway — both hosts must get it.

### Long-term memory pipeline (`src/core/`)
- `conversation/l0-recorder.ts` — appends raw turns to local JSONL (L0).
- `record/` — L1: `l1-extractor.ts` (LLM extracts atomic facts), `l1-dedup.ts` (smart dedup), `l1-writer.ts` / `l1-reader.ts`.
- `scene/` — L2: `scene-extractor.ts` aggregates L1 atoms into Markdown scene blocks; scene index/navigation/formatting helpers alongside.
- `persona/` — L3: `persona-generator.ts` synthesizes the user profile; `persona-trigger.ts` decides when (every N new memories).
- `hooks/auto-recall.ts` + `hooks/auto-capture.ts` — the recall (before prompt) and capture (after agent end) entry points called by both adapters.
- `prompts/` — all LLM prompt templates for L1/L2/L3 and dedup.
- `store/` — pluggable storage via `store/factory.ts`. Two backends behind `IMemoryStore` (`store/types.ts`): `sqlite.ts` (default: SQLite + `sqlite-vec` + FTS5, local) and `tcvdb.ts` (Tencent Cloud VectorDB, server-side embedding + hybrid search). `embedding.ts` + `bm25-local.ts` / `bm25-client.ts` handle vector + lexical retrieval.
- `tools/` — `memory-search.ts` and `conversation-search.ts` are the agent-callable search tools.
- `report/reporter.ts` — metric/health reporting.
- `profile/profile-sync.ts` — keeps L2/L3 Markdown in sync locally.

### Context offload (`src/offload/`)
Registered separately via `registerOffload(api, offloadConfig)` from `index.ts`, **only when `offload.enabled`**. It registers the OpenClaw `contextEngine` slot and its own hooks (all via `api.on`):
- `hooks/after-tool-call.ts` — captures tool output, writes full text to `refs/*.md`.
- `hooks/before-prompt-build.ts` / `hooks/llm-input-l3.ts` — inject the Mermaid history canvas, compress non-current tool-use blocks, emergency-compress on token overflow.
- `hooks/before-agent-start.ts` — task transition / judgment handling.
- `pipelines/l2-mermaid.ts` — builds the Mermaid canvas and backfills `node_id`s.
- `local-llm/` — optional local LLM (`node-llama-cpp`) path for offload extraction; `backend-client.ts` is the remote alternative.
- `storage.ts` is the on-disk format (`refs/*.md`, `*.mmd`, jsonl); token accounting lives in `context-token-tracker.ts` / `*token*` files.

### Scripts & bins (`scripts/`, `bin/`)
Standalone migration/inspection tools, each with its own `tsconfig.json` and a built `.mjs` in `bin/`: `migrate-sqlite-to-tcvdb`, `export-tencent-vdb`, `read-local-memory`. Built by `npm run build:scripts`. `scripts/memory-tencentdb-ctl.sh` and `setup-offload.sh` are operator helpers; `openclaw-after-tool-call-messages.patch.sh` patches the OpenClaw install so after-tool-call messages can be offloaded (run once per OpenClaw install, re-run after upgrades).

## Configuration

Plugin config is parsed by `parseConfig` in `src/config.ts` into flat groups: `capture` (L0), `extraction` (L1), `persona` (L2/L3), `pipeline`, `recall`, `embedding`, `offload`, and a `tcvdb` block. Zero-config (`{}`) is valid — every field has a default and the SQLite backend is the default. LLM `model` fields use `"provider/model"` and fall back to OpenClaw's default model when omitted.

The **gateway** (Hermes path) is configured separately in `src/gateway/config.ts`, primarily from env vars: `TDAI_LLM_API_KEY` / `TDAI_LLM_BASE_URL` / `TDAI_LLM_MODEL`, `MEMORY_TENCENTDB_ROOT` / `TDAI_DATA_DIR` for the data dir, and `MEMORY_TENCENTDB_GATEWAY_HOST` / `_PORT`.

## Active work: multi-tenant retrofit (`custom-multitenant` branch)

This fork is being adapted so **one Gateway/sidecar process can safely serve multiple end-user accounts** (tenants), for the AI4ALL WeChat companion project. Design doc + upstream issue live in `docs/tdai_multitenant_design.md` and `docs/tdai_multitenant_issue.md`.

> **Path caveat:** the design doc is written from the *AI4ALL* (weixin_bot) repo's perspective. Paths like `app/turn_service.py`, `scripts/seed_tdai_memory.py`, `docs/tech_design/...` belong to **that** repo, not this one. Only `src/...` paths refer to this TDAI repo. Our scope is the **TDAI side** (`§8.4` / `§8.5` / phase P0.5 of the design, and the standalone issue).

**The core problem:** the standalone/SQLite store is single-tenant per `dataDir`. `session_key` only isolates L0 (raw dialogue) and pipeline/session state — **L1/L2/L3 recall and search are dataDir-global**, so one sidecar serving multiple accounts would recall across accounts, violating the hard isolation invariant.

Verified change points (file:line confirmed against current tree, 2026-06):

| # | Gap | Where | Note |
|---|---|---|---|
| 1 | L1 search has no session filter | `searchL1Vector`/`searchL1Fts`/`searchL1Hybrid?` (`core/store/types.ts`), SQL in `core/store/sqlite.ts` (`l1_vec`/`l1_fts MATCH`) | `L1Record` already carries `session_key` (`store/types.ts:65`) — **no schema change**; add `sessionKey` param + push filter into SQL/vector, thread through `executeMemorySearch → searchMemories → performAutoRecall` |
| 2 | L0 search has no session filter | `searchL0Vector`/`searchL0Fts` (`store/types.ts`); conversation search is **post-filter** (`core/tools/conversation-search.ts:224`) | push down, don't post-filter (post-filter topK can be all other tenants → 0 results after filter) |
| 3 | `/search/memories` has no `session_key` | `MemorySearchRequest` (`gateway/types.ts`), handler `server.ts:~424` doesn't pass it; `MemorySearchParams` (`core/types.ts:229`) lacks it | add field + thread to #1 |
| 4 | `/search/conversations` `session_key` is optional | `gateway/types.ts`, `ConversationSearchParams` has `sessionKey?` | make required in multi-tenant mode |
| 5 | L2/L3 are dataDir-root files | persona reads `pluginDataDir/persona.md` (`auto-recall.ts:148`, writes `persona-generator.ts:185`); scene `readSceneIndex(pluginDataDir)` (`auto-recall.ts:162`) | per-account subdir; change read+write sides together |
| 6 | `/recall` drops `prependContext` (**P0, smallest, do first**) | `server.ts:386` returns only `appendSystemContext` | `RecallResult.prependContext` **already exists** (`core/types.ts:201`) and `handleBeforeRecall` already takes `sessionKey` — just add `prepend_context` to `RecallResponse` and pass it through |
| 7 | reindex/count cross-session | `getAllL1Texts`/`rebuildFtsIndex`/`countL1` (`sqlite.ts`) | structural approach isolates for free; filter approach must decide per-session reindex |

Background pipeline concerns (as important as isolation): TDAI runs background timers per session (L1 idle, L2 schedule — `utils/pipeline-manager.ts:181`) + a global L3 runner (`pipeline-manager.ts:956`). Only a global `extraction.enabled` switch exists, no per-tenant. L3 persona is an unlocked file read-modify-write (`persona-generator.ts:185`) — needs **atomic write (temp+rename)**; same-account L3 is already serialized by the in-process `SerialQueue` (concurrency=1) only under the single-dataDir-single-process contract.

Two implementation routes (decision pending — see the design doc §8.4):
- **Structural (AI4ALL's recommendation):** Gateway keeps `Map<session_key, TdaiCore>`, one dataDir per account (`baseDir/{account}`), lazy + LRU. Isolation is physical (covers #1/#2/#5/#7 for free); still needs #3/#6 interface fields. Cost: N cores = N timer sets + N `SerialQueue`s → background LLM extraction fan-out ×N, so it **requires a cross-core global concurrency cap**.
- **Filter:** single core + shared store, `session_key` pushed into every query. Memory-light, single `SerialQueue` caps concurrency naturally, but "miss one WHERE = cross-tenant leak."

Either way: #6, #5 (L2/L3 per-account), atomic L3 write, and a `session_key`-scoped **namespace wipe** API (for account hard-delete) are all required.

## Conventions

- Commits: Conventional Commits with a scope from `{store, hooks, persona, scene, record, conversation, gateway, hermes, offload, llm, embedding}`, e.g. `fix(embedding): ...`. **DCO is enforced** — every commit needs `Signed-off-by` (`git commit -s`).
- Import order: Node builtins → third-party → internal.
- Tests live next to source as `*.test.ts`; e2e as `*.e2e.test.ts` (run only via the e2e config). `vitest` uses the `forks` pool with a 120s timeout.
- The `src/conversation`, `src/record`, etc. paths in CONTRIBUTING.md are stale — the actual layout nests these under `src/core/`.
