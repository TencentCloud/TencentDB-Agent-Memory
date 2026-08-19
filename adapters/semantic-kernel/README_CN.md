# TencentDB Agent Memory — Semantic Kernel 适配器

为 [Semantic Kernel](https://github.com/microsoft/semantic-kernel)（Python）智能体装上持久记忆：每轮对话自动进入 L0 → L3 记忆流水线，相关记忆可自动召回或按需检索。

接入后，你的 SK 智能体获得：

- **对话捕获** —— 增量的 user/assistant 对话流式发送到 gateway（`POST /capture`）
- **自动召回** —— 通过原生 `PROMPT_RENDERING` filter，每轮注入召回的记忆上下文（`POST /recall`），两种注入模式可配置
- **检索工具** —— `KernelPlugin` 暴露 `memory_search`（长期记忆）和 `conversation_search`（按会话作用域）两个 kernel function，供模型主动调用
- **会话 flush** —— 线程结束时显式调用 `POST /session/end`

> 说明：本适配面向 Semantic Kernel 本身。Microsoft Agent Framework（SK 的继任者）已有独立集成（见本仓库 PR #568）。

## 工作原理

```
Semantic Kernel ChatCompletionAgent
  ├─ PROMPT_RENDERING filter ─(POST /recall)──► 注入记忆上下文
  ├─ TencentDBMemory plugin ──(POST /search/*)─► 模型主动检索
  └─ capture_thread(thread) ──(POST /capture)──► L0 → L3 流水线
                                               ▼
                       Memory Core Gateway（端口 8420）
                      （捕获 · 提取 · 存储 · 召回）
```

适配器对接 **memory-core gateway**（默认 `:8420`），记忆引擎（提取/去重/场景沉淀/画像）运行在 gateway 侧。

## 前置条件

1. TencentDB Agent Memory 已在本地运行：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

   在 `.env` 中设置 `MEMORY_LLM_BASE_URL` / `MEMORY_LLM_API_KEY` / `MEMORY_LLM_MODEL` —— 记忆引擎用该 LLM 完成提取与召回。

2. Python 3.10+ 与 Semantic Kernel：

   ```bash
   pip install semantic-kernel
   ```

3. 一个 OpenAI 兼容 API Key，供智能体的对话模型使用。

## 安装

```bash
pip install ./adapters/semantic-kernel
```

或将 `tdai_sk/` 包直接复制进你的项目（除 `semantic-kernel` 与 `httpx` 外无其他依赖）。

## 快速上手

```python
from semantic_kernel.agents import ChatCompletionAgent
from semantic_kernel.connectors.ai.open_ai import OpenAIChatCompletion
from semantic_kernel.kernel import Kernel

from tdai_sk import TDAiConfig, TencentDBAgentMemory

mem = TencentDBAgentMemory(TDAiConfig(
    app_name="my-app",
    user_id="user-42",
    gateway_url="http://127.0.0.1:8420",
    api_key=os.environ.get("TDAI_GATEWAY_API_KEY", ""),
))

kernel = Kernel()
kernel.add_service(OpenAIChatCompletion(ai_model_id="gpt-4o-mini"))
mem.attach(kernel)                     # 自动召回 filter

agent = ChatCompletionAgent(
    kernel=kernel,
    name="assistant",
    instructions="You are a concise assistant.",
    plugins=[mem.as_plugin()],         # memory_search / conversation_search
)

response = await agent.get_response(messages="记住：我的项目代号是 Apollo Lake。")
await mem.capture_thread(response.thread)   # 增量捕获
# ……之后，全新线程……
response = await agent.get_response(messages="我的项目代号是什么？")
await mem.capture_thread(response.thread)
await mem.end_session(response.thread)
await mem.close()
```

## 召回注入模式

`TDAiConfig.recall_mode` 控制召回上下文进入提示词的方式：

| 模式 | 行为 |
|---|---|
| `"append"` *（默认）* | 每轮将召回块追加到渲染后的指令末尾，零配置。 |
| `"template"` | 召回块写入 `{{TDaiMemory}}` 模板变量 —— 在 instructions 中显式放置：`Relevant memory:\n{{TDaiMemory}}`。 |
| `"off"` | 关闭自动召回（工具仍可用）。 |

## 配置参考

| 字段 | 作用 | 默认值 |
|---|---|---|
| `gateway_url` | memory-core gateway 地址 | `http://127.0.0.1:8420` |
| `api_key` | `Authorization: Bearer` 密钥；gateway 以 `TDAI_GATEWAY_API_KEY` 启动时必填 | `""` |
| `app_name` / `user_id` | 捕获/召回的身份作用域 | `"semantic-kernel-app"` / `"default-user"` |
| `timeout` | 单请求 HTTP 超时 | `5.0` 秒 |
| `recall_mode` | `append` / `template` / `off` | `append` |
| `memory_search_tool` | 暴露 `memory_search` kernel function | `True` |
| `conversation_search_tool` | 暴露 `conversation_search` | `True` |
| `fail_open` | 记忆错误记日志并吞掉，而非抛出 | `True` |

## 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| 健康检查报 `GatewayError` | 服务未启动 —— 启动后检查 `MEMORY_CORE_PORT`（8420）。 |
| gateway 返回 401 | gateway 以 API key 启动 —— 通过 `TDAiConfig(api_key=...)` 传入。 |
| 新线程召回不到记忆 | 提取是异步的 —— 稍等几秒重试；确认 `recall_mode != "off"`。 |
| 模型从不调用工具 | 确认 `plugins=[mem.as_plugin()]` 且函数调用已启用（智能体默认 `FunctionChoiceBehavior.Auto()`）。 |
| template 模式下 `{{TDaiMemory}}` 为空 | 该变量仅在召回返回内容时写入；确认 `recall_mode="template"` 且已调用 `mem.attach(kernel)`。 |

## 测试

冒烟测试基于假 gateway 运行（无需服务或 LLM）：

```bash
cd adapters/semantic-kernel
pip install -e ".[test]"
pytest
```

## 说明

- **多租户注意**：recall 与 `memory_search` 读取 gateway 的共享长期存储，gateway 在这些路径上不强制按用户隔离。共享部署建议 `recall_mode="off"` 并关闭 `memory_search_tool`，或在 gateway 前做租户隔离。
- **版本**：已在 `semantic-kernel>=1.30` 与 TencentDB Agent Memory v2 镜像（`feat/server_team` 分支）上验证。

## 许可证

MIT，与主仓库一致。
