# Agent 接入指南（Python）

本文讲怎么把 `tencentdb-agent-memory-sdk-python` 接到一个 AI Agent 里。SDK 的 14 个 API 速查见 [`README.md`](./README.md)，本文讲**怎么把它们组装成一套长期记忆**。

---

## 接入要做的四件事

```
用户输入  →  ① 召回（注入 prompt） → LLM → ② 捕获（写 L0）
                            ↑
                  ③ 工具：让 LLM 自己再查
                            ↑
                  ④ 错误降级：失败不挂主流程
```

---

## 0. 初始化

```python
from tencentdb_agent_memory import MemoryClient, AsyncMemoryClient

# 同步
client = MemoryClient(
    endpoint="https://your-memory-gateway",
    api_key=os.environ["MEMORY_API_KEY"],
    service_id="your-instance-id",
)

# 异步（推荐 Agent 场景用）
async with AsyncMemoryClient(
    endpoint="https://your-memory-gateway",
    api_key=os.environ["MEMORY_API_KEY"],
    service_id="your-instance-id",
) as client:
    ...
```

`service_id` 决定 memory space 隔离粒度，同 id 数据共享、不同 id 完全隔离。Agent 场景几乎都用 async，别用同步版（会阻塞事件循环）。

---

## 1. 召回（Recall）

在用户消息发给 LLM 前，并行拉三类记忆，拼到 system prompt 里。

```python
import asyncio

async def recall(client: AsyncMemoryClient, user_query: str) -> dict:
    l1, persona, scenes = await asyncio.gather(
        client.search_atomic(query=user_query, limit=5),
        client.read_core(),                            # L3 用户画像
        client.list_scenarios(),                       # L2 场景索引
        return_exceptions=True,                        # 关键：单路挂不影响其它
    )

    l1_items = l1["items"] if not isinstance(l1, Exception) else []
    persona_text = persona["content"] if not isinstance(persona, Exception) else None
    scene_list = scenes["entries"] if not isinstance(scenes, Exception) else []

    return format_prompt(l1_items, persona_text, scene_list)
```

`asyncio.gather(..., return_exceptions=True)` 是关键——任何一路超时/失败，其它两路结果照常用，不影响主对话。

### 拼 prompt 的两个区块

- **prepend_context（动态）**：L1 召回结果，每轮都变，放在用户消息前。
- **append_system_context（稳定）**：Persona + Scene 索引 + 工具调用指南，放在 system prompt 末尾，KV cache 友好。 _（待确定：放到 system prompt 末尾仍可能造成 KV cache miss，需要继续讨论。）_

```python
def format_prompt(l1_items, persona, scenes) -> dict:
    prepend = None
    if l1_items:
        lines = [f"- [{m['type']}] {m['content']}" for m in l1_items]
        prepend = "<relevant-memories>\n" + "\n".join(lines) + "\n</relevant-memories>"

    parts = []
    if persona:
        parts.append(f"<user-persona>\n{persona}\n</user-persona>")
    if scenes:
        parts.append("## Scene Navigation\n*以下场景可用 tdai_read_file 读取详情*")
        parts.extend(f"- `{s['path']}`" for s in scenes)
    parts.append(MEMORY_TOOLS_GUIDE)  # 见下文

    return {"prepend": prepend, "append": "\n\n".join(parts)}
```

> 实现要点：在召回阶段**缓存原始用户文本**（清洁版，未注入 recall），后面 capture 阶段要用——见第 2 节。

---

## 2. 捕获（Capture）

在 agent 一轮跑完后，把这一轮新增的 user/assistant 消息清洗后写回 L0。

```python
async def capture(
    client: AsyncMemoryClient,
    session_key: str,
    raw_messages: list,                  # 框架给的完整消息历史
    original_user_text: str,             # 召回阶段缓存的清洁版用户文本
    original_user_message_count: int,    # 召回阶段缓存的消息数
):
    # ① 位置切片：只保留这一轮新增的消息
    new_messages = raw_messages[original_user_message_count:]

    # ② 提取 user/assistant，去掉 tool calls / system / 多模态噪声
    extracted = extract_user_assistant(new_messages)

    # ③ 把被 recall 污染的用户消息换回原始版
    for m in extracted:
        if m["role"] == "user" and m["timestamp"] == new_messages[0].get("timestamp"):
            m["content"] = original_user_text
            break

    # ④ 文本清洗：去图片 base64、去代码块、过滤太短/纯符号
    cleaned = [
        {**m, "content": sanitize(m["content"])}
        for m in extracted
        if len(sanitize(m["content"]).strip()) > 5
    ]

    if not cleaned:
        return

    # ⑤ 提交
    await client.add_conversation(
        session_id=session_key,
        messages=[
            {
                "role": m["role"],
                "content": m["content"],
                "timestamp": datetime.fromtimestamp(m["timestamp"] / 1000).isoformat(),
            }
            for m in cleaned
        ],
    )
```

### 为什么要替换"被污染的用户消息"

召回阶段会往用户消息前 prepend 一段 `<relevant-memories>...</relevant-memories>`。如果不还原成原始文本就写 L0，下一轮召回就会基于这段被污染的文本去 search/embedding——形成**反馈环**，记忆会越来越乱。

