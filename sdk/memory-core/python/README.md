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

### v3 batch delete and clear

`tencentdb_agent_memory.v3.MemoryClient` (strict-isolation data plane) supports
batch deletes and asset-level clearing:

```python
from tencentdb_agent_memory.v3 import MemoryClient

client = MemoryClient(
    endpoint="http://127.0.0.1:8420", api_key="...", service_id="default",
    team_id="t1", agent_id="agt1", user_id="u1",
)

# L0: delete by message ids (max 5000)
client.delete_conversation(message_ids=["m1", "m2"])

# L0: wipe whole sessions (max 100); both selectors may be combined
client.delete_conversation(session_ids=["s1", "s2"])

# L1: delete by note ids (max 5000)
client.delete_atomic(["a1", "a2"])

# Asset-level: wipe all content but keep the asset (max 100 ids)
res = client.clear_chat_memory(["chat_memory-t1-agt1"])
if not res["all_cleared"]:
    # Failed items carry `retryable`; True means the server already retried
    # internally and the call can be retried later.
    retryable = [i for i in res["items"] if not i["cleared"] and i.get("retryable")]
```

> **Note**: delete paths never fall back to the constructor's `session_id`.
> Deleting a few messages by `message_ids` will not silently wipe the whole
> session; to clear sessions you must pass `session_ids` explicitly.

`clear_chat_memory()` wipes L0/L1/L2/L3 + vectors + files, while keeping
`memory_id`, agent bindings, ACL, owner and visibility — the agent keeps
writing to the same `memory_id` with no re-creation. It rejects the **whole
batch** if any id is missing or is not a chat_memory, and repeated calls are
idempotent. Like other delete endpoints the kernel performs no user-level
authorization; for owner-only semantics call the panel backend
`/api/v1/chat-memory/clear`.

Async variants exist on `AsyncMemoryClient` with identical signatures.

## Custom Prompt and generation provenance

```python
from tencentdb_agent_memory.v3 import MemoryGenerationLogClient, MemoryPromptClient

prompts = MemoryPromptClient(endpoint, api_key, service_id, team_id="team-1", agent_id="agent-1")
created = prompts.create(name="decisions", layer="l1", prompt="Focus on decisions.")
prompts.apply(created["memory_prompt_id"], layer="l1", agent_ids=["agent-1"])
effective = prompts.get_effective(layer="l1")

logs = MemoryGenerationLogClient(endpoint, api_key, service_id)
provenance = logs.get_by_memory_id("memory-id", "l1")
```

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `create()` | `POST /v3/memory-prompt/create` | Create a Prompt |
| `get()` / `list()` / `get_effective()` | `GET /v3/memory-prompt/get` | Get one, list Prompts, or resolve the effective Prompt |
| `update()` | `POST /v3/memory-prompt/update` | Update name/content; identical values are a no-op |
| `delete()` | `POST /v3/memory-prompt/delete` | Batch-delete Prompts and clear their bindings |
| `apply()` / `clear()` | `POST /v3/memory-prompt/set` | Apply, replace, or clear a target binding |
| `list_settings()` | `GET /v3/memory-prompt/setting/list` | List current bindings by Prompt, target, or layer |
| `list_setting_logs()` | `GET /v3/memory-prompt/log` | Query immutable binding-change logs |
| `MemoryGenerationLogClient.list()` | `GET /v3/memory-generation-log/list` | List generation logs by layer/time |
| `get()` / `get_by_memory_id()` | `GET /v3/memory-generation-log/get` | Read by log ID or Memory ID + layer |

```python
settings = prompts.list_settings(
    memory_prompt_id=created["memory_prompt_id"],
    target_type="agent",
    team_id="team-1",
    layer="l1",
    limit=20,
)
```

Async variants are exported as `AsyncMemoryPromptClient` and `AsyncMemoryGenerationLogClient`.

## MetadataClient (v3 management plane)

`MetadataClient` / `AsyncMetadataClient` wrap the gateway's v3 management-plane endpoints. Unlike `MemoryClient` they do **not** require the isolation quad (team/agent/user/session); auth is Bearer + `x-tdai-service-id`, with business fields like `team_id` in the request body.

Covers all **54 public `/v3/meta/*` routes** (aligned with Panel Control `META_ACTIONS`, including `user-key/*`), plus **5 `/v3/knowledge/*` Knowledge CRUD** routes.

```python
import os

from tencentdb_agent_memory.v3 import MetadataClient

auth = os.environ["KERNEL_AUTH_TOKEN"]
meta = MetadataClient(
    "http://127.0.0.1:8420",
    auth,
    "knowledge-debug",  # x-tdai-service-id
    # user_key=os.getenv("TDAI_USER_KEY"),
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
