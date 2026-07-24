# tencentdb-agent-memory-sdk-python

Python SDK for the **TencentDB Agent Memory v2 API**.

Provides synchronous (`MemoryClient`) and asynchronous (`AsyncMemoryClient`) clients.

> **Distribution name**: `tencentdb-agent-memory-sdk-python` (PyPI / `pip install`)
> **Import path**: `tencentdb_agent_memory` (Python module)

## Install

```bash
# From PyPI (after publish)
pip install tencentdb-agent-memory-sdk-python

# From local .whl
pip install ./tencentdb_agent_memory_sdk_python-0.1.0-py3-none-any.whl
```

## Quick Start

```python
from tencentdb_agent_memory import MemoryClient

client = MemoryClient(
    endpoint="http://127.0.0.1:8420",
    api_key="your-api-key",
    service_id="your-memory-space-id",
)

# L0: append a conversation
result = client.add_conversation(
    session_id="sess-1",
    messages=[
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi!"},
    ],
)
print(result["accepted_ids"])

# L1: search structured memories
hits = client.search_atomic(query="user preferences", limit=5)
print(hits["items"])

# L1: update a memory note
client.update_atomic(id="note-xxx", content="updated content", background="context")

# L2: list scenario files
scenarios = client.list_scenarios(path_prefix="")
print(scenarios["entries"])

# L2: read a scenario file
file = client.read_scenario("工作.md")
print(file["content"])

# L2: update a scenario file (must already exist)
client.write_scenario("工作.md", "# Updated content", summary="new summary")

# L3: read core memory (persona)
core = client.read_core()
print(core["content"])

# L3: write core memory
client.write_core("# User Profile\n...")

# Offload v2: send tool pairs for server-side L1 async processing (fire-and-forget)
client.offload_ingest(
    session_id="agent_sess_123",
    tool_pairs=[
        {"tool_name": "search", "tool_call_id": "call_1", "params": {"q": "..."}, "result": "...", "timestamp": "..."},
    ],
)

# Offload v2: server-side context compaction (sync wait for result)
compacted = client.offload_compact(
    session_id="agent_sess_123",
    messages=[...],
    ratio=0.7,
    context_window=128000,
)
print(compacted["messages"], compacted["report"])

# Recover an archived tool result referenced by a compacted message
ref = client.offload_read_ref(
    session_id="agent_sess_123",
    result_ref="offload/agent_sess_123/refs/call_1.md",
    query="relevant section",
    max_tokens=800,
)
print(ref["content"], ref["truncated"])

# Read memory pipeline artifacts (e.g. persona.md, scene_blocks/*.md)
raw = client.read_file("scene_blocks/工作.md")
```

## Async Usage

```python
import asyncio
from tencentdb_agent_memory import AsyncMemoryClient

async def main():
    async with AsyncMemoryClient(
        endpoint="http://127.0.0.1:8420",
        api_key="your-api-key",
        service_id="your-memory-space-id",
    ) as client:
        result = await client.search_atomic(query="preferences")
        print(result["items"])

asyncio.run(main())
```

## API Methods

| Layer | Method | Endpoint |
|-------|--------|----------|
| L0 | `add_conversation()` | `POST /v2/conversation/add` |
| L0 | `query_conversation()` | `POST /v2/conversation/query` |
| L0 | `search_conversation()` | `POST /v2/conversation/search` |
| L0 | `delete_conversation()` | `POST /v2/conversation/delete` |
| L1 | `update_atomic()` | `POST /v2/atomic/update` |
| L1 | `query_atomic()` | `POST /v2/atomic/query` |
| L1 | `search_atomic()` | `POST /v2/atomic/search` |
| L1 | `delete_atomic()` | `POST /v2/atomic/delete` |
| L2 | `list_scenarios()` | `POST /v2/scenario/ls` |
| L2 | `read_scenario()` | `POST /v2/scenario/read` |
| L2 | `write_scenario()` | `POST /v2/scenario/write` |
| L2 | `rm_scenario()` | `POST /v2/scenario/rm` |
| L3 | `read_core()` | `POST /v2/core/read` |
| L3 | `write_core()` | `POST /v2/core/write` |
| Offload | `offload_ingest()` | `POST /v2/offload/ingest` |
| Offload | `offload_compact()` | `POST /v2/offload/compact` |
| Offload | `offload_read_ref()` | `POST /v2/offload/read-ref` |
| Offload | `offload_query_mmd()` | `POST /v2/offload/query-mmd` |

## Error Handling

All non-zero `code` responses raise `TDAMError`:

```python
from tencentdb_agent_memory import TDAMError

try:
    client.read_core()
except TDAMError as e:
    print(f"code={e.code} message={e.message} request_id={e.request_id}")
```

## Build & Pack

```bash
# Build wheel
python -m build
# → dist/tencentdb_agent_memory_sdk_python-0.1.0-py3-none-any.whl

# Or just wheel
pip wheel . --no-deps -w dist/
```

## Dependencies

- `httpx>=0.24.0` (HTTP client with async support)

## License

MIT
