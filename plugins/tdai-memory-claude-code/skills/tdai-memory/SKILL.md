---
name: tdai-memory
description: This skill should be used when working with TencentDB Agent Memory / memory-tencentdb in Claude Code, including memory recall, conversation capture, Claude Code hooks, Gateway startup, CLAUDE.md memory prompt setup, MCP tool usage, or debugging the TDAI memory CLI.
version: 0.1.0
---

# TDAI Memory

TencentDB Agent Memory exposes long-term memory through three Claude Code-facing surfaces:

- MCP tools for agent-facing memory lookup.
- Hook CLI commands for lifecycle setup, recall prefetch, capture, and flush.
- User-level `CLAUDE.md` stable memory capability instructions installed by `scripts/install-claude-code.sh`.

## Choose The Surface

Use MCP tools for answering with memory:

- `tdai_memory_search`: search structured long-term memories (L1).
- `tdai_conversation_search`: search raw conversation history (L0).

Use CLI commands for lifecycle and hook behavior:

- `session-start`: ensure Gateway is running.
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
TDAI_GATEWAY_AUTO_START=1
TDAI_GATEWAY_CONFIG=/Users/bytedance/.claude/tdai-memory/tdai-gateway.yaml
TDAI_DATA_DIR=/Users/bytedance/.claude/tdai-memory/data
TDAI_GATEWAY_CWD=/Users/bytedance/proj/TencentDB-Agent-Memory
TDAI_GATEWAY_RUNTIME_DIR=/Users/bytedance/.claude/tdai-memory/runtime
TDAI_GATEWAY_LOG_DIR=/Users/bytedance/.claude/tdai-memory/logs
TDAI_GATEWAY_IDLE_TIMEOUT_SECONDS=600
TDAI_GATEWAY_WATCHDOG_INTERVAL_SECONDS=30
TDAI_USER_ID=claude-code
```

## Install

Use the install script to set up the plugin, hooks, and user-level `CLAUDE.md`:

```bash
/Users/bytedance/proj/TencentDB-Agent-Memory/scripts/install-claude-code.sh
```

The script is idempotent. It installs shared packages, registers the local
Claude Code plugin marketplace, installs the `tdai-memory-claude-code` plugin,
creates or updates only the marked TDAI block in `~/.claude/CLAUDE.md`, and
writes plugin MCP/hook config under `plugins/tdai-memory-claude-code/`.

Default runtime files are user-level and stable across repositories:

- Gateway config: `~/.claude/tdai-memory/tdai-gateway.yaml`
- Memory data: `~/.claude/tdai-memory/data/`
- Hook diagnostics: `~/.claude/tdai-memory/logs/hooks.jsonl`
- Plugin hooks: `plugins/tdai-memory-claude-code/hooks/hooks.json`
- Plugin MCP config: `plugins/tdai-memory-claude-code/.mcp.json`
- Gateway/watchdog logs: `~/.claude/tdai-memory/logs/gateway.log`, `~/.claude/tdai-memory/logs/gateway-watchdog.log`
- Gateway pid/heartbeat: `~/.claude/tdai-memory/runtime/`

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
- Use CLI commands for lifecycle setup, capture, and flush.
- Keep `CLAUDE.md` updates in the install script, not runtime hooks.
- Do not store dynamic recall results in `CLAUDE.md`.
- Do not modify the original Gateway, Core, Hermes provider, or OpenClaw plugin code for Claude Code adapter work.
