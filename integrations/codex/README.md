# Codex adapter

This integration exposes TencentDB Agent Memory as a standard stdio MCP server. The MCP process is intentionally thin: all memory reads and writes go through the existing local Gateway.

Build from the repository root with `npm run build:codex`, then configure the generated `memory-tencentdb-codex-mcp` command in Codex using the template under `templates/codex-config.example.toml`.

Recommended workflow:

1. Call `agent_memory_recall` before a task when prior preferences, project context, or decisions may matter.
2. Use `agent_memory_search` for structured facts and `agent_conversation_search` for exact raw evidence.
3. Call `agent_memory_capture` after meaningful work, recording only new durable outcomes.
4. Call `agent_memory_session_end` when a thread or task ends.

The adapter can start the Gateway automatically. If the Gateway is unavailable, tools return a readable degraded result and the Codex task can continue without memory context.
