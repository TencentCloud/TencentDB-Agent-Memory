# LangGraph Adapter

This directory provides LangGraph-oriented primitives for integrating
`memory-tencentdb` through the Gateway API without adding a new public SDK.

## Capabilities

- `recallForLangGraph()` runs before the model node and returns memory context.
- `captureForLangGraph()` runs after the model node and records the completed
  user/assistant turn.
- `runMemoryWrappedTurn()` demonstrates the common recall -> model -> capture
  flow.
- `createMemoryTencentDbSearchTool()` exposes structured memory search as a
  tool-like object that can be wrapped by a LangGraph tool node.

## Session Mapping

| LangGraph runtime field | Gateway field |
| --- | --- |
| `runtime.context.thread_id` | `session_key`, `session_id` |
| `runtime.configurable.thread_id` | fallback `session_key`, `session_id` |
| `runtime.context.userId` | `user_id` |
| user input | `query`, `user_content` |
| model output | `assistant_content` |

## Usage

```ts
import { runMemoryWrappedTurn } from "./integrations/langgraph/adapter.js";

const result = await runMemoryWrappedTurn({
  input: "What did we decide about the schema?",
  runtime: {
    context: {
      thread_id: "repo-a:thread-1",
      userId: "developer-a",
    },
  },
  model: async (prompt) => callYourModelNode(prompt),
});
```

Use LangGraph short-term memory/checkpointers for immediate graph state and
TencentDB Agent Memory for cross-session recall. Keep the same `thread_id`
across graph invocations when the conversation should share long-term memory.

