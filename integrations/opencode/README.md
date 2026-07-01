# OpenCode Adapter

This directory provides a full OpenCode integration plan for `memory-tencentdb`.

## Capabilities

- `opencode.jsonc` registers a local MCP server for stable, explicit memory
  search tools.
- `.opencode/tools/memory-tencentdb.ts` style helpers call Gateway recall,
  capture, search, and session flush endpoints directly.
- `.opencode/plugins/memory-tencentdb.ts` style helper performs best-effort
  automatic recall/capture from OpenCode-like prompt and assistant events.

## Stable Path

Use MCP or custom tools for explicit memory operations. This path does not
depend on automatic event payload completeness:

- `searchMemories()` -> `POST /search/memories`
- `searchConversations()` -> `POST /search/conversations`
- `recallMemory()` -> `POST /recall`

## Enhanced Path

Use the plugin helper when OpenCode events provide both user prompt and final
assistant output:

- `onUserPrompt()` recalls context and caches the prompt by session key.
- `onAssistantMessage()` pairs the cached prompt with the assistant output and
  calls `/capture`.
- `onSessionEnd()` flushes delayed work with `/session/end`.

## Session Mapping

| OpenCode-like event field | Gateway field |
| --- | --- |
| `session_id`, `thread_id` | `session_key`, `session_id` |
| `cwd` | fallback hashed `session_key` |
| `user_id` / `userId` | `user_id` |
| prompt/input/message | `query`, `user_content` |
| assistant output | `assistant_content` |

## Setup

1. Start the Gateway at `http://127.0.0.1:8420`.
2. Copy `opencode.jsonc` into the project OpenCode config layer.
3. Copy the tool and plugin helpers into `.opencode/tools/` and
   `.opencode/plugins/`, or import them from this package during local
   development.
4. Set `MEMORY_TENCENTDB_GATEWAY_API_KEY` if the Gateway requires auth.

