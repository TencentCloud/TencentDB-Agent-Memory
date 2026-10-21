# AGENTS.md — MemoryPanel backend

Stateless team-memory control backend (Hono, **pnpm**): teams/users/agents/tasks + asset binding, credential check + forward. No login sessions, no local user DB. Default `:8123` locally (`:8321` via local `.env`, `:8125` docker).

## OVERVIEW

Public API all under `/api/v1` (`meta`, `skill`, `chat-memory`, `knowledge`, `agent-overview`, `agent`). Aggregates MemoryCore + Knowledge Service; persistence lives in external services. Frontend is `web/` (separate AGENTS.md, npm).

## STRUCTURE

```
src/index.ts                    # entry
src/panel/config/               # config + instance registry
src/panel/domain/               # domain rules
src/panel/http/                 # middleware + public routes (/api/v1)
src/panel/kernel/               # external service adapters
src/panel/infra/ src/panel/startup/
config/metadata-instances.example.json  # instance registry template (gitignored real file)
tests/                          # unit + e2e (panel meta, knowledge chain)
scripts/                        # openapi gen, secret scan, mocks
docs/api/                       # public contracts (source of truth for compat)
```

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| Public contract | `docs/api/` + route registration in `src/panel/http/` | unlisted external interfaces = no compat promise |
| Instance credentials | `config/metadata-instances.json` (gitignored) | never in image/examples/repo |
| Knowledge wiring | Panel `.env` `KNOWLEDGE_SERVICE_URL` (no `/v3`) | KS side differs, see Knowledge AGENTS.md |
| E2E | `tests/` (`e2e-panel-meta.sh`, `e2e-knowledge-chain.ts`) | `E2E_MODE=full` for full chain |

## CONVENTIONS (differ from root)

- **pnpm** for backend (`pnpm dev|build|test`), **npm** for `web/` — do not mix lockfiles.
- Must build before serving: `npm run build` → `dist/index.js`, started as `node dist/index.js` (`stack-start.cmd` enforces).
- `user_key` via request header only — never logs/docs/frontend assets.
- Pre-commit: `bash scripts/secret-scan.sh --strict`; docs/examples use `example.com`/loopback/placeholders only.

## ANTI-PATTERNS

- Never return instance `api_key` to the browser; never bake keys into images or examples.
- Never commit `.env`, real `metadata-instances.json`, smoke env files, logs, test reports.
- Leaked credential in git history = rotate immediately + clean history before publish.

## COMMANDS

```bash
pnpm install && cp .env.example .env   # + metadata-instances.json from example
pnpm dev                                # :8123, /health
pnpm build && node dist/index.js
pnpm typecheck && pnpm test
bash scripts/secret-scan.sh --strict
```
