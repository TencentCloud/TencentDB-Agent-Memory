# AGENTS.md — MemoryKnowledge (Knowledge Service)

User-side wiki + code-graph engine (`:8421`). Parses/indexes content; Panel owns control plane and pushes `llm_binding`. **Node 22 only** (`better-sqlite3` has no Node-24 prebuild).

## OVERVIEW

Capabilities: LLM-Wiki (docs → structured pages, FTS5 + graph), Code-Graph (clone → symbol/call/file index), optional Auto-Sync (default off), agent self-discovery via `POST /v3/tools/list|call`, status callback to Panel. Route files define paths **without** `/v3` — prefix mounted once in `src/server.ts`; `/health` stays unprefixed (`/v3/health` 404s).

## STRUCTURE

```
src/server.ts src/module.ts src/config.ts  # Hono entry, assembly, env
src/routes/    # wiki / code-graph / tools / llm-binding / health (no /v3 inside)
src/engines/wiki/ src/engines/code/  # ingest-v2/index/search, CodeGraph bridge
src/store/ src/db/   # SQLite (Drizzle) + build queue + llm_binding
src/source-fetcher/  # git pull
src/mcp/       # MCP stdio → forwards to local HTTP API
src/callback.ts      # → Panel status callback (TMC_CALLBACK_URL)
docs/          # data-flow, API details
```

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| Env contract | `.env.example` + README table | who-reads-what + `/v3`-or-not per var |
| Panel handshake | `TMC_CALLBACK_URL` (Panel root, no callback path) + Panel `KNOWLEDGE_SERVICE_URL` (no `/v3`) | swapped slashes = silent breakage |
| LLM source | `LLM_MODE=proxy` (default, uses Panel-pushed binding) vs `custom` (own key in `.env`) | — |
| DB changes | `src/db/` via `drizzle-kit generate|migrate` | — |

## CONVENTIONS (differ from root)

- `pnpm install --ignore-workspace` + `pnpm dev` (tsx hot reload); `dev:mcp` needs HTTP already up.
- `KNOWLEDGE_PUBLIC_BASE_URL` **must** include `/v3` (written into resource `service_url`); Panel URL must **not**.
- ClickHouse/Langfuse telemetry optional-off; failures never block business path.

## ANTI-PATTERNS

- Never add `/v3` inside route files; never query `/v3/health`.
- Never write secrets into `.env` committed files — env injection only.
- Never enable Auto-Sync without reading `docs/data-flow.md` §9 (FIFO + worker pool semantics).

## COMMANDS

```bash
pnpm install --ignore-workspace && cp .env.example .env
pnpm dev                      # :8421, /health; docs at /docs
pnpm typecheck && pnpm test && pnpm build
```
