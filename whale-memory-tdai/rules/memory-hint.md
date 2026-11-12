# TencentDB Agent Memory

This session has access to the **TencentDB Agent Memory** system. Relevant
long-term memory is automatically recalled and injected into your context
before each prompt. After each turn, the conversation is captured for future
recall.

When you need to recall specific past decisions, conventions, or solutions
beyond the auto-injected context, use the `memory-tdai` MCP tools
(`search_memories`, `search_conversations`) or the `/memory-tencentdb:memory`
slash command.
