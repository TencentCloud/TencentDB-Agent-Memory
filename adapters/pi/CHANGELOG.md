# Changelog

## 0.1.0

Initial Pi adapter for TencentDB Agent Memory v3.

- Recall long-term memory on `before_agent_start`; capture completed turns on `agent_settled`.
- Skill pipeline: ordered `assistant`/`tool_call`/`tool_result` tracing written to `/v3/skill/conversation/add`.
- Dual independent pipelines (L0 + Skill) with append-only versioned markers and reload compensation.
- Production-grade capture path: serialized flush, exponential backoff, retry cap, bounded pending queue, non-blocking startup.
- Independent redaction module with closed/unclosed recall-block handling and secret-pattern scrubbing; recalled data wrapped as untrusted.
- Client-generated `client_message_id` idempotency keys to close the duplicate-capture window.
- Native `tdai_memory_search` and `tdai_conversation_search` tools plus the `/tdai-memory-status` command.
- Equivalent English and Simplified Chinese documentation.
