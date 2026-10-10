# CLAUDE.md — TencentDB-Agent-Memory

This file mirrors the project rule set. **Single source of truth is `AGENTS.md`** — read it first, then the nearest subdir `AGENTS.md` before editing. This file only lists what differs or deserves emphasis for Claude-compatible agents (Claude Code, OpenCode, Hermes share this repo).

## Core rules (read AGENTS.md for details)

- Stack: 4 Node services (`MemoryCore` :8420, `MemoryProxy` :8096, `MemoryPanel` backend + `web/`, `MemoryKnowledge` :8421) + `sdk/` + `deploy/`. No repo-wide runner — verify inside the touched module (`npm test`, `typecheck` script).
- **Node split is strict:** Proxy + Knowledge = Node 22 only (proxy hard-exits otherwise); Panel backend builds first (`npm run build` → `dist/index.js`). Never "fix" this by switching versions.
- Ports differ local vs docker (Panel 8321/8125/8123, Knowledge 8421/8424) — check `.env`, never assume. Knowledge routes mount `/v3` once in `src/server.ts`; `/v3/health` 404s by design.
- Start order: gateway first (~25s auth), then proxy+knowledge, panel last. `stack-start.cmd` / `stack-stop.cmd` contain machine-specific paths — adjust locally, keep uncommitted.
- Commits: Conventional Commits + DCO sign-off (`git commit -s`), scope = module (`memory-core`, `panel`, `knowledge`, `proxy`, `sdk-ts`, `sdk-py`, `deploy`, `docs`). PRs target `develop_server_team` or `master`.
- Clients connect to the **proxy** (`:8096/<framework>/default`), never gateway-direct.

## Mandatory before code changes

- Bug fixes ship with a failing-first regression test; TS comments explain *why*; import order builtins → third-party → internals.
- Secrets: two LLM groups (`MEMORY_*`, `PROXY_*`); never commit `.env`, `*.db`/`vectors.db`, `dist/`, `*.log`, real `metadata-instances.json`. Security reports to agentmemory@tencent.com, not public issues.
- v3 API plane requires `team_id` + `agent_id` + `user_id`; v2 is compat-only. New integrations use v3.

## Migration work (v2→v3 data format)

- Tool: `MemoryCore/scripts/migrate-v2-to-v3/v2-to-v3-migrate.py` — dry-run first, before starting the new gateway, never on a live data dir. Details in `MemoryCore/scripts/migrate-v2-to-v3/AGENTS.md`.
- Fresh installs skip migration entirely.
