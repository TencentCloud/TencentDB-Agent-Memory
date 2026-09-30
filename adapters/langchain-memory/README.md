# LangChain / LangGraph × TencentDB Agent Memory

Give a [LangChain](https://www.langchain.com/) or [LangGraph](https://www.langchain.com/langgraph)
agent persistent, team-scoped memory backed by
[TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) —
in one line of glue and zero changes to your model or graph.

## Features

- **`TencentDBStore`** — a LangGraph [`BaseStore`](https://langchain-ai.github.io/langgraph/reference/store/)
  that persists long-term memory across threads and recalls it semantically.
- **`TencentDBRetriever`** — a LangChain [`BaseRetriever`](https://python.langchain.com/docs/concepts/retrievers/)
  that drops into any RAG chain.
- **Ready-made tools** — `memory_search` and `memory_recall` you can hand to any agent.
- **Capture helpers** — record a conversation into the memory pipeline with one call,
  or attach a side-effecting LangGraph node.
- **Sync + async** — every surface has a sync and an `async` twin, so it works in
  classic LangChain chains and LangGraph graphs alike.
- **Thin by design** — no local vector store, no local embedding, no extraction
  logic. Capture, distillation, embedding and retrieval stay inside MemoryCore.

## Why this adapter

- **Faithful to the memory model.** TencentDB Agent Memory follows
  *capture → distill → recall*: you record observations, the pipeline extracts
  structured facts, and you recall them later. This adapter maps LangChain/LangGraph
  concepts onto that model instead of pretending it is a plain key-value store.
- **No placeholder data.** Capturing a message that can't be normalized raises
  immediately rather than writing a synthetic record.
- **Bounded failure.** Every call goes through the official Python SDK, which
  validates the `{code, message, data}` envelope and raises `TDAMError` on any
  non-zero business code — your agent sees real errors, not silent partial success.
- **Zero local index.** Search is server-side (BM25 + vector + RRF in MemoryCore),
  so there is nothing to rebuild or keep in sync.

## How it works

```text
LangChain / LangGraph agent
   │
   ├─ capture_conversation() ──► POST /v3/conversation/add   (L0 observation)
   │                                   │  async pipeline
   │                                   ▼
   │                            L1 facts (distilled memories)
   │                                   ▲
   └─ memory_search / retriever ──► POST /v3/atomic/search    (semantic recall)
        store.search()
```

Two hooks close the loop: **capture** records what happened, **recall** makes it
available later. Recall is agent-driven — the agent (or your chain) asks for
memories exactly when it needs them, instead of injecting context into every turn.

## Prerequisites

- Python ≥ 3.9.
- A running TencentDB Agent Memory Gateway:

  ```bash
  cd deploy/global-images
  cp .env.example .env && $EDITOR .env
  ./start-all.sh
  ```

## Install

```bash
# The TencentDB Agent Memory Python SDK is not yet published to PyPI, so install
# it from this repository first, then the adapter:
pip install -e ./sdk/memory-core/python
pip install -e ./adapters/langchain-memory

# (Once both are on PyPI:)
# pip install tencentdb-agent-memory-langchain
```

## Quick start

```python
from tencentdb_langchain import TencentDBMemory, create_memory_search_tool

memory = TencentDBMemory(
    endpoint="http://127.0.0.1:8420",
    api_key="local",
    service_id="default",
    team_id="t1", agent_id="a1", user_id="u1",
)

# 1. Capture a conversation turn (record an observation).
memory.capture(
    [{"role": "user", "content": "I prefer dark theme in the editor"}],
    session_id="sess-1",
)

# 2. Recall distilled facts later.
facts = memory.search_facts("editor theme")
for f in facts:
    print(f.content)          # "The user prefers dark theme"
```

### As a LangGraph store

```python
from langgraph.store.memory import InMemoryStore  # for comparison

from tencentdb_langchain import TencentDBStore

store = TencentDBStore.from_config({
    "endpoint": "http://127.0.0.1:8420",
    "api_key": "local",
    "service_id": "default",
    "team_id": "t1", "agent_id": "a1", "user_id": "u1",
})

store.put(("prefs",), "theme", {"content": "prefers dark theme"})
hits = store.search(("prefs",), query="what theme does the user like", limit=5)
print(hits[0].value["content"])
```

### As a LangChain retriever

```python
from tencentdb_langchain import TencentDBMemory, TencentDBRetriever

memory = TencentDBMemory(...)
retriever = TencentDBRetriever(memory=memory, top_k=5)
docs = retriever.invoke("past decisions about authentication")
```

### With an agent

```python
from langchain_core.messages import SystemMessage, HumanMessage
from langgraph.prebuilt import create_react_agent

from tencentdb_langchain import (
    AsyncTencentDBMemory,
    create_async_memory_search_tool,
)

memory = AsyncTencentDBMemory(...)
tools = [create_async_memory_search_tool(memory)]

agent = create_react_agent(model, tools)
await agent.ainvoke(
    {"messages": [SystemMessage("You have a persistent memory."),
                  HumanMessage("What do you remember about me?")]}
)
```

## Configuration

All clients accept the same parameters, read from environment variables, or from
a config dict via `from_env()` / `from_config()`:

| Variable / key | Default | Description |
|---|---|---|
| `endpoint` (`TDAI_MEMORY_ENDPOINT`) | — | Memory Gateway base URL, e.g. `http://127.0.0.1:8420` |
| `api_key` (`TDAI_MEMORY_API_KEY`) | — | Gateway API key (or `local`) |
| `service_id` (`TDAI_MEMORY_SERVICE_ID`) | — | Memory instance id (`x-tdai-service-id`) |
| `team_id` / `agent_id` / `user_id` | — | v3 isolation context (required) |
| `session_id` (`TDAI_MEMORY_SESSION_ID`) | — | Session scope for L0/L1 (required for capture) |
| `user_key` (`TDAI_MEMORY_USER_KEY`) | — | Optional user identity for upstream auth |
| `timeout` | 30 | Per-request timeout in seconds |

## Semantics of the store

`TencentDBStore` is *not* an exact key-value store — see the module docstring in
[`store.py`](src/tencentdb_langchain/store.py) for the full mapping table. The one
thing to remember: `put` records an **observation** that the pipeline distills
into searchable facts asynchronously, so a value written with `put` may not be
visible to `search` until the pipeline has run.

## Testing

```bash
pip install -e ./adapters/langchain-memory[dev]
pytest
```

The tests inject a fake transport into the SDK, so they run without a live
gateway or an LLM.

## License

MIT — same as the TencentDB Agent Memory project.
