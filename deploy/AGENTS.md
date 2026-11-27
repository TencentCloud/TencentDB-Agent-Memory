# AGENTS.md — deploy (images)

Docker/compose deployment. Local Windows path is `stack-start.cmd` (root); this dir is the Linux/docker path.

## OVERVIEW

- `global-images/` — all-services compose: `cp .env.example .env` (fill **both** LLM groups `MEMORY_*` + `PROXY_*`), `./start-all.sh`, `./stop-all.sh`.
- `panel-knowledge-combined/` — Panel + Knowledge single image (`agentmemory/memory-hub`).
- `dockerhub/` — publish metadata.

## RULES

- Never commit filled `.env`; never bake keys/STS into images or configs.
- Port mapping per service in root AGENTS.md table; Panel/Knowledge ports differ local-vs-docker — verify `.env`, never assume.
- Mount configs read-only (`:ro`); persist data dirs in named volumes.

## COMMANDS

```bash
cd deploy/global-images && cp .env.example .env   # fill both LLM groups
./start-all.sh     # prints paste-ready agent one-liner at end
./stop-all.sh
```
