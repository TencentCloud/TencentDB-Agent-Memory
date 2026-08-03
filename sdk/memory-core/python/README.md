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
| Offload | `offload_query_mmd()` | `POST /v2/offload/query-mmd` |

## MetadataClient (v3 management plane)

`MetadataClient` / `AsyncMetadataClient` wrap the gateway's v3 management-plane endpoints. Unlike the v3 data-plane `MemoryClient`, they do **not** require data-plane isolation fields; auth is Bearer + `x-tdai-service-id`, with business fields like `team_id` in the request body.

Covers all **54 public `/v3/meta/*` routes** (aligned with Panel Control `META_ACTIONS`, including `user-key/*`), plus **5 `/v3/knowledge/*` Knowledge CRUD** routes.

```python
from tencentdb_agent_memory.v3 import MetadataClient

meta = MetadataClient(
    endpoint="http://127.0.0.1:8420",
    api_key="verify-token",        # gateway Bearer (KERNEL_AUTH_TOKEN)
    service_id="knowledge-debug",  # x-tdai-service-id
    # user_key="...",              # optional; only for system_admin endpoints
)

# Register a wiki knowledge source
k = meta.create_knowledge({
    "knowledge_id": "wiki-docs",
    "type": "wiki",
    "service_url": "http://127.0.0.1:8421/v3",  # Knowledge Service data-plane URL
    "name": "Team Docs Wiki",
    "summary": "Internal tech docs",
    "team_id": "team-1",
    "user_id": "usr-1",
})
print(k["knowledge_id"], k["type"], k["created_at"])

# List all code-graphs under a team
lst = meta.list_knowledge({"team_id": "team-1", "type": "code-graph"})
print(lst["items"], lst["total"])

# Rename / change service_url
meta.update_knowledge({"knowledge_id": "wiki-docs", "name": "Renamed Wiki"})

# Batch delete
meta.delete_knowledge(["wiki-docs", "cg-repo-1"], team_id="team-1")
```

| Method | Endpoint | Notes |
|--------|----------|-------|
| `create_knowledge(p)` | `POST /v3/knowledge/create` | upsert metadata (idempotent; re-post overwrites) |
| `get_knowledge(id, team_id=None)` | `POST /v3/knowledge/get` | get one by id |
| `update_knowledge(p)` | `POST /v3/knowledge/update` | partial update (name/summary/service_url/repo_url/branch) |
| `delete_knowledge(ids, team_id=None)` | `POST /v3/knowledge/delete` | batch delete (≤100) |
| `list_knowledge(p)` | `POST /v3/knowledge/list` | list by team_id, optional type filter / batch id lookup |

> Note: these are **management-plane CRUD** (metadata only). Actually searching wiki content, reading pages, or syncing repos is the Knowledge Service data-plane's job (`service_url` → `:8421`), not this client.

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
