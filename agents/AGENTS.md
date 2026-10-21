# AGENTS.md — agents (per-framework wiring)

One proxy URL pattern per supported coding agent. Zero-code integration: point base URL at MemoryProxy, keep key/model unchanged.

## OVERVIEW

Each framework dir (`openclaw/`, `hermes/`, `workbuddy/`, `claude-code/`, `codex/`, `codebuddy/`, `dsh/`, `opencode/`, `skills/`) holds a README with exact config. Canonical pattern:

- OpenAI-compatible: `http://127.0.0.1:8096/<framework>/default` (or `/proxy/<spaceId>/v1/chat/completions`)
- Anthropic: `.../v1/messages` variant
- `spaceId` in path = memory instance id (auth/injection/billing scope)

## RULES

- Clients connect to the **proxy** (`:8096`), never directly to the gateway (`:8420`) — gateway-direct bypasses injection/write-back.
- Exceptions on this machine: OpenClaw runs via `MemoryCore/openclaw-plugin` (not proxy); Hermes intentionally stays out (own memory).
- `setup-proxy.sh` needs jq + relative `TMPDIR`, overwrites agent configs with `*.bak.<ts>` backups (restore path documented in runbook).
- Per-agent user-keys: `MemoryCore/scripts/setup-agent-keys.py` (idempotent, registry `MemoryCore/.agent-keys.json`, gitignored).
- Per-framework quirks live in that framework's README; do not generalize across dirs.
- New framework = new dir + README (+ proxy adapter only if protocol needs it, see `MemoryProxy/src/session/` + `agent-adapters/`).

## NOTES

- `INSTALL.md` (root) holds full per-client setup; this dir holds the short per-framework form.
