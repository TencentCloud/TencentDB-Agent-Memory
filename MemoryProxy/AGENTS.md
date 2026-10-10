# AGENTS.md — MemoryProxy

Transparent LLM proxy (`:8096`): session init, memory/skill injection, conversation write-back, auth, billing. Persists no memory data — every read/write goes to MemoryCore `:8420`.

## OVERVIEW

Forwards OpenAI `/v1/chat/completions` + Anthropic `/v1/messages` verbatim; runs 8-stage pipeline (auth → systemUser → sessionInit → injection → rateLimit → forward → extract → report) around each main-model call. **Node 22 only** — hard-exits on other majors (`src/index.ts` gate).

## STRUCTURE

```
src/index.ts server.ts handler.ts anthropicHandler.ts  # entry + routing + handlers
src/session/      # init form flow (team→agent→task), adapters per agent
src/injection/    # skill / knowledge / tdai-memory injectors
src/tdai/         # L0/L1/L2/L3 client + pending-write queue
src/skill/ src/memory/ src/knowledge/ src/meta/  # bridge clients to core
src/storage/ src/db/  # ProxyStorage abstraction + repos (inj:*/sk:*/vpin:*)
src/rate-limit/ src/routes/  # TPM/QPM + admin endpoints
clickhouse.ts langfuse.ts opik.ts credit-reporter.ts pricing.ts
gateway/          # optional load-balancing gateway (keyId consistent hashing)
config.example.yaml  # fully-commented config; precedence CLI > YAML > defaults
proxy.sh          # background/daemon runner (own config.yaml, dated logs)
```

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| Pipeline order | README "Request pipeline" + `handler.ts` | 8 stages, do not reorder |
| Injection switches | `config.example.yaml` (`injection`, `tdai`, `skill`, `knowledge`, `skillRuntime`) | memory-relevant sections |
| Session state backend | `storage/` (`cos`/`sqlite`/`fs`/`memory`, degrade chain) | observe via `/health.storage.effective` |
| Per-agent upstream override | `upstream.agents` (e.g. route `claude-code` via CCR) | — |
| Bridges (no LLM-visible creds) | `skill/` + `memory/` (`serviceToken` injected on forward) | — |

## CONVENTIONS (differ from root)

- Run via tsx, no build step (`npm run start:config` = `node --import tsx/esm src/index.ts --config config.yaml`); `proxy.sh` for background.
- Local dev without Redis: `redis.enabled: false` + `storage.enabled: true` (`sqlite`), else `ECONNREFUSED :6379` spam.
- `skillRuntime.allowLlmWrite` default read-only; enabling lets model write skills via curl tools.
- Tests colocated per submodule (`session/__tests__`, `storage/__tests__`, …); e2e = runbooks in `docs/`, not vitest.

## ANTI-PATTERNS

- Never store memory in proxy state — bridges call MemoryCore.
- Never commit `config.yaml`, `logs/`, `*.db`, `*.pid`, `session*.json`.
- Multi-node requires `storage.backend=cos` + `injection.externalGatewayUrl`, else per-instance caches cause KV-cache misses.
- Never return raw errors with secrets; `/whoami` is plain-text keyId only.

## COMMANDS

```bash
cp config.example.yaml config.yaml   # edit upstream/auth/tdai first
npm run start:config                  # ./proxy.sh start for background
curl http://127.0.0.1:8096/health
npm test && npx tsc --noEmit
```
