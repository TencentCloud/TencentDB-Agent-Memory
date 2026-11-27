# AGENTS.md — MemoryCore (Gateway)

Standalone memory gateway: L0→L3 pipeline, skills, asset metadata. SQLite + local files, no external service except LLM API.

## OVERVIEW

HTTP gateway on `:8420` (binds `127.0.0.1`); adapters (OpenClaw/Hermes/custom) talk to it via REST or `sdk/`. Stores memory + knowledge *metadata*, never wiki/code content (that is `MemoryKnowledge/`).

## STRUCTURE

```
src/core/       # L0–L3 memory, skill, store/storage abstractions (largest: core/ 118 files)
src/gateway/    # HTTP gateway, v2/v3 routers
src/offload*    # offload pipeline (offload/ 34, offload_server/ 21)
src/metadata/   # users/teams/agents/tasks/assets/ACL (32)
src/services/   # pipeline scanner, workers, scheduling
openclaw-plugin/ hermes-plugin/ pi-plugin/  # thin client adapters — no second pipeline
scripts/        # install/build/migrate/ops (see migrate-v2-to-v3/AGENTS.md)
bin/            # migrate-sqlite-to-tcvdb, export-tencent-vdb, read-local-memory
tdai-gateway*.yaml  # config templates (standalone / default / proxy)
```

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| Memory API surface | `src/gateway/` | v2 compat, v3 isolated plane (recommended) |
| L0→L3 logic | `src/core/` | extraction/aggregation workers |
| Skill extraction | skill module in `src/core/` + `scripts/smoke-skill/` | per-action smoke scripts |
| OpenClaw wiring | `openclaw-plugin/` + `scripts/install-openclaw-plugin.sh` | adapter only |
| Env/config keys | `tdai-gateway*.yaml`, `TDAI_*` env | file < env override |
| Data dir layout | `~/.memory-tencentdb/memory-tdai` | `vectors.db`, `profiles/` (v3) |

## API PLANES (do not mix)

- `/v2/*` — compatibility endpoints (`/capture`, `/recall`, `/v2/conversation/*` …).
- `/v3/*` — isolated plane, requires `team_id` + `agent_id` + `user_id` (body or `x-tdai-*` headers); `session_id` optional narrows to session.
- `/health` public; with `TDAI_GATEWAY_API_KEY` set every other endpoint needs `Authorization: Bearer` + `x-tdai-service-id`.

## CONVENTIONS (differ from root)

- Build is tsdown (`npm run build` = `build:plugin` + `build:scripts`); `bin/*.mjs` are compiled from `scripts/*/`, never edit `bin/` directly.
- Tests: `npm test` (vitest); OSS-only variant `npm run test:oss`; standalone e2e via `__tests__/standalone/*.sh` (bash, not vitest).
- `files` allowlist in `package.json` excludes `src/integrations/` and all tests from the published plugin.

## ANTI-PATTERNS

- Never run a second memory pipeline inside an adapter — adapters call the gateway.
- Never commit `.env`, `*.db`, logs, exports, real `tdai-gateway.yaml`.
- Never bind `0.0.0.0` without `TDAI_GATEWAY_API_KEY` + explicit `TDAI_CORS_ORIGINS` (no `*` in prod).

## COMMANDS

```bash
npm run build && node --import tsx src/gateway/server.ts   # standalone gateway
curl http://127.0.0.1:8420/health
npm test            # npm run test:oss for OSS-only
npm run read-local-memory | npm run seed-v2
```
