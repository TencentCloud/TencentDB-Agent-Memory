# TDAI Memory Gateway — Integration Guide

> Audience: application teams (AI4ALL `weixin_bot`, and any similar chat/agent
> product) who want to bolt a **layered long-term memory** onto their bot by
> talking HTTP to one TDAI Gateway process. You do **not** need to embed the
> plugin, run OpenClaw, or understand the internals — you POST turns in and GET
> memory context back.

---

## 1. What you get

TDAI distils a user's conversation history into a **semantic pyramid** and hands
back a compact, ready-to-inject context block at recall time:

```
L0  raw dialogue turns            (everything the user said)
L1  atomic facts                  ("studies guitar", "evening practice 30min")
L2  scene blocks (Markdown)       (themed summaries of related atoms)
L3  persona profile (Markdown)    (one human-readable user portrait)
```

You feed it turns (`/capture`); a background pipeline grows L1→L2→L3 with an LLM.
Before each model call you ask for context (`/recall`) and prepend/append what
you get to your own prompt. That's the whole contract.

**One process, many users — safely.** A single Gateway can serve thousands of
end-user accounts with **hard isolation**: account A's memory can never surface
in account B's recall or search. Isolation is *structural* — each account gets
its own data directory, SQLite file, and pyramid — not a `WHERE session_key=…`
filter that one missed query could leak past.

---

## 2. Architecture model

```
   your app (weixin_bot turn_service)
        │  HTTP (JSON, Bearer auth)
        ▼
   ┌─────────────────────────────────────────┐
   │ TDAI Gateway  (node, native http :8420)  │
   │                                          │
   │  CoreRegistry  Map<account, TdaiCore>    │
   │    ├─ ai4all:alice → TdaiCore → baseDir/alice.<hash>/  (own SQLite, persona.md…)
   │    ├─ ai4all:bob   → TdaiCore → baseDir/bob.<hash>/
   │    └─ …            (lazy create, LRU evict)            │
   │                                          │
   │  one shared extraction semaphore         │  ← caps total background LLM fan-out
   └─────────────────────────────────────────┘
        │
        ▼  per-account dirs on disk (the isolation boundary)
```

- **`session_key` is the tenant identity.** You choose the scheme; the convention
  is `"{namespace}:{account_id}"`, e.g. `ai4all:alice`, `psydt:User2993`. It is
  business-supplied and **never trusted as a path** — the Gateway derives a
  collision-free, traversal-safe directory name from it (slug + sha256 prefix).
- **Lazy + LRU.** A core is created on first request for an account and can be
  evicted when idle (bounded by `maxResidentCores`) — its pending L1/L2/L3 work
  is flushed before teardown, never dropped.
- **Bounded background cost.** N active accounts would otherwise fan out to ~3N
  concurrent extraction LLM calls. One shared semaphore caps the global total.

---

## 3. Deploy & configure

Run it directly (no build needed; Node ≥ 22.16 strips TS types):

```bash
node --env-file=.env --import tsx src/gateway/server.ts
```

### Configuration sources & precedence

`env var` **>** `tdai-gateway.yaml` (CWD or `<dataDir>/`) **>** built-in default.

| Concern | env | yaml | default |
|---|---|---|---|
| Bind port / host | `TDAI_GATEWAY_PORT` / `_HOST` | `server.port`/`.host` | `8420` / `127.0.0.1` |
| **Multi-tenant** | `TDAI_MULTI_TENANT` | `data.multiTenant` | `false` |
| Data root | `TDAI_DATA_DIR` (or `MEMORY_TENCENTDB_ROOT`) | `data.baseDir` | `~/.memory-tencentdb/memory-tdai` |
| API key (auth) | `TDAI_GATEWAY_API_KEY` | `server.apiKey` | unset → **auth off** |
| CORS allow-list | `TDAI_CORS_ORIGINS` | `server.corsOrigins` | `[]` → no CORS headers |
| Max resident cores (LRU) | `TDAI_MAX_RESIDENT_CORES` | `data.maxResidentCores` | `0` = unlimited |
| Idle core TTL (ms) | `TDAI_CORE_IDLE_TTL_MS` | `data.coreIdleTtlMs` | `0` = disabled |
| Global extraction cap | `TDAI_MAX_CONCURRENT_EXTRACTIONS` | `data.maxConcurrentExtractions` | multi-tenant `4`, single `∞` |
| LLM (chat/extraction) | `TDAI_LLM_API_KEY` / `_BASE_URL` / `_MODEL` | `llm.*` | OpenAI defaults |

