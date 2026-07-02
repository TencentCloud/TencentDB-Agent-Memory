# Platform Adapter Comparison: Codex and Kimi Code

TencentDB Agent Memory now supports multiple coding-agent platforms through thin MCP adapters backed by the existing TDAI Gateway.

## Summary

Both Codex and Kimi Code integrations use the same architecture:

```text
Agent platform -> stdio MCP server -> TDAI Gateway HTTP API -> TdaiCore
```

The adapters do not initialize `TdaiCore` directly. They forward MCP tool calls to the already-running Gateway.

## Shared Gateway API

Both adapters use these Gateway endpoints:

| Capability | Gateway endpoint |
| --- | --- |
| Recall memory context | `POST /recall` |
| Capture a completed turn | `POST /capture` |
| Search structured memories | `POST /search/memories` |
| Search raw conversations | `POST /search/conversations` |
| Flush a session | `POST /session/end` |

## Platform Comparison

| Area | Codex | Kimi Code |
| --- | --- | --- |
| Adapter type | stdio MCP server | stdio MCP server |
| Runtime path | `src/adapters/codex/` | `src/adapters/kimicode/` |
| Launch command | `npm run codex:mcp` | `kimicode-memory-mcp` |
| Gateway URL | `TDAI_GATEWAY_URL`, default `http://127.0.0.1:8420` | `TDAI_GATEWAY_URL`, default `http://127.0.0.1:8420` |
| Gateway auth | `TDAI_GATEWAY_API_KEY` Bearer token | `TDAI_GATEWAY_API_KEY` Bearer token |
| Tool transport | Model Context Protocol over stdio | Model Context Protocol over stdio |
| Plugin/skill support | Codex MCP configuration | Kimi plugin manifest and plugin README |
| Tool prefix | `tdai_*` | `tdai_*` |
| Requires Gateway | Yes | Yes |
| Automatic lifecycle hooks | No | No |
| Explicit recall | Yes | Yes |
| Explicit capture | Yes | Yes |
| Explicit search | Yes | Yes |
| Explicit session flush | Yes | Yes |

## Tool Mapping

| Tool | Codex | Kimi Code | Gateway endpoint |
| --- | --- | --- | --- |
| Recall | `tdai_recall` | `tdai_recall` | `POST /recall` |
| Capture | `tdai_capture` | `tdai_capture` | `POST /capture` |
| Memory search | `tdai_memory_search` | `tdai_memory_search` | `POST /search/memories` |
| Conversation search | `tdai_conversation_search` | `tdai_conversation_search` | `POST /search/conversations` |
| Session end | `tdai_session_end` | `tdai_session_end` | `POST /session/end` |

## Important Limitation

MCP tools are explicit tool calls. They are not equivalent to OpenClaw lifecycle hooks.

These adapters do not automatically intercept prompts, inject memory into every turn, or capture every completed response. The agent must call recall, capture, search, and session-end tools explicitly.

## Related Pull Requests

- Codex adapter: TencentCloud/TencentDB-Agent-Memory#367
- Kimi Code adapter: separate PR from `XiZu233:feat/kimicode-adapter-issue-235`

Both PRs together address issue #235 by adding two platform adapters and documenting their differences.
