# tencentdb-agent-memory-sdk-python

**TencentDB Agent Memory** 的 Python SDK，同时支持 v2 和 v3 API。

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

### v3（推荐）

> v3 与 v2 的主要差异：L0/L1 强制要求 `session_id`（strict session isolation），请求路径从 `/v2/*` 升级为 `/v3/*`，响应包络结构一致。

| 层级 | 方法 | 接口 |
|------|------|------|
| L0 | `add_conversation()` | `POST /v3/conversation/add` |
| L0 | `query_conversation()` | `POST /v3/conversation/query` |
| L0 | `search_conversation()` | `POST /v3/conversation/search` |
| L0 | `delete_conversation()` | `POST /v3/conversation/delete` |
| L1 | `update_atomic()` | `POST /v3/atomic/update` |
| L1 | `query_atomic()` | `POST /v3/atomic/query` |
| L1 | `search_atomic()` | `POST /v3/atomic/search` |
| L1 | `delete_atomic()` | `POST /v3/atomic/delete` |
| L2 | `list_scenarios()` | `POST /v3/scenario/ls` |
| L2 | `read_scenario()` | `POST /v3/scenario/read` |
| L2 | `write_scenario()` | `POST /v3/scenario/write` |
| L2 | `rm_scenario()` | `POST /v3/scenario/rm` |
| L3 | `read_core()` | `POST /v3/core/read` |
| L3 | `write_core()` | `POST /v3/core/write` |
| Offload | `offload_ingest()` | `POST /v3/offload/ingest` |
| Offload | `offload_compact()` | `POST /v3/offload/compact` |
| Offload | `offload_query_mmd()` | `POST /v3/offload/query-mmd` |
| 资产 | `clear_chat_memory()` | `POST /v3/chat-memory/clear` |

#### 批量删除与清空

`delete_conversation()`（L0）与 `delete_atomic()`（L1）支持批量：

```python
# L0：按消息 id 批量删除（≤5000）
client.delete_conversation(message_ids=["m1", "m2"])

# L0：按会话批量清空（≤100），两者可同时给
client.delete_conversation(session_ids=["s1", "s2"])

# L1：按笔记 id 批量删除（≤5000）
client.delete_atomic(["a1", "a2"])
```

> **注意**：删除路径**不会**回退到构造时的 `session_id`。
> 只想按 `message_ids` 删几条消息时，不会意外把整个会话删掉；
> 要清空会话必须显式传 `session_ids`。

`clear_chat_memory()` 是**资产级**操作，一键清空 memory 全部内容但保留资产：

```python
res = client.clear_chat_memory(["chat_memory-t1-agt1"])
if not res["all_cleared"]:
    # 失败项带 retryable 标志；True 表示服务端已自动重试仍失败，稍后可再试
    retryable = [i for i in res["items"] if not i["cleared"] and i.get("retryable")]
```

- 清空 L0/L1/L2/L3 + 向量 + 文件；保留 `memory_id`、Agent 绑定、ACL、Owner、可见性
- 清空后 Agent 继续用原 `memory_id` 写入，无需重建
- 任一 `memory_id` 不存在或不是 chat_memory 时**整批拒绝**；重复调用幂等
- 权限：与其它删除接口一致，内核不做用户级鉴权。需要「仅 Owner 可清空」请走面板后端 `/api/v1/chat-memory/clear`

### v2（兼容）

> v2 的 L0/L1 不强制 `session_id`，隔离仅基于 `(team_id, user_id, agent_id)` 三元组。

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
| Offload | `offload_query_mmd()` | `POST /v2/offload/query-mmd` |

### v3 vs v2 差异说明

| 维度 | v2 | v3 |
|------|----|----|
| 路径前缀 | `/v2/*` | `/v3/*` |
| L0/L1 隔离 | `(team_id, user_id, agent_id)` 三元组 | 三元组 + `session_id`（strict session isolation） |
| `session_id` | 可选 | L0/L1 必填，缺失返回 422 |
| L2/L3 | 仅三元组隔离 | 仅三元组隔离（无变化） |
| 响应包络 | `{ code, message, data, request_id }` | 同 v2，结构不变 |

### 自定义 Prompt 与生成溯源

```python
from tencentdb_agent_memory.v3 import MemoryGenerationLogClient, MemoryPromptClient

prompts = MemoryPromptClient(endpoint, api_key, service_id, team_id="team-1", agent_id="agent-1")
created = prompts.create(name="决策抽取", layer="l1", prompt="重点提取明确决策。")
prompts.apply(created["memory_prompt_id"], layer="l1", agent_ids=["agent-1"])
effective = prompts.get_effective(layer="l1")
settings = prompts.list_settings(memory_prompt_id=created["memory_prompt_id"], layer="l1")

logs = MemoryGenerationLogClient(endpoint, api_key, service_id)
provenance = logs.get_by_memory_id("memory-id", "l1")
```

