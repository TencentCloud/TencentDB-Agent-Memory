# TencentDB Agent Memory — trpc-agent-python 适配器

为基于 [trpc-agent-python](https://github.com/trpc-group/trpc-agent-python) 构建的智能体装上持久记忆。本适配器提供 `TencentDBMemoryService` —— 框架 `MemoryServiceABC` 契约的直接实现（与内置的 InMemory / Redis / SQL / Mem0 记忆服务同级），接入 `Runner(memory_service=...)` 无需任何框架改动。

接入后，每个会话自动获得：

- **对话捕获** —— 每轮完成后，runner 调用 `store_session`，将该轮 user/assistant 对话流式发送到 gateway（`POST /capture`），进入 L0 → L3 记忆流水线
- **记忆检索** —— 框架的召回路径（`invocation_context → search_memory`）查询 gateway（`POST /search/memories`）并映射为 `SearchMemoryResponse`
- **增量捕获** —— 每会话水位线保证重复的 `store_session` 调用只发增量，绝不重放整个会话
- **默认 fail-open** —— gateway 故障仅记日志并跳过，绝不阻断智能体主循环

## 工作原理

```
trpc-agent-python Runner
  ├─ 轮后: store_session ──(POST /capture)──► L0 → L3 流水线
  └─ 召回: search_memory ──(POST /search/memories)──► SearchMemoryResponse
                                            ▼
                     Memory Core Gateway（端口 8420）
                    （捕获 · 提取 · 存储 · 召回）
```

适配器对接 **memory-core gateway**（默认 `:8420`），记忆引擎（提取/去重/场景沉淀/画像）运行在 gateway 侧 —— 与官方 trpc-agent-go 集成（`memory/tencentdb`）对接的是同一组 gateway 路由。

身份映射遵循框架约定：session 的 `save_key`（`{app}/{user}`）是主作用域 —— 与内置 Mem0 服务完全一致 —— 配置值仅作兜底。

## 前置条件

1. TencentDB Agent Memory 已在本地运行：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

   在 `.env` 中设置 `MEMORY_LLM_BASE_URL` / `MEMORY_LLM_API_KEY` / `MEMORY_LLM_MODEL` —— 记忆引擎用该 LLM 完成提取与召回。

2. Python 3.10+ 与 trpc-agent-python（PyPI 包名 `trpc-agent-py`，≥ 1.1.17）：

   ```bash
   pip install trpc-agent-py
   ```

## 安装

直接从本仓库远程安装 —— 无需克隆源码：

```bash
pip install "git+https://github.com/TencentCloud/TencentDB-Agent-Memory.git#subdirectory=adapters/trpc-agent-python"
```

或从本地克隆安装：

```bash
pip install ./adapters/trpc-agent-python
```

或将 `tdai_trpc/` 包直接复制进你的项目（仅依赖 `trpc-agent-py` 与 `httpx`）。

## 快速上手

```python
from trpc_agent_sdk.agents import LlmAgent
from trpc_agent_sdk.models import OpenAIModel
from trpc_agent_sdk.runners import Runner
from trpc_agent_sdk.sessions import InMemorySessionService

from tdai_trpc import TDAiConfig, TencentDBMemoryService

memory = TencentDBMemoryService(TDAiConfig(
    gateway_url="http://127.0.0.1:8420",
    api_key=os.environ.get("TDAI_GATEWAY_API_KEY", ""),
    fail_open=True,
))

runner = Runner(
    app_name="my-app",
    agent=LlmAgent(name="assistant", model=OpenAIModel("gpt-4o-mini"),
                   instruction="You are a concise assistant."),
    session_service=InMemorySessionService(),
    memory_service=memory,   # 每轮结束后自动持久化到 gateway
)

async for event in runner.run_async(
    user_id="user-42",
    session_id="session-1",
    new_message=user_message("记住：我的项目代号是 Apollo Lake。"),
):
    ...
# 全新会话即可通过框架记忆路径召回该事实
```

可运行的端到端脚本见 [`example/quickstart.py`](./example/quickstart.py)。

## 配置参考

| 字段 | 作用 | 默认值 |
|---|---|---|
| `gateway_url` | memory-core gateway 地址（非本地明文 HTTP 默认拒绝，除非 `allow_remote_http=True`） | `http://127.0.0.1:8420` |
| `api_key` | `Authorization: Bearer` 密钥；gateway 以 `TDAI_GATEWAY_API_KEY` 启动时必填 | `""` |
| `timeout` | 单请求 HTTP 超时 | `5.0` 秒 |
| `app_name` / `user_id` | session 的 `save_key` 无法解析时的兜底身份；session 自身的 `save_key` 始终优先 | `"trpc-agent-app"` / `"default-user"` |
| `allow_remote_http` | 允许对非本地 gateway 使用明文 HTTP | `False` |
| `fail_open` | gateway 错误记日志并吞掉（检索返回空结果），而非抛出 | `True` |

构造函数第二个参数可传框架的 `MemoryServiceConfig` 控制 `enabled` / TTL；TTL 淘汰委托给 gateway（记忆引擎拥有保留策略）。

## 安全与行为

- **身份作用域**：每个请求携带从 `session.save_key` 解析的 app/user；它们是溯源字段而非鉴权边界 —— 硬性多租户隔离依赖 gateway 侧。
- **远程明文禁运凭证**：默认仅允许回环地址使用 `http://`。
- **默认 fail-open**：存储/检索失败仅记日志并跳过；记忆为硬性依赖时设置 `fail_open=False`。
- **捕获重试**：每会话水位线仅在成功响应后推进，失败捕获会在下次调用重试。存在窄重复窗口：gateway 已持久化但响应丢失时，重试会重发相同增量（消息 ID 由服务端分配）。
- **`enabled` 门**：框架配置禁用服务时 `store_session` / `search_memory` 直接空操作，独立于 runner 自身的门控。

## 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| 健康检查报 `GatewayError` | 服务未启动 —— 启动后检查 `MEMORY_CORE_PORT`（8420）。 |
| gateway 返回 401 | gateway 以 API key 启动 —— 通过 `TDAiConfig(api_key=...)` 传入。 |
| 没有任何捕获 | 确认服务已启用（`memory.enabled`，runner 以此门控持久化）；检查 session 的 `id` 与 `save_key` 非空。 |
| 新会话召回不到记忆 | 提取是异步的 —— 稍等几秒重试。 |
| 捕获重复 | 罕见：gateway 已持久化该轮但响应丢失，重试重发了增量。 |

## 测试

测试基于假 gateway 与真实的 `trpc_agent_sdk` 类运行（无需服务或 LLM）—— 5 个文件、39 个用例：

```bash
cd adapters/trpc-agent-python
pip install -e ".[test]"
pytest
```

## 说明

- **上游化**：本适配器自包含（子类化已发布的 PyPI 包）。将来合入 `trpc_agent_sdk/memory/` 上游是自然的后续演进。
- **版本**：已在 `trpc-agent-py` 1.1.17 与 TencentDB Agent Memory v2 镜像（`feat/server_team` 分支）上验证。

## 许可证

MIT，与主仓库一致。
