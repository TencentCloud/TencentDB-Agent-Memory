# tencentdb-agent-memory-sdk-python

**TencentDB Agent Memory v2 API** 的 Python SDK。

提供同步客户端（`MemoryClient`）和异步客户端（`AsyncMemoryClient`）。

> **发布包名**：`tencentdb-agent-memory-sdk-python`（PyPI / `pip install`）
> **导入路径**：`tencentdb_agent_memory`（Python 模块）

## 安装

```bash
# 从 PyPI 安装（发布后）
pip install tencentdb-agent-memory-sdk-python

# 从本地 .whl 安装
pip install ./tencentdb_agent_memory_sdk_python-0.1.0-py3-none-any.whl
```

## 快速开始

```python
from tencentdb_agent_memory import MemoryClient

client = MemoryClient(
    endpoint="http://127.0.0.1:8420",
    api_key="your-api-key",
    service_id="your-memory-space-id",
)

# L0: 添加对话
result = client.add_conversation(
    session_id="sess-1",
    messages=[
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi!"},
    ],
)
print(result["accepted_ids"])

# L1: 搜索结构化记忆
hits = client.search_atomic(query="user preferences", limit=5)
print(hits["items"])

# L1: 更新一条记忆
client.update_atomic(id="note-xxx", content="updated content", background="context")

# L2: 列出场景文件
scenarios = client.list_scenarios(path_prefix="")
print(scenarios["entries"])

# L2: 读取场景文件
file = client.read_scenario("工作.md")
print(file["content"])

# L2: 更新场景文件（文件必须已存在）
client.write_scenario("工作.md", "# Updated content", summary="new summary")

# L3: 读取核心记忆（用户画像）
core = client.read_core()
print(core["content"])

# L3: 写入核心记忆
client.write_core("# User Profile\n...")

# Offload v2: 上报工具调用对，触发服务端 L1 异步处理（可 fire-and-forget）
client.offload_ingest(
    session_id="agent_sess_123",
    tool_pairs=[
        {"tool_name": "search", "tool_call_id": "call_1", "params": {"q": "..."}, "result": "...", "timestamp": "..."},
    ],
)

# Offload v2: 服务端上下文压缩（同步等待结果）
compacted = client.offload_compact(
    session_id="agent_sess_123",
    messages=[...],
    ratio=0.7,
    context_window=128000,
)
print(compacted["messages"], compacted["report"])

# 按压缩消息中的 result_ref 恢复归档工具结果
ref = client.offload_read_ref(
    session_id="agent_sess_123",
    result_ref="offload/agent_sess_123/refs/call_1.md",
    query="相关片段",
    max_tokens=800,
)
print(ref["content"], ref["truncated"])

# 读取记忆 pipeline 产物（如 persona.md、scene_blocks/*.md）
raw = client.read_file("scene_blocks/工作.md")
```

## 异步用法

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

## API 方法

| 层级 | 方法 | 接口 |
|------|------|------|
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

## 错误处理

所有非零 `code` 的响应会抛出 `TDAMError`：

```python
from tencentdb_agent_memory import TDAMError

try:
    client.read_core()
except TDAMError as e:
    print(f"code={e.code} message={e.message} request_id={e.request_id}")
```

## 构建与打包

```bash
# 构建 wheel
python -m build
# → dist/tencentdb_agent_memory_sdk_python-0.1.0-py3-none-any.whl

# 或仅构建 wheel
pip wheel . --no-deps -w dist/
```

## 依赖

- `httpx>=0.24.0`（支持异步的 HTTP 客户端）

## 许可证

MIT