### 为什么要位置切片

agent 一轮结束时框架给的是**完整历史**，不是本轮新增。直接全发会重复写。召回阶段记一下消息数 N，结束时 `messages[N:]` 就是新增的。

---

## 3. 工具暴露

只靠 prompt 注入的记忆有限。再注册三个工具让 LLM 自己查：

| 工具 | 何时用 | 实现 |
|---|---|---|
| `tdai_memory_search` | 找结构化偏好/事实 | `client.search_atomic(query=..., limit=...)` |
| `tdai_conversation_search` | 找原始对话片段 | `client.search_conversation(query=..., limit=...)` |
| `tdai_read_file` | 读 persona / scene block 全文 | `client.read_file(path)` |

在 system prompt 里说清楚什么时候调，加上次数上限：

```
## 记忆工具
- tdai_memory_search：搜结构化记忆（用户偏好、规则、历史事件）
- tdai_conversation_search：搜原始对话原文
- tdai_read_file：读取场景文件（用 Scene Navigation 列出的路径）

⚠️ memory_search + conversation_search 一轮总共最多调 3 次。
```

不限次数 LLM 会反复瞎搜。

---

## 4. 错误降级

记忆服务挂了**不能挂主对话**。三条原则：

1. **召回**用 `asyncio.gather(..., return_exceptions=True)`，单路失败不影响其它。
2. **捕获**包 try/except，失败只记日志：
   ```python
   try:
       await capture(...)
   except Exception as e:
       logger.warning(f"capture failed: {e}")
   ```
3. **工具**返回错误字符串而不是抛异常，让 LLM 自己看到 "memory unavailable" 然后继续聊。

---

## 5. 错误处理

非零 code 抛 `TDAMError`：

```python
from tencentdb_agent_memory import TDAMError

try:
    content = await client.read_file("scene_blocks/x.md")
except TDAMError as e:
    if e.code == 404:
        pass  # 文件不存在，正常情况
    else:
        logger.warning(f"memory error code={e.code} request_id={e.request_id}")
```

`request_id` 在 server 端也有日志，排障时给后端就行。

---

## 6. 性能建议

- **召回总预算 < 200ms**：三路并行后取最快可用结果，超时的丢掉。
- **prompt 注入控制大小**：L1 ≤ 5 条、Scene 列表只列 path 不列内容、Persona 一份就够。让 LLM 不够用时再用工具拉详情。
- **session 粒度**：`session_key` 是 L0 partition key，长期对话用稳定 id（用户 id + 会话 id），不要每轮换。
- **不要在主线程同步调**：用 `AsyncMemoryClient`，别用 `MemoryClient`，否则会阻塞事件循环。

---

## 7. 管理面：Knowledge / 元数据

上面讲的都是 `MemoryClient`（数据面：读写记忆）。如果你还需要**管理** Knowledge 知识源（wiki / code-graph）的元数据，用 `MetadataClient`（v3 管理面，不需要数据面 isolation 字段）：

```python
from tencentdb_agent_memory.v3 import MetadataClient

meta = MetadataClient(
    endpoint="http://127.0.0.1:8420",
    api_key="verify-token",
    service_id="your-instance-id",
)

# 登记 / 列出 / 改名 / 删除 Knowledge 实体（管理面 CRUD，详见 README.md）
meta.create_knowledge({
    "knowledge_id": "wiki-1", "type": "wiki",
    "service_url": "http://ks:8421/v3", "name": "Wiki", "team_id": "team-1",
})
meta.list_knowledge({"team_id": "team-1", "type": "wiki"})
```

注意：`MetadataClient` 只管元数据 CRUD；真正搜 wiki 内容、读页面、同步仓库要调 Knowledge Service 数据面（`service_url` 指向的 `:8421`），那是另一组接口，不在本 SDK 范围内。

---

## 附：sanitize 实现参考

清洗函数处理这几类噪声：

```python
import re
import time

_IMAGE_DATA_URI = re.compile(r"data:image/[a-z+]+;base64,[A-Za-z0-9+/=]+", re.IGNORECASE)
_CODE_BLOCK = re.compile(r"```[\s\S]*?```")

def sanitize(text: str) -> str:
    # 去 base64 图片
    text = _IMAGE_DATA_URI.sub("[image]", text)
    # 去代码块（assistant 输出常见，对 embedding 是噪声）
    text = _CODE_BLOCK.sub("[code]", text)
    return text.strip()


def extract_user_assistant(messages: list) -> list:
    """从原始消息列表里提取 user/assistant 文本，丢掉 tool / system / 空内容。"""
    out = []
    for m in messages:
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        content = m.get("content")
        if isinstance(content, list):
            # 多模态消息：拼接 text 部分
            content = "\n".join(p.get("text", "") for p in content if p.get("type") == "text")
        if not isinstance(content, str) or not content.strip():
            continue
        out.append({
            "role": role,
            "content": content.strip(),
            "timestamp": m.get("timestamp", int(time.time() * 1000)),
        })
    return out
```
