# LangChain / LangGraph × TencentDB Agent Memory

用一行胶水代码，让 [LangChain](https://www.langchain.com/) 或 [LangGraph](https://www.langchain.com/langgraph)
的 Agent 拥有由 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
支撑的持久、团队级记忆——无需改动你的模型或图结构。

## 功能

- **`TencentDBStore`** — 实现 LangGraph [`BaseStore`](https://langchain-ai.github.io/langgraph/reference/store/)，
  跨线程持久化长期记忆并做语义召回。
- **`TencentDBRetriever`** — 实现 LangChain [`BaseRetriever`](https://python.langchain.com/docs/concepts/retrievers/)，
  可直接嵌入任意 RAG 链。
- **开箱即用工具** — `memory_search` 与 `memory_recall`，可直接交给任意 Agent 调用。
- **沉淀助手** — 一次调用即可把对话写入记忆管线，或挂一个副作用 LangGraph 节点。
- **同步 + 异步** — 每个能力都有 sync / async 双实现，经典 LangChain 链与 LangGraph 图都能用。
- **天然轻薄** — 无本地向量库、无本地 embedding、无抽取逻辑。沉淀、蒸馏、向量化、检索全部留在 MemoryCore。

## 为什么这样设计

- **忠于记忆模型**。TencentDB Agent Memory 遵循 *沉淀 → 蒸馏 → 召回*：你记录观测，
  管线抽取结构化事实，之后你再召回。本适配器把 LangChain/LangGraph 的概念映射到这套模型上，
  而不是假装它是一个普通键值存储。
- **绝不写入占位数据**。无法归一化的消息会立刻报错，而不是塞进一条假记录。
- **失败有界**。所有调用都走官方 Python SDK，它校验 `{code, message, data}` 信封，
  业务码非 0 时抛出 `TDAMError`——Agent 看到的是真实错误，而不是静默的部分成功。
- **零本地索引**。检索在服务端完成（MemoryCore 内的 BM25 + 向量 + RRF），无需重建或同步任何东西。

## 工作原理

```text
LangChain / LangGraph Agent
   │
   ├─ capture_conversation() ──► POST /v3/conversation/add   (L0 观测)
   │                                   │  异步管线
   │                                   ▼
   │                            L1 事实（蒸馏后的记忆）
   │                                   ▲
   └─ memory_search / retriever ──► POST /v3/atomic/search    (语义召回)
        store.search()
```

两个钩子闭合完整闭环：**沉淀**记录发生了什么，**召回**让之后可用。召回是 Agent 驱动的——
Agent（或你的链）在真正需要时主动检索记忆，而不是每轮都注入上下文。

## 前置条件

- Python ≥ 3.9。
- 已启动 TencentDB Agent Memory 网关：

  ```bash
  cd deploy/global-images
  cp .env.example .env && $EDITOR .env
  ./start-all.sh
  ```

## 安装

```bash
# TencentDB Agent Memory 的 Python SDK 尚未发布到 PyPI，请先从本仓库安装 SDK，
# 再安装适配器：
pip install -e ./sdk/memory-core/python
pip install -e ./adapters/langchain-memory

# （两者都发布到 PyPI 后：）
# pip install tencentdb-agent-memory-langchain
```

## 快速开始

```python
from tencentdb_langchain import TencentDBMemory, create_memory_search_tool

memory = TencentDBMemory(
    endpoint="http://127.0.0.1:8420",
    api_key="local",
    service_id="default",
    team_id="t1", agent_id="a1", user_id="u1",
)

# 1. 沉淀一段对话（记录观测）。
memory.capture(
    [{"role": "user", "content": "我更喜欢编辑器用深色主题"}],
    session_id="sess-1",
)

# 2. 稍后召回蒸馏出的事实。
facts = memory.search_facts("编辑器主题")
for f in facts:
    print(f.content)          # "用户更喜欢深色主题"
```

### 作为 LangGraph store 使用

```python
from tencentdb_langchain import TencentDBStore

store = TencentDBStore.from_config({
    "endpoint": "http://127.0.0.1:8420",
    "api_key": "local",
    "service_id": "default",
    "team_id": "t1", "agent_id": "a1", "user_id": "u1",
})

store.put(("prefs",), "theme", {"content": "喜欢深色主题"})
hits = store.search(("prefs",), query="用户喜欢什么主题", limit=5)
print(hits[0].value["content"])
```

### 作为 LangChain retriever 使用

```python
from tencentdb_langchain import TencentDBMemory, TencentDBRetriever

memory = TencentDBMemory(...)
retriever = TencentDBRetriever(memory=memory, top_k=5)
docs = retriever.invoke("关于认证的历史决策")
```

### 与 Agent 结合

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
    {"messages": [SystemMessage("你拥有持久记忆。"),
                  HumanMessage("你还记得我什么？")]}
)
```

## 配置

所有客户端接受相同参数，可从环境变量读取，或通过 `from_env()` / `from_config()`
从配置字典读取：

| 变量 / 键 | 默认值 | 说明 |
|---|---|---|
| `endpoint` (`TDAI_MEMORY_ENDPOINT`) | — | 记忆网关地址，如 `http://127.0.0.1:8420` |
| `api_key` (`TDAI_MEMORY_API_KEY`) | — | 网关 API Key（或 `local`） |
| `service_id` (`TDAI_MEMORY_SERVICE_ID`) | — | 记忆实例 id（`x-tdai-service-id`） |
| `team_id` / `agent_id` / `user_id` | — | v3 隔离上下文（必填） |
| `session_id` (`TDAI_MEMORY_SESSION_ID`) | — | L0/L1 的会话作用域（沉淀时必填） |
| `user_key` (`TDAI_MEMORY_USER_KEY`) | — | 可选的上游用户身份 |
| `timeout` | 30 | 单次请求超时（秒） |

## Store 的语义

`TencentDBStore` **不是**精确的键值存储——完整映射表见
[`store.py`](src/tencentdb_langchain/store.py) 模块文档。要记住的一点：`put`
记录的是**观测**，管线会异步把它蒸馏成可检索的事实，因此 `put` 写入的内容
可能要等管线跑完才会出现在 `search` 结果里。

## 测试

```bash
pip install -e ./adapters/langchain-memory[dev]
pytest
```

测试把假传输注入 SDK，因此无需真实网关或 LLM 即可运行。

## License

MIT —— 与 TencentDB Agent Memory 项目一致。
