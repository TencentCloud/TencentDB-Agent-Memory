---
name: tdai-memory
description: This skill should be used when working with TencentDB Agent Memory / memory-tencentdb in Claude Code, including memory recall, conversation capture, Claude Code hooks, CLAUDE.md memory prompt setup, MCP tool usage, or debugging the TDAI memory CLI.
version: 0.1.0
---

# TDAI Memory

TencentDB Agent Memory exposes long-term memory through three Claude Code-facing surfaces:

- MCP tools for agent-facing memory lookup.
- Hook CLI commands for health checks, recall prefetch, capture, and flush.
- User-level `CLAUDE.md` stable memory capability instructions installed by `scripts/install-claude-code.sh`.

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

The Claude Code plugin is a thin integration layer. The reusable adapter packages live
under `packages/` and should be installed so `tdai-memory-mcp`,
`tdai-memory`, and `tdai-memory-hook` are importable or on PATH.

Common Gateway environment:

```bash
TDAI_GATEWAY_URL=http://127.0.0.1:8421
TDAI_USER_ID=claude-code
```

## Install

Use the install script to set up the plugin, hooks, and user-level `CLAUDE.md`:

```bash
<repo>/scripts/install-claude-code.sh
```

The script is idempotent. It installs shared packages, registers the local
Claude Code plugin marketplace, installs the `tdai-memory-claude-code` plugin,
creates or updates only the marked TDAI block in `~/.claude/CLAUDE.md`, and
writes plugin MCP/hook config under `plugins/tdai-memory-claude-code/`.

Default runtime files are user-level and stable across repositories:

- Hook diagnostics: `~/.claude/tdai-memory/logs/hooks.jsonl`
- Plugin hooks: `plugins/tdai-memory-claude-code/hooks/hooks.json`
- Plugin MCP config: `plugins/tdai-memory-claude-code/.mcp.json`

## CLI Commands

### Session Start

Normally called by the `SessionStart` hook to check Gateway availability:

```bash
TDAI_GATEWAY_URL=http://127.0.0.1:8421 \
tdai-memory session-start
```

### Prefetch

Normally called by the `UserPromptSubmit` hook:

```bash
TDAI_GATEWAY_URL=http://127.0.0.1:8421 \
tdai-memory prefetch --query "<user prompt>"
```

### Sync Turn

Normally called by the `Stop` hook:

```bash
TDAI_GATEWAY_URL=http://127.0.0.1:8421 \
tdai-memory sync-turn \
  --user-content "<user message>" \
  --assistant-content "<assistant response>"
```

### End Session

Use when the Claude Code session/process ends or when manually flushing memory work:

```bash
TDAI_GATEWAY_URL=http://127.0.0.1:8421 \
tdai-memory end-session
```

## Hook Commands

Use hook wrappers when reading Claude Code hook JSON from stdin:

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
- Keep `CLAUDE.md` updates in the install script, not runtime hooks.
- Do not store dynamic recall results in `CLAUDE.md`.
- Do not modify the original Gateway, Core, Hermes provider, or OpenClaw plugin code for Claude Code adapter work.
