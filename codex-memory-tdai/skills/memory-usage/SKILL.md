---
name: memory-usage
description: How to use the TencentDB Agent Memory (Tdai) system from within Codex — recalling memory context and running on-demand memory/conversation searches.
---

# TencentDB Agent Memory (Tdai) — Usage

The `memory-tdai` plugin automatically recalls relevant long-term memory and
injects it into your context before each prompt (`UserPromptSubmit` hook →
Gateway `/recall`), and records each conversation turn after your turn ends
(`Stop` hook → Gateway `/capture`).

## On-demand search (MCP tools)

When the MCP server is enabled, you can call these tools directly:

- `search_memories(query, limit?, type?, scene?)` — search the structured
  L1 memory store (records, scenes, persona).
- `search_conversations(query, limit?, session_key?)` — search raw past
  conversations (L0).

Use them when you need to dig deeper than the auto-injected context, e.g. to
recall a specific decision, convention, or past solution.

## Notes

- The gateway must be running on `http://127.0.0.1:8420` (override with the
  `TDAI_GATEWAY_URL` env var).
- Memory is best-effort: if the gateway is unavailable, hooks fail silently and
  never block your work.
