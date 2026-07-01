# LangGraph Adapter

This adapter demonstrates using the shared TencentDB Agent Memory Adapter SDK
with another agent runtime. It exposes small LangGraph node helpers and keeps
all Gateway HTTP details in `adapter-sdk/python/tdai_adapter_sdk`.

## Usage

Add this repository's `adapter-sdk/python` and `langgraph-adapter` directories
to `PYTHONPATH`, then compose the nodes into a graph:

```python
from langgraph.graph import START, END, StateGraph
from langgraph_tdai_adapter import TdaiLangGraphAdapter

adapter = TdaiLangGraphAdapter()

graph = StateGraph(dict)
graph.add_node("recall", adapter.recall_node)
graph.add_node("agent", my_agent_node)
graph.add_node("capture", adapter.capture_node)
graph.add_edge(START, "recall")
graph.add_edge("recall", "agent")
graph.add_edge("agent", "capture")
graph.add_edge("capture", END)

app = graph.compile()
app.invoke({
    "thread_id": "demo-thread",
    "user_id": "demo-user",
    "messages": [{"role": "user", "content": "What did we decide last time?"}],
})
```

Expected state shape:

| Field | Description |
| --- | --- |
| `thread_id` or `session_id` | Used to build `langgraph:<thread_id>` session keys. |
| `user_id` | Optional user ID forwarded to Gateway. |
| `messages` | List of LangChain messages or dicts with `role` and `content`. |

`recall_node` injects recalled memory as a hidden `SystemMessage` before the
agent node. `capture_node` captures the latest user/assistant turn after the
agent node. `session_end_node` flushes the session through `/session/end`.
