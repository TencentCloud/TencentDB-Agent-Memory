# TencentDB Agent Memory for Codex

- Use `agent_memory_recall` before work when historical context may affect the answer.
- Use `agent_memory_search` for structured memories and `agent_conversation_search` for exact prior wording.
- After meaningful work, use `agent_memory_capture` with a concise summary of new outcomes, decisions, changed files, and follow-ups. Do not copy recalled context verbatim.
- Use `agent_memory_session_end` when the Codex thread or task is complete.
- Memory is advisory. If the Gateway is unavailable, continue the task with the context already available.