> **Embedding is yaml-only.** There are **no** `TDAI_EMBEDDING_*` env vars. Vector
> recall is configured under `memory.embedding.*` in `tdai-gateway.yaml`. The
> `TDAI_LLM_*` vars configure *chat/extraction only* — setting them does **not**
> turn on vector retrieval. See `tdai-gateway.yaml` in the repo root for a working
> DashScope/Bailian (`text-embedding-v3`, 1024-dim) example, and set
> `memory.recall.strategy: hybrid` for vector + BM25 fusion.

### Storage backend & embedding — the supported stack

These are two **independent** layers; this deployment fixes both:

| Layer | Job | What we use |
|---|---|---|
| **Embedding** | text → vector (semantic encoding) | **Alibaba DashScope** `text-embedding-v3` (1024-dim), via `memory.embedding.*` |
| **Vector store** | store vectors + nearest-neighbour & keyword search | **local SQLite** (`sqlite-vec` for vectors + FTS5/BM25 for keyword), one DB file per account |

This is the **only supported multi-tenant stack.** The code also contains a
**Tencent Cloud VectorDB (`tcvdb`) backend**, but it is a fully separate design —
tcvdb does its *own* server-side embedding (it would replace DashScope, not work
alongside it) and keeps all data in shared cloud collections. Because shared
collections defeat the per-account physical isolation this Gateway relies on,
**`multiTenant=true` + `storeBackend=tcvdb` is rejected at startup by design.**

> If you only ever run DashScope + SQLite (the default — `storeBackend` is
> `sqlite` unless you set it), the tcvdb path is never exercised and the
> "tcvdb breaks multi-tenant isolation" issue **does not apply to you**. It is a
> guard against an unsupported combination, not a bug to fix in this deployment.
> Switching to tcvdb would mean re-embedding all history with Tencent's model and
> doing dedicated isolation work first — only worth it if local SQLite outgrows
> your scale/ops needs.

Minimal multi-tenant `.env`:

```bash
TDAI_MULTI_TENANT=true
TDAI_DATA_DIR=/var/lib/tdai
TDAI_GATEWAY_API_KEY=<long-random-secret>
TDAI_LLM_API_KEY=sk-...
TDAI_LLM_BASE_URL=https://api.deepseek.com/v1
TDAI_LLM_MODEL=deepseek-chat
DASHSCOPE_API_KEY=sk-...          # referenced by ${DASHSCOPE_API_KEY} in the yaml
```

---

## 4. HTTP API reference

All bodies are JSON. When `TDAI_GATEWAY_API_KEY` is set, send
`Authorization: Bearer <key>` on every route except `GET /health`. In
**multi-tenant mode `session_key` is required** on every routed endpoint (omit →
`400`).

### `GET /health`
Liveness; never requires auth. Multi-tenant response reports routing state, not
store internals:
```json
{ "status":"ok","version":"0.1.0","uptime":1234,
  "multi_tenant":true,"active_cores":12,
  "extraction":{"limit":4,"active":1,"waiting":0},
  "resident":{"count":12,"limit":200,"pinned":3},
  "embedding":{"configured":true,"provider":"dashscope","model":"text-embedding-v3",
               "dimensions":1024,"recallStrategy":"hybrid"} }
```
- `resident.pinned` — cores currently serving a request (held by a lease). If
  `count > limit` with `pinned` close behind, the LRU cap is being held past its
  bound because every core is busy — transient and safe.
- `embedding` — **configuration intent**, not a live probe: `configured:true`
  means embedding is enabled with a real provider and no config error. It does
  **not** prove the embedding endpoint is reachable (health stays a cheap
  liveness check). For the live signal that vectors actually fired, read the
  `strategy` field from `/search/memories` (§6).
> In multi-tenant mode `stores.vectorStore`/`embeddingService` stay `false` by
> design (cores are lazy/per-account — there is no single store to probe); the
> `embedding` block is the embedding signal health can give there.

### `POST /recall` — get memory context for a turn
Call this *before* your LLM call.
```jsonc
// request
{ "query": "what am I practicing lately?", "session_key": "ai4all:alice" }
// response
{ "context": "<user-persona>…</user-persona>\n<scene-nav>…",  // append to system prompt
  "prepend_context": "- studies guitar; practices 30min nightly", // prepend to user turn
  "strategy": "hybrid", "memory_count": 3 }
```
- `context` — stable system-prompt material (persona, scene navigation).
- `prepend_context` — query-relevant L1 memories for *this* turn. **Inject both.**
  (A client that uses only `context` gets the persona but never the
  query-specific memories.)

