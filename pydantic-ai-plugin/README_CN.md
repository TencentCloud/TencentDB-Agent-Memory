# TencentDB Agent Memory 的 PydanticAI 适配器

[English](./README.md)

这是一个独立的 Python 适配器，用于将
[PydanticAI](https://pydantic.dev/docs/ai/) `Agent` 接入现有 TencentDB
Agent Memory Gateway。

适配器会在每次非流式 Agent 运行前自动召回上下文，在模型成功返回后写入本轮对话，同时提供显式记忆搜索工具和会话结束接口。异步与同步应用均可使用。

## 架构

```mermaid
flowchart LR
    App["PydanticAI 应用"] --> Wrapper["TencentDBMemoryAgent"]
    Wrapper -->|"recall / capture / search / session end"| Client["GatewayClient"]
    Client -->|"HTTP JSON + 可选 Bearer"| Gateway["现有 TdaiGateway"]
    Gateway --> Core["TdaiCore"]
    Core --> Memory["L0 → L1 → L2 → L3 记忆"]
```

Python 包不会重写 `TdaiCore`，也不会修改现有 OpenClaw 或 Hermes 接入。

| 平台 | 接入边界 | 召回 | 写入 | 会话结束 |
| --- | --- | --- | --- | --- |
| OpenClaw | TypeScript 进程内适配 | 宿主生命周期钩子 | 已提交轮次钩子 | 宿主会话钩子 |
| Hermes | Python Provider 通过 Gateway HTTP | Provider prefetch | turn sync | Provider 关闭/会话方法 |
| PydanticAI | Python Agent 包装器通过 Gateway HTTP | `Agent.run` 之前 | 成功结果之后 | 显式包装器方法 |

## 环境要求

- Python 3.11 或更高版本
- `pydantic-ai-slim[openai]` 2.x
- 已运行的 TencentDB Agent Memory Gateway
- 若从本仓库运行 Gateway，需要 Node.js 22.16 或更高版本

## 安装

在仓库根目录执行：

```bash
python -m venv .venv
python -m pip install -e "pydantic-ai-plugin"
```

Windows PowerShell：

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e "pydantic-ai-plugin"
```

## 启动 Gateway

适配器只负责连接 Gateway，不会自动启动或监管 Node.js 进程。在仓库根目录执行：

```bash
npm install
node --import tsx/esm src/gateway/server.ts
```

另开终端验证：

```bash
curl http://127.0.0.1:8420/health
```

默认地址为 `http://127.0.0.1:8420`。存储、Embedding、抽取模型、Docker
及生产部署配置请参阅仓库根 README。

## 异步快速开始

```python
from pydantic_ai import Agent

from memory_tencentdb_pydantic_ai import (
    GatewayClient,
    TencentDBMemoryAgent,
)

agent = Agent(
    "deepseek:deepseek-chat",
    instructions="请简洁回答。",
)
memory_agent = TencentDBMemoryAgent(
    agent,
    GatewayClient(
        "http://127.0.0.1:8420",
        api_key=None,
    ),
)

result = await memory_agent.run(
    "请记住我喜欢喝无糖咖啡。",
    user_id="user-001",
    session_id="coffee-demo",
)
print(result.output)

flushed = await memory_agent.end_session(
    user_id="user-001",
    session_id="coffee-demo",
)
```

`run()` 直接返回原始 PydanticAI `AgentRunResult`，因此仍可使用
`result.output`、`result.all_messages()` 和 `result.new_messages()`。

## 同步快速开始

```python
result = memory_agent.run_sync(
    "我刚才提到的咖啡偏好是什么？",
    user_id="user-001",
    session_id="coffee-demo",
)

memory_agent.end_session_sync(
    user_id="user-001",
    session_id="coffee-demo",
)
```

已有 asyncio 事件循环的应用应使用 `await memory_agent.run(...)`，不要在同一线程中调用 PydanticAI 同步接口。

## 生命周期

每次 `run()` 或 `run_sync()` 会：

1. 校验 `user_id` 与 `session_id`；
2. 调用 `POST /recall`；
3. 将非空召回结果追加为本轮 PydanticAI instructions；
4. 追加本轮记忆搜索工具集；
5. 调用原始 PydanticAI Agent；
6. 模型成功返回后，只调用一次 `POST /capture`；
7. 返回原始结果。

若模型抛出异常，异常会原样传播，并且不会执行 capture。召回内容不会写入持久化消息历史。调用方传入的 instructions、message history、依赖、模型设置、用量限制与工具集都会继续传给原 Agent。

首版支持文本输入和非流式 `run` / `run_sync`。字符串和结构化输出均会安全序列化后写入。

## 搜索工具

每轮会新增两个工具：

```text
memory_search(query, limit=5, memory_type=None, scene=None)
conversation_search(query, limit=5)
```

- `memory_search`：搜索结构化长期记忆；
- `conversation_search`：在当前 session key 内搜索原始对话证据。

自动 recall 仍会在 Agent 前执行。显式工具用于初次召回不足时进行更精确的二次检索。

如果应用已有工具占用上述名称，PydanticAI 会明确拒绝重复配置，不会静默覆盖。

## 对话历史

PydanticAI message history 与 TencentDB 记忆作用不同。消息历史可以照常传递：

```python
first = await memory_agent.run(
    "请记住我的偏好。",
    user_id="user-001",
    session_id="demo",
)
second = await memory_agent.run(
    "我的偏好是什么？",
    user_id="user-001",
    session_id="demo",
    message_history=first.all_messages(),
)
```

稳定身份用于 Gateway 召回与写入，`message_history` 管理当前 PydanticAI 对话上下文。

## 身份与 session key

两个 ID 都不能为空。默认 Gateway session key 为：

```text
pydantic-ai:{百分号编码的 user-id}:{百分号编码的 session-id}
```

例如 `user:一` 与 `session/1` 会得到：

```text
pydantic-ai:user%3A%E4%B8%80:session%2F1
```

如需加入已有记忆命名空间，可在 `run`、`run_sync`、`end_session` 和
`end_session_sync` 中显式传入 `session_key`。

`user_id` 用于记忆来源标识，`session_key` 用于检索边界；二者都不是身份认证或租户授权机制。应用必须先完成调用方授权，再调用适配器。

## 故障模式

默认 `strict=False`：

| 操作 | Gateway 异常时的默认行为 |
| --- | --- |
| Recall | 记录不含用户正文的警告，无召回上下文继续运行 |
| 搜索工具 | 返回结构化 `memory service unavailable` |
| Capture | 记录警告，保留已经成功的模型结果 |
| 会话结束 | 记录警告并返回 `False` |

开发调试或业务强依赖记忆时可启用快速失败：

```python
memory_agent = TencentDBMemoryAgent(
    agent,
    GatewayClient(),
    strict=True,
)
```

严格模式下会传播 `GatewayConnectionError`、`GatewayHTTPError` 和
`GatewayResponseError`。

### 超时与重试

```python
client = GatewayClient(
    "http://127.0.0.1:8420",
    timeout=10,
    retries=1,
    retry_delay=0.1,
)
```

- health、recall、search 与 session end 可对临时连接故障和 HTTP 5xx 有限重试；
- 鉴权错误及其他 HTTP 4xx 不重试；
- capture **绝不自动重试**，因为当前 Gateway 没有幂等键，重试可能生成重复记忆；
- 所有请求都有有限超时。

## Gateway 鉴权与部署

本地开发可使用默认仅监听回环地址且不带 Token 的 Gateway。启用 Bearer 鉴权：

```bash
export TDAI_GATEWAY_API_KEY="set-a-local-secret"
node --import tsx/esm src/gateway/server.ts
```

客户端配置相同值：

```python
client = GatewayClient(
    "http://127.0.0.1:8420",
    api_key=os.environ["TDAI_GATEWAY_API_KEY"],
)
```

Token 只会通过 `Authorization: Bearer ...` 发送，不会出现在客户端
`repr`、警告或适配器异常中。

非回环部署应：

- 强制启用 Gateway 鉴权；
- 在 Gateway 或可信反向代理处启用 HTTPS；
- 限制网络访问；
- 独立执行应用层授权，不能把 memory ID 当作权限；
- 不提交 `.env`、API Key 或捕获的私人对话。

客户端会拒绝包含用户名/密码、query 或 fragment 的 base URL。

## 示例

无需凭据的完整生命周期：

```bash
python pydantic-ai-plugin/examples/offline_memory_demo.py
```

输出包含：

```text
recall -> agent -> capture -> session_end
```

真实 DeepSeek 两轮 Demo：

```bash
export DEEPSEEK_API_KEY="仅在本机设置"
export TDAI_GATEWAY_URL="http://127.0.0.1:8420"
python pydantic-ai-plugin/examples/deepseek_memory_demo.py
```

可选变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PYDANTIC_AI_MODEL` | `deepseek:deepseek-chat` | PydanticAI 模型别名 |
| `TDAI_GATEWAY_URL` | `http://127.0.0.1:8420` | Gateway 地址 |
| `TDAI_GATEWAY_API_KEY` | 未设置 | 可选 Gateway Bearer Token |

DeepSeek Key 由 PydanticAI 从环境读取，不会发送给 TencentDB Agent Memory Gateway。

## 测试

在仓库根目录执行：

```bash
python -m unittest discover -s pydantic-ai-plugin/tests -v
python -m build pydantic-ai-plugin
```

测试使用本地 HTTP Server 与 PydanticAI `TestModel` / `FunctionModel`，无需模型
API Key，并阻止意外真实模型请求。

## 常见问题

### `Connection refused`

启动 Gateway 并检查 `GET /health`，确认 `TDAI_GATEWAY_URL` 与端口。

### HTTP 401

Gateway 与客户端 Token 必须一致。注意：即使需要鉴权的 POST 路由返回 401，
`GET /health` 仍可能成功。

### Agent 可以回答，但没有召回记忆

fail-open 会有意允许这种情况。检查警告日志、Gateway 存储与抽取模型配置；排查时可启用 `strict=True`。capture HTTP 成功只证明对话已送达，并不单独证明高层记忆抽取已经完成。

### DeepSeek Key 报错

在当前进程设置 `DEEPSEEK_API_KEY`，不要把 Key 写入示例源码。

### Windows 非 ASCII 路径下 editable install 失败

部分 Python 3.11/Hatchling 组合会用 UTF-8 写入 editable `.pth`，而解释器按旧
Windows 代码页读取。可将开发目录放在纯 ASCII 路径，或构建并安装 wheel：

```powershell
py -3.11 -m build pydantic-ai-plugin
py -3.11 -m pip install pydantic-ai-plugin\dist\*.whl
```

## 验收范围

本贡献实现一个新平台，目标对应 Issue #235 的中阶验收。上方表格比较了三种平台生命周期，但不声称实现了两个新适配器或统一适配 SDK。
