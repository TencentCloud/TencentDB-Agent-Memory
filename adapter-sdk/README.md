# TencentDB Agent Memory Adapter SDK

This SDK keeps platform adapters thin. A platform only implements one adapter
interface that describes its lifecycle events, session identity, user query,
completed turn, and recalled-context injection. The SDK handles Gateway HTTP
calls, fail-open behavior, and optional turn state.

The platform interface has the same conceptual shape in Node.js and Python:

| Method | Required for | Purpose |
| --- | --- | --- |
| `event(request)` | all platforms | Return `recall`, `capture`, `session_end`, or `ignore`. |
| `session(request, context)` | all active events | Return `sessionKey`, optional `sessionId`, and optional `userId`. |
| `recallQuery(request, context)` / `recall_query(...)` | recall | Extract the current user query. |
| `injectRecall(contextText, request, context)` / `inject_recall(...)` | recall | Convert recalled memory into the platform's context-injection format. |
| `completedTurn(request, context)` / `completed_turn(...)` | capture | Extract the final user/assistant turn for `/capture`. |
| `passThrough(request, context)` / `pass_through(...)` | all events | Return the platform's no-op result. |

Optional lifecycle hooks such as `beforeRecall`, `afterCapture`, and
`afterSessionEnd` can persist local state or clean up platform resources.

## Node.js

Use `adapter-sdk/node/index.mjs` for command-hook style platforms such as
Claude Code.

```js
import {
  MemoryAdapterRuntime,
  TdaiGatewayClient,
} from "../adapter-sdk/node/index.mjs";

const platform = {
  event(input) {
    return input.hook_event_name === "UserPromptSubmit" ? "recall" : "ignore";
  },
  session(input) {
    return { sessionKey: input.session_id, sessionId: input.session_id };
  },
  recallQuery(input) {
    return input.prompt;
  },
  injectRecall(context) {
    return { additionalContext: context };
  },
  passThrough() {},
};

const runtime = new MemoryAdapterRuntime({
  platform,
  client: new TdaiGatewayClient(),
});
```

## Python

Use `adapter-sdk/python/tdai_adapter_sdk` for Python agent frameworks such as
DeerFlow and LangGraph.

```python
from tdai_adapter_sdk import AdapterSession, TdaiAdapterRuntime


class Platform:
    def event(self, request):
        return "recall"

    def session(self, request):
        return AdapterSession(session_key=request["thread_id"])

    def recall_query(self, request, context):
        return request["text"]

    def inject_recall(self, context_text, request, context):
        return {"memory_context": context_text}

    def pass_through(self, request, context):
        return None


runtime = TdaiAdapterRuntime(platform=Platform())
```

Supported lifecycle event names are `recall`, `capture`, `session_end`, and
`ignore`.

See also:

- `claude-code-adapter/` for a command-hook Node.js integration.
- `deer-flow-adapter/` for a LangChain middleware integration.
- `langgraph-adapter/` for a LangGraph node integration.
