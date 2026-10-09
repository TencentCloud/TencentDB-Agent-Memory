---
name: tdai-memory
description: Use when working with TencentDB Agent Memory, including memory recall, conversation capture, agent hooks, MCP lookup tools, and debugging the TDAI memory CLI.
version: 0.1.0
---

# TDAI Memory

TencentDB Agent Memory exposes long-term memory through two reusable surfaces:

- MCP tools for agent-facing memory lookup.
- Hook CLI commands for health checks, recall prefetch, capture, and flush.

## Choose The Surface

Use MCP tools for answering with memory:

- `tdai_memory_search`: search structured long-term memories.
- `tdai_conversation_search`: search raw conversation history.

Use CLI commands for hook behavior:

- `session-start`: check Gateway health for the hook runtime.
- `prefetch`: recall memory context for a user query.
- `sync-turn`: capture a completed user/assistant turn.
- `end-session`: flush session pipeline work.

Do not use CLI commands as a substitute for MCP lookup unless debugging the adapter.

## CLI Commands

```bash
tdai-memory session-start
tdai-memory prefetch --query "<user prompt>"
tdai-memory sync-turn \
  --user-content "<user message>" \
  --assistant-content "<assistant response>"
tdai-memory end-session
```

Use hook wrappers when reading agent hook JSON from stdin:

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
- Keep `AGENTS.md` or `CLAUDE.md` updates in an explicit installer/plugin step, not runtime hooks.
- Do not store dynamic recall results in `AGENTS.md` or `CLAUDE.md`.
