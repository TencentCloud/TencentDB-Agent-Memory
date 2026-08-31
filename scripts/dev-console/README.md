# TDAI dev-console

A **build-free local console** for exercising the multi-tenant Gateway end to end
and watching the memory pyramid (L0→L1→L2→L3) build per account. Dev tool only —
not bundled, not published, no auth of its own. **Bind to localhost.**

```
browser (single-page UI, same-origin)
     │
     ▼
dev-console server (:8421) ──► TDAI Gateway (:8420, the 8 HTTP routes)
     │
     └─► reads each account's dataDir read-only  ──►  the pyramid view
```

- **Proxies** the Gateway: the browser only talks to the console (same origin),
  so the Gateway needs **no CORS** config and its API key never reaches the
  client — the console injects `Authorization: Bearer` server-side.
- **Inspects** the on-disk pyramid the HTTP API can't fully show (L2 scenes,
  L1 atoms, persona/raw text), via a read-only SQLite handle + file reads.
- **Zero duplicate config**: it loads the *same* `loadGatewayConfig()` the
  Gateway uses, so baseDir / multiTenant / apiKey / port automatically agree.

## Run

**1. Start the Gateway.** Multi-tenant, and — to see L1→L3 actually grow — with a
real LLM:

```bash
# connectivity only (no LLM): L0 + routing/isolation work; L1+ stay empty
TDAI_MULTI_TENANT=true \
TDAI_DATA_DIR=/tmp/tdai-demo \
node --import tsx src/gateway/server.ts

# full effect (real LLM): the pyramid grows L1 → L2 → L3
TDAI_MULTI_TENANT=true \
TDAI_DATA_DIR=/tmp/tdai-demo \
TDAI_LLM_API_KEY=sk-... \
TDAI_LLM_BASE_URL=https://api.openai.com/v1 \
TDAI_LLM_MODEL=gpt-4o \
node --import tsx src/gateway/server.ts
```

**2. Start the console** (separate terminal, same env so it resolves the same
baseDir / port / apiKey):

```bash
TDAI_MULTI_TENANT=true TDAI_DATA_DIR=/tmp/tdai-demo npm run dev-console
```

**3. Open** http://127.0.0.1:8421

## Env

| var | default | purpose |
|---|---|---|
| `TDAI_MULTI_TENANT` | `false` | must match the Gateway |
| `TDAI_DATA_DIR` | gateway default | base data dir; must match the Gateway |
| `TDAI_GATEWAY_API_KEY` | unset | injected as Bearer if the Gateway requires it |
| `GATEWAY_URL` | `http://<host>:<port>` from config | override if the Gateway is elsewhere |
| `DEV_CONSOLE_PORT` | `8421` | console listen port |
| `DEV_CONSOLE_HOST` | `127.0.0.1` | console bind host |

`TDAI_GATEWAY_PORT` / `TDAI_GATEWAY_HOST` (read by `loadGatewayConfig`) set both
the Gateway's bind and the console's default proxy target.

## Walkthrough

**Isolation (no LLM needed)**
1. With `ai4all:alice` in the session box, **Send turn** → the L0 bar ticks up.
2. Type `ai4all:bob`, **Inspect** → all bars 0. Alice's data is invisible to Bob.
3. **Search** (L0 conversations) for a word from Alice's turn: hits under
   `ai4all:alice`, `total=0` under `ai4all:bob`.
4. **Ops → /health**: `active_cores`, `resident{count,limit}`,
   `extraction{limit,active,waiting}`.
5. **Ops → /namespace/wipe** on Alice → her dataDir is gone; Bob untouched.

**Overall effect (real LLM)**
6. Feed `ai4all:alice` a few informative turns. Toggle **auto 3s**.
7. Watch the pyramid fill: L0 immediately → L1 atoms in seconds → L2 scenes →
   L3 persona.
8. **Recall** → `context` carries Alice's `<user-persona>` (highlighted) and
   never Bob's.

## Files

| file | role |
|---|---|
| `server.ts` | console HTTP server — serves the UI, proxies `/api/gw/*`, `GET /api/inspect` |
| `inspector.ts` | read-only disk readers for L0/L1/L2/L3 (sqlite `query_only` + fs) |
| `public/index.html` | single-page vanilla UI (no build step) |

Reuses `safeAccountDir` (`src/gateway/core-registry.ts`), `loadGatewayConfig`
(`src/gateway/config.ts`), and the read-only SQLite pattern from
`scripts/read-local-memory/`.