### `POST /capture` — record a completed turn
Call this *after* the assistant replies. L0 is written synchronously; L1→L3 grow
in the background.
```jsonc
// request
{ "session_key":"ai4all:alice",
  "user_content":"I started learning guitar.",
  "assistant_content":"That's great — daily practice is key.",
  "session_id":"optional-conversation-id" }
// response
{ "l0_recorded": 2, "scheduler_notified": true }
```

### `POST /search/memories` — L1 fact search
```jsonc
{ "query":"guitar", "session_key":"ai4all:alice", "limit":5 }
// → { "results":"…formatted…", "total":4, "strategy":"hybrid" }
```
`strategy` tells you which retrieval path fired: `hybrid` (vector+BM25),
`embedding` (vector only), `fts` (keyword only), `none`. Use it to verify vector
recall is actually live (§6).

### `POST /search/conversations` — L0 raw-dialogue search
```jsonc
{ "query":"guitar", "session_key":"ai4all:alice", "limit":5 }
// → { "results":"…", "total":2 }    (no strategy field)
```

### `POST /session/end` — flush a session
Flushes buffered pipeline work for a session. No-op if the account has no
resident core (never spins one up just to tear it down).
```jsonc
{ "session_key":"ai4all:alice" }   // → { "flushed": true }
```

### `POST /namespace/wipe` — account hard-delete  *(multi-tenant only)*
Tears down the account's core and removes its entire dataDir from disk.
Idempotent; refuses any path outside `baseDir`. Backs your "delete my data" flow.
```jsonc
{ "session_key":"ai4all:alice" }   // → { "wiped": true }
```

### `POST /seed` — bulk import historical dialogue
Validates + runs the L0→L1 pipeline over batches.
> **Caveat (multi-tenant):** `/seed` writes to a snapshot dir `baseDir/seed-<ts>/`,
> **not** the per-account dirs that recall/search read. To pre-load *per-account*
> memory in multi-tenant mode, drive `executeSeed` per account into
> `baseDir/safeAccountDir(session_key)` — see `scripts/import-psydt.ts` for the
> reference pattern. Treat the HTTP `/seed` route as single-tenant / snapshot use.

---

## 5. Integration lifecycle (the turn flow)

This is the whole loop your `turn_service` runs per user message:

```python
# pseudo-code — one user turn
ctx = POST("/recall", {"session_key": sk, "query": user_text})

system_prompt = base_system + "\n" + ctx["context"]
user_prompt   = (ctx["prepend_context"] + "\n\n" if ctx["prepend_context"] else "") + user_text

reply = your_llm(system_prompt, user_prompt)

# fire-and-forget; do not block the user's reply on this
POST("/capture", {
    "session_key": sk, "session_id": conversation_id,
    "user_content": user_text, "assistant_content": reply,
})
return reply
```

- **`/recall` is on the hot path** — keep its timeout tight; it returns whatever
  memory exists (degrades gracefully to keyword-only if embedding is down).
- **`/capture` is off the hot path** — fire it asynchronously after you've replied.
  L1→L3 synthesis happens later in the background.
- Call **`/session/end`** when a conversation goes idle (or on a timer) to flush
  the last turn's pipeline work promptly.
- Call **`/namespace/wipe`** from your account-deletion / GDPR path.

---

## 6. Verifying vector recall is live

Hybrid search returns hits regardless of which path fired, and `/health` only
reports embedding *config intent* (`embedding.configured`), not whether a vector
query actually succeeded — so test deliberately:

1. Capture a turn with a distinctive fact (e.g. "我喜欢户外登山").
2. Wait for L1 to form (seconds, with a real LLM).
3. `/search/memories` with a **paraphrase that shares no keywords** (e.g.
   "徒步运动"). If you get a hit with `strategy: hybrid` or `embedding`, vector
   recall works. If paraphrases only ever return `fts`/`none`, embedding isn't
   contributing — check the `memory.embedding.*` yaml block and the DashScope key.

### One-click smoke test

`scripts/smoke-recall.mjs` automates exactly the steps above and **asserts** the
result — run it against a Gateway started with your real `.env` (DashScope key,
`TDAI_LLM_*`) as the first thing you do after deploy:

