# AGENTS.md — MemoryPanel/web (React admin UI)

Admin UI for teams/agents/assets. React 18 + Vite + Tailwind + Zustand, **npm** (backend uses pnpm — separate lockfiles). Dev `:5173` proxies `/api/v1` + `/health` to backend.

## OVERVIEW

Consumes only Panel public contracts (`../docs/api/`); `api_key` never reaches the browser. i18n via `i18n-migrate.cjs` (one-off migration script, not runtime).

## STRUCTURE

```
src/ (147 files)   # pages/components/stores per asset domain
public/            # static assets
vite.config.ts     # dev proxy /api/v1 + /health → 127.0.0.1:8123
tailwind.config.js postcss.config.js .eslintrc.cjs .prettierrc
.env.example       # template only, never real values
```

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| API shapes | `MemoryPanel/docs/api/` | never infer from network tab |
| Proxy behavior | `vite.config.ts` | backend must run for `npm run dev` |
| Prod build output | `web/dist/` (gitignored) | served by deploy image |

## CONVENTIONS (differ from parent)

- `npm run dev|build` here; backend `pnpm` commands do not apply.
- Prettier + eslint configs local to `web/`; keep formatting inside this dir consistent with them, not with backend style.

## ANTI-PATTERNS

- Never hardcode backend URLs — use the vite proxy in dev, relative paths in prod.
- Never log or render `user_key` / `api_key`; never commit `.env`.

## COMMANDS

```bash
npm install && npm run dev     # needs backend on :8123
npx vite build                 # → web/dist/ (NOT npm run build: tsc aborts on src/stores/backend.ts TS7006)
```
