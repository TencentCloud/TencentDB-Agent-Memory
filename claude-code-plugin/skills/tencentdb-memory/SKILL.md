---
name: tencentdb-memory
description: Search persistent TencentDB Agent Memory when the current task depends on decisions, preferences, facts, or conversations from earlier Claude Code sessions.
---

# TencentDB Agent Memory

Automatic recall runs before each user prompt, and automatic capture runs after
each completed assistant turn. Do not manually capture ordinary turns.

Use `tdai_memory_search` when the injected memories are insufficient and the
task depends on a durable fact, preference, or decision. Use
`tdai_conversation_search` when exact wording or chronological conversation
history matters. Keep queries specific and use the smallest useful result
limit.

If a memory conflicts with the current user message, follow the current message
and treat the older memory as stale.