| SDK 方法 | 接口 | 说明 |
|----------|------|------|
| `create()` | `POST /v3/memory-prompt/create` | 创建 Prompt |
| `get()` / `list()` / `get_effective()` | `GET /v3/memory-prompt/get` | 查详情、列表或最终生效 Prompt |
| `update()` | `POST /v3/memory-prompt/update` | 更新名称/内容；相同值为幂等 no-op |
| `delete()` | `POST /v3/memory-prompt/delete` | 批量删除 Prompt 并清理其绑定 |
| `apply()` / `clear()` | `POST /v3/memory-prompt/set` | 应用、替换或清除目标绑定 |
| `list_settings()` | `GET /v3/memory-prompt/setting/list` | 按 Prompt、目标或 Layer 查询当前绑定 |
| `list_setting_logs()` | `GET /v3/memory-prompt/log` | 查询不可变的绑定变更日志 |
| `MemoryGenerationLogClient.list()` | `GET /v3/memory-generation-log/list` | 按 Layer/时间分页查询生成日志 |
| `get()` / `get_by_memory_id()` | `GET /v3/memory-generation-log/get` | 按日志 ID 或 Memory ID + Layer 查询溯源 |

`list_settings()` 不传筛选条件时列出当前 Instance 的全部绑定；传 `memory_prompt_id` 可反向查询该 Prompt 绑定到哪些目标。传 `agent_id` 时必须同时传 `team_id`。异步版本对应 `AsyncMemoryPromptClient` 和 `AsyncMemoryGenerationLogClient`。

### MetadataClient（v3 管理面）

`MetadataClient` / `AsyncMetadataClient` 封装网关 v3 管理面接口。与 `MemoryClient` 不同，**不需要** isolation 四元组（team/agent/user/session）；鉴权用 Bearer + `x-tdai-service-id`，`team_id` 等业务字段放在请求 body 里。

当前先落地 **Knowledge 实体管理** 5 个端点（`/v3/knowledge/*`，类型 `wiki` | `code-graph`）。其余 v3/meta 实体（user/team/agent/task/asset/acl/config）后续再补。

```python
import os

from tencentdb_agent_memory.v3 import MetadataClient

meta = MetadataClient(
    endpoint="http://127.0.0.1:8420",
    api_key=os.environ["KERNEL_AUTH_TOKEN"],  # 网关 Bearer，勿硬编码
    service_id="knowledge-debug",  # x-tdai-service-id
    # user_key="...",              # 可选；system_admin 接口才需要
)

# 登记一个 wiki 知识源
k = meta.create_knowledge({
    "knowledge_id": "wiki-docs",
    "type": "wiki",
    "service_url": "http://127.0.0.1:8421/v3",  # Knowledge Service 数据面地址
    "name": "团队文档 Wiki",
    "summary": "内部技术文档",
    "team_id": "team-1",
    "user_id": "usr-1",
})
print(k["knowledge_id"], k["type"], k["created_at"])

# 列出某团队下的全部 code-graph
lst = meta.list_knowledge({"team_id": "team-1", "type": "code-graph"})
print(lst["items"], lst["total"])

# 改名 / 换 service_url
meta.update_knowledge({"knowledge_id": "wiki-docs", "name": "改名后的 Wiki"})

# 批量删除
meta.delete_knowledge(["wiki-docs", "cg-repo-1"], team_id="team-1")
```

| 方法 | 接口 | 说明 |
|------|------|------|
| `create_knowledge(p)` | `POST /v3/knowledge/create` | upsert 元数据（幂等，重复 post 即覆盖） |
| `get_knowledge(id, team_id=None)` | `POST /v3/knowledge/get` | 单条查询 |
| `update_knowledge(p)` | `POST /v3/knowledge/update` | 部分更新（name/summary/service_url/repo_url/branch） |
| `delete_knowledge(ids, team_id=None)` | `POST /v3/knowledge/delete` | 批量删除（≤100） |
| `list_knowledge(p)` | `POST /v3/knowledge/list` | 按 team_id 列出，可选 type 过滤 / 按 id 批查明细 |

> 注意：这组接口是**管理面 CRUD**，只管元数据；真正去 wiki/code-graph 里搜内容、读页面、同步仓库是 Knowledge Service 数据面（`service_url` 指向的 `:8421`）的活，不在这个客户端里。

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
