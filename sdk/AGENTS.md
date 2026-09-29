# AGENTS.md — sdk (clients)

TypeScript + Python clients for MemoryCore. Adapters (OpenClaw/Hermes/custom) build on these; never reimplement HTTP against the gateway.

## OVERVIEW

Two packages under `sdk/memory-core/`: `typescript/` (includes `v3/` plane: memory/skill/metadata/prompt/generation-log clients) and `python/` (`tencentdb_agent_memory` with `v2/` + `v3/` modules). New integrations use **v3** (tenant-isolated: team/agent/user required).

## STRUCTURE

```
sdk/memory-core/typescript/src/  # client.ts http.ts types.ts cos.ts errors.ts + v3/
sdk/memory-core/typescript/      # package.json, tsconfig, vitest.config, pnpm-workspace.yaml
sdk/memory-core/python/tencentdb_agent_memory/  # _http.py _v3_http.py v2/ v3/ cos.py errors.py
sdk/memory-core/python/          # pyproject.toml
*/AGENT_GUIDE.*.md               # per-language integration guides (zh-CN)
*/CHANGELOG.md */README*.md
```

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| New TS integration | `typescript/src/v3/client.ts` + `skill-client.ts` | v2 client legacy only |
| New Python integration | `python/.../v3/client.py` + `skill_client.py` | mirrors TS surface |
| Adapter responsibilities | MemoryCore README: L0 write → L1/L2/L3 recall → bounded injection | 3-step contract |
| Error shapes | `errors.ts` / `errors.py` | typed, match these |

## CONVENTIONS

- Keep TS + Python surfaces in sync; changelog both packages on API change.
- Guides (`AGENT_GUIDE`) updated when client semantics change, not just READMEs.

## COMMANDS

```bash
# typescript (own workspace)
cd sdk/memory-core/typescript && npm test   # vitest
# python — see pyproject.toml (project uses Python ≥ 3.9 only here + migrate scripts)
```