```bash
node scripts/smoke-recall.mjs
# against a non-default address / with auth:
TDAI_GATEWAY_URL=http://127.0.0.1:8420 \
TDAI_GATEWAY_API_KEY=<key> node scripts/smoke-recall.mjs --timeout 120
```

It captures a distinctive fact for a throwaway account, polls a no-keyword
paraphrase until L1 forms, and passes **only** when `strategy` is `hybrid` or
`embedding`. Exit codes: `0` PASS, `1` FAIL (vectors not contributing — the
message distinguishes "L1 never formed" from "formed but embedding silent"), `2`
setup error (gateway unreachable / bad config). It fails fast (~1s) if
`/health` reports `embedding.configured:false`, and cleans up via
`/namespace/wipe` in multi-tenant mode (`--keep` to retain the probe data). No
build, no deps — needs only Node ≥ 18. Override the probe text for non-Chinese
deployments via `SMOKE_FACT_USER` / `SMOKE_KEYWORD` / `SMOKE_PARAPHRASE`.

The bundled **dev-console** (`scripts/dev-console`, `:8421`) drives all of this
through a UI and shows the `strategy` tag and the live pyramid per account.

---

## 7. Operational knobs

| Knob | Effect | Guidance |
|---|---|---|
| `maxResidentCores` | warm cores kept in RAM (LRU evicts idle ones) | A *count* bound. In-flight requests are pinned and never evicted, so a too-low value causes a transient over-limit, not a mid-request teardown. Still size it above your peak active-account count. |
| `coreIdleTtlMs` | reclaim cores idle longer than this | A *time* bound, complementing the count bound. Good for long-tail traffic (many accounts, each briefly active) — frees memory during quiet periods instead of waiting for an LRU push. Pinned cores are spared. |
| `maxConcurrentExtractions` | global cap on background L1/L2/L3 LLM calls | Raise for more throughput, lower to protect your LLM quota. Watch `/health.extraction.waiting`. |
| `strategy: hybrid` | vector + BM25 fusion | Falls back to keyword automatically if embedding is unavailable. |

Cold-start cost: the first request for an (evicted or new) account opens SQLite
and warms the store — a few hundred ms. Size `maxResidentCores` so your active
set stays warm; pre-warm with a cheap `/recall` if first-turn latency matters.

---

## 8. Security posture

- **Auth is opt-in and off by default.** With no `TDAI_GATEWAY_API_KEY`, every
  route except `/health` is open. The Gateway logs a loud WARN at startup if it
  is bound to a non-loopback host without a key. **Always set a key before
  exposing the port.** Token check is constant-time.
- **Bind localhost** unless you've set auth + a CORS allow-list. CORS defaults to
  sending no headers (browsers block cross-origin); `["*"]` is dev-only.
- The dev-console (`:8421`) has **no auth of its own** — it injects the Bearer
  server-side and must stay bound to localhost. Never expose it.

---

## 9. Invariants & limitations (read before you scale)

1. **One process per dataDir.** Structural isolation makes accounts independent,
   but a single account's dataDir must be owned by exactly one process. Do not
   run two Gateways over the same `baseDir`, and don't run the import script
   against an account whose core is live. Atomic writes guard against torn files
   *within* one process, not against two writers.
2. **`session_key` is the whole security boundary.** If your app reuses one
   `session_key` across two real users, their memory merges. Make it stable and
   unique per end-user.
3. **`maxResidentCores` is a memory bound, not a request guard.** It must be set
   above your peak active-account count (see §7).
4. **`/seed` does not populate per-account dirs in multi-tenant mode** (§4).
5. **No cross-account aggregation API.** By design — there is no "search all
   users" endpoint, because that would defeat isolation.

---

## 10. Quickstart checklist

- [ ] `.env` with `TDAI_MULTI_TENANT=true`, `TDAI_DATA_DIR`, `TDAI_GATEWAY_API_KEY`, `TDAI_LLM_*`.
- [ ] `tdai-gateway.yaml` with `memory.embedding.*` + `memory.recall.strategy: hybrid`.
- [ ] Start the Gateway; confirm `GET /health` → `multi_tenant:true`.
- [ ] Wire `turn_service`: `/recall` before the LLM, async `/capture` after.
- [ ] Pick a `session_key` scheme (`{namespace}:{account_id}`).
- [ ] Verify vector recall: run `node scripts/smoke-recall.mjs` → `✅ PASS` (§6).
- [ ] Wire `/namespace/wipe` into account deletion.
