# Platform Adapter Comparison

Issue #235 asks for reusable memory integration paths beyond the original
OpenClaw and Hermes surfaces. This comparison summarizes the concrete adapter
paths added for Dify, LangGraph, and OpenCode.

| Platform | Integration surface | Recall | Capture | Search tools | Session key |
| --- | --- | --- | --- | --- | --- |
| OpenClaw | Native plugin hooks/tools | automatic | automatic | native tools | OpenClaw session |
| Hermes | Gateway provider | provider lifecycle | provider lifecycle | Gateway HTTP | Hermes conversation |
| Dify | Custom Tool, HTTP Request, MCP | workflow HTTP pre-step | workflow HTTP post-step | Custom Tool or MCP | `conversation_id` |
| LangGraph | Graph node/tool primitives | graph node before model | graph node after model | tool-like object | `thread_id` |
| OpenCode | MCP, custom tools, plugin helper | MCP/tool or plugin event | tool or plugin event | MCP/custom tools | session/thread/cwd |

## Design Notes

- All new adapters use the existing Gateway API and do not introduce a public
  SDK export.
- Dify is strongest for low-code workflow composition: the OpenAPI schema and
  HTTP Request workflow expose every Gateway operation with minimal code.
- LangGraph is strongest for developer-controlled graph orchestration: recall
  and capture are explicit nodes around the model call.
- OpenCode's stable path is MCP/custom tools. Automatic plugin capture is
  best-effort because it depends on event payloads containing both the user
  prompt and final assistant output.

## Gateway Contract

| Operation | Endpoint | Used by |
| --- | --- | --- |
| Recall before model input | `POST /recall` | Dify, LangGraph, OpenCode |
| Capture completed turn | `POST /capture` | Dify, LangGraph, OpenCode |
| Search structured memories | `POST /search/memories` | Dify, LangGraph, OpenCode |
| Search raw conversations | `POST /search/conversations` | Dify, OpenCode |
| Flush a session | `POST /session/end` | Dify, OpenCode |

