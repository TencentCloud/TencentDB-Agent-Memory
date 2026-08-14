---
name: tdai-memory
description: Use when working with TencentDB Agent Memory / memory-tencentdb in Codex, including memory recall, conversation capture, Codex hooks, AGENTS.md memory prompt setup, MCP tool usage, or debugging the TDAI memory CLI.
---

# TDAI Memory

TencentDB Agent Memory exposes long-term memory through three Codex-facing surfaces:

- MCP tools for agent-facing memory lookup.
- Hook CLI commands for health checks, recall prefetch, capture, and flush.
- User-level `AGENTS.md` stable memory capability instructions installed by `scripts/install-codex.sh`.

## Choose The Surface

Use MCP tools for answering with memory:

- `tdai_memory_search`: search structured long-term memories (L1).
- `tdai_conversation_search`: search raw conversation history (L0).

Use CLI commands for hook behavior:

- `session-start`: check Gateway health.
- `prefetch`: recall memory context for a user query.
- `sync-turn`: capture a completed user/assistant turn.
- `end-session`: flush session pipeline work.

Do not use CLI commands as a substitute for MCP lookup unless debugging the adapter.

## Environment

The Codex plugin is a thin integration layer. The reusable adapter packages live
under `packages/` and should be installed so `tdai-memory-mcp`,
`tdai-memory`, and `tdai-memory-hook` are importable or on PATH.

Common Gateway environment:

```bash
TDAI_GATEWAY_URL=http://127.0.0.1:8420
TDAI_USER_ID=codex
```

## Install

Use the install script to set up the plugin, hooks, and user-level `AGENTS.md`:

```bash
<repo>/scripts/install-codex.sh
```

The script is idempotent. It installs shared packages, registers the local
Codex plugin, registers the `tdai-memory` MCP server with Codex, creates or
updates only the marked TDAI block in `~/.codex/AGENTS.md`, writes bundled
plugin hooks to `plugins/tdai-memory/hooks/hooks.json`, and removes legacy
tdai-memory entries from `~/.codex/hooks.json`. Use
`--agents-path /path/to/AGENTS.md` only when a non-default AGENTS file should
be updated.

Codex plugin-bundled hooks require manual trust review after installation.
Open `/hooks`, review the three TDAI hook commands, and trust them before
expecting automatic prefetch/capture to run.

Default runtime files are user-level and stable across repositories:

- Hook diagnostics: `~/.codex/tdai-memory/logs/hooks.jsonl`
- Bundled plugin hooks: `plugins/tdai-memory/hooks/hooks.json`

## CLI Commands

### Session Start

Normally called by the `SessionStart` hook to check Gateway availability:

```bash
TDAI_GATEWAY_URL=http://127.0.0.1:8420 \
tdai-memory session-start
```

### Prefetch

Normally called by the `UserPromptSubmit` hook:

```bash
TDAI_GATEWAY_URL=http://127.0.0.1:8420 \
tdai-memory prefetch --query "<user prompt>"
```

### Sync Turn

Normally called by the `Stop` hook:

```bash
TDAI_GATEWAY_URL=http://127.0.0.1:8420 \
tdai-memory sync-turn \
  --user-content "<user message>" \
  --assistant-content "<assistant response>"
```

### End Session

Use when the Codex session/process ends or when manually flushing memory work:

```bash
TDAI_GATEWAY_URL=http://127.0.0.1:8420 \
tdai-memory end-session
```

## Hook Commands

Use hook wrappers when reading Codex hook JSON from stdin:

```bash
tdai-memory-hook session-start
tdai-memory-hook prefetch
tdai-memory-hook sync-turn
tdai-memory-hook end-session
```

Hook failures are non-blocking by default. Set `TDAI_HOOK_STRICT=1` only for tests or debugging.

## Rules

- Prefer MCP tools when using memory to answer a user question.
- Use CLI commands for health checks, capture, and flush.
- Keep `AGENTS.md` updates in the install script, not runtime hooks.
- Do not store dynamic recall results in `AGENTS.md`.
- Do not modify the original Gateway, Core, Hermes provider, or OpenClaw plugin code for Codex adapter work.
