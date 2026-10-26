# AGENTS.md — TencentDB-Agent-Memory

Team memory stack (Chat Memory L0→L3, Skills, Wiki, CodeGraph) shared by coding agents through one proxy. Four Node services + SDK + Docker deploy.

## Services & ports

| Service | Dir | Local Win (`stack-start.cmd`) | Docker (`deploy/global-images`) |
|---|---|---|---|
| Gateway / MemoryCore | `MemoryCore/` | :8420 (Podman compose) | :8420 (`MEMORY_CORE_PORT`) |
| Proxy | `MemoryProxy/` | :8096 | :8096 (`PROXY_PORT`) |
| Panel | `MemoryPanel/` | :8321 (via local `.env`) | :8125 (`PANEL_PORT`; code default is 8123) |
| Knowledge | `MemoryKnowledge/` | :8421 | :8424 (`KNOWLEDGE_PORT`) |

Panel/Knowledge ports differ per environment — check `.env`, never assume. Health is `GET /health` on every service. Knowledge mounts API routes under `/v3` once in `src/server.ts`; route files define paths **without** prefix, health stays unprefixed (`/v3/health` 404s).

## Run (Windows, this checkout)

```cmd
stack-start.cmd          :: all four, in order
stack-start.cmd proxy | panel | knowledge | gateway
stack-stop.cmd           :: stops proxy/panel/knowledge; gateway keeps running
stack-stop.cmd all       :: also stops the gateway container
```

Per-service starters: `MemoryCore\memory-core-start.cmd hybrid` (gateway, checks net+Ollama, boots Podman machine), `MemoryProxy\proxy-start.cmd`, `MemoryKnowledge\knowledge-start.cmd`, `MemoryPanel\panel-start.cmd`. Backup: `MemoryCore\memory-core-backup.cmd` (Podman volume export, keeps 14).
Autostart is a Startup-folder shortcut (`stack-start.cmd /quiet`), not schtasks (needs admin).

Local runbooks (this machine, contain live secrets — read, never quote keys): `L:\Musik\MultiAgent\Frontend\docs\TENCENTDB-AGENT-MEMORY-BEDIENUNG.md` (ops), `TENCENTDB-BEFEHLE.md` (copy-paste), `TENCENTDB-SETUP-SCHRITTE.md` (rebuild), `TENCENTDB-CHECKLISTE.md` (status log).

Start order matters: gateway first, wait ~25s for auth, then proxy+knowledge, panel last (`stack-start.cmd` does this). Each service health-checks `/health` after start.

Docker path instead: `cd deploy/global-images && cp .env.example .env` (fill both LLM groups), `./start-all.sh`, `./stop-all.sh`.

## Node versions — strict split

- Proxy + Knowledge: **Node 22 only**. Proxy hard-exits on any other major (`src/index.ts` version gate). `better-sqlite3` in Knowledge has no Node-24 prebuild.
- Panel: **Node 24** (system node), and it must be built first: `pnpm build` → `dist/index.js` (`stack-start.cmd` refuses to start without it).
- Baseline per `CONTRIBUTING.md`: Node ≥ 22.16, `npm`/`pnpm`, Python ≥ 3.9 only for `sdk` Python parts / migration scripts.

## Verify per module

```bash
cd MemoryProxy|MemoryKnowledge
npm test            # vitest run
npx tsc --noEmit    # typecheck (script name: "typecheck")
cd MemoryPanel
pnpm test           # vitest run (pnpm workspace — see MemoryPanel/AGENTS.md)
npx tsc --noEmit    # typecheck
cd MemoryCore
npm test            # vitest run; OSS-only variant: npm run test:oss
npm run build       # tsdown: build:plugin + build:scripts (needed for bin/* CLIs)
```

No repo-wide lint/typecheck/test runner — run verification inside the touched module. Order when it matters: `typecheck → test`; rebuild Panel (`pnpm build`) after changing its backend — MemoryPanel is a pnpm workspace, so `pnpm test`/`pnpm build` are authoritative and the root's generic `npm test` does not apply to Panel.

## Repo conventions

- Commits: Conventional Commits + DCO sign-off (`git commit -s -m "feat(memory-core): ..."`). Scope = module (`memory-core`, `panel`, `knowledge`, `proxy`, `sdk-ts`, `sdk-py`, `deploy`, `docs`). PRs target `develop_server_team` or `master`.
- TS: comments explain *why*, not *what*. Import order: builtins → third-party → project internals. Bug fixes ship with a failing-first regression test.
- Secrets: two LLM groups in `.env` — `MEMORY_*` (core/hub internal embed/summarize) and `PROXY_*` (upstream model). Never commit `.env`; runtime-generated `.admin-key`, `.proxy-config/`, `.memory-core-config/` are gitignored. Security reports go to agentmemory@tencent.com, not public issues.
- Never commit: `data/` (`*.db`, `vectors.db`, `mem-*`), `dist/`, `*.log`, `*.tgz`, coverage output. Clients connect to the proxy, not the gateway: `http://127.0.0.1:8096/<framework>/default` — see `agents/<framework>/README.md` per framework.
- `stack-start.cmd`, `stack-stop.cmd`, `MemoryCore/memory-core-start.cmd` contain machine-specific absolute paths (`L:\...`, per-user Node binary paths). Adjust locally; keep changes uncommitted where possible.

## Sub-AGENTS (hierarchical, read the nearest one before editing)

- `MemoryCore/AGENTS.md` — gateway, L0→L3 pipeline, skills, adapters
- `MemoryCore/scripts/migrate-v2-to-v3/AGENTS.md` — v2→v3 data migration (dry-run first)
- `MemoryProxy/AGENTS.md` — transparent LLM proxy, injection/write-back
- `MemoryPanel/AGENTS.md` — control backend (Hono, pnpm)
- `MemoryPanel/web/AGENTS.md` — React admin UI (npm, Vite)
- `MemoryKnowledge/AGENTS.md` — wiki + code-graph engine, `/v3` prefix
- `sdk/AGENTS.md` — TS + Python clients, v2 vs v3 planes
- `agents/AGENTS.md` — per-framework proxy wiring
- `deploy/AGENTS.md` — docker/compose images

## v2→v3 data migration (MemoryCore data format v2 → v3)

- Tool: `MemoryCore/scripts/migrate-v2-to-v3/v2-to-v3-migrate.py` (idempotent, auto-`.bak`, L2/L3 copied not moved). Details: `MemoryCore/scripts/migrate-v2-to-v3/AGENTS.md`.
- Root `MIGRATION v2 v3.md` is a copy; canonical doc is `MemoryCore/scripts/migrate-v2-to-v3/README.md`.
- Fresh installs skip migration (gateway creates v3 natively); run only for v1.x/v0.x data, before starting the new gateway.
