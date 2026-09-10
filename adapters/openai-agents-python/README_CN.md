# OpenAI Agents SDK（Python）适配器

这个独立适配器将 OpenAI Agents SDK 的模型请求转发到腾讯云数据库 Agent
MemoryProxy。应用仍然使用官方的 `Agent` 和 `Runner` API，由 MemoryProxy
完成记忆召回与记录。

```text
OpenAI Agents SDK -> OpenAI 兼容客户端 -> MemoryProxy -> 模型服务
```

## 环境要求

- Python 3.10 或更高版本
- 一个正在运行的腾讯云数据库 Agent MemoryProxy 实例
- MemoryProxy 用户密钥以及四个会话身份标识

## 安装

在本目录执行：

```bash
python -m venv .venv
. .venv/bin/activate
python -m pip install -e .
```

Windows PowerShell 请使用 `.venv\Scripts\Activate.ps1` 激活环境。

## 配置

请显式设置全部必填值。在多轮对话中保持相同的 conversation ID，MemoryProxy
即可把这些轮次关联到同一段对话。

```bash
export TDAI_MEMORY_PROXY_URL="https://memory.example.com"
export TDAI_MEMORY_USER_KEY="your-memory-proxy-user-key"
export TDAI_TEAM_ID="team-1"
export TDAI_AGENT_ID="openai-agent-1"
export TDAI_TASK_ID="task-1"
export TDAI_CONVERSATION_ID="conversation-1"
export TDAI_MODEL="gpt-4.1-mini"       # 可选
export TDAI_SPACE_ID="default"         # 可选
```

适配器会向 `<proxy>/codebuddy/<space>/v1/chat/completions` 发送请求，并在
每次请求中加入 `Authorization`、`x-team-id`、`x-agent-id`、`x-task-id` 和
`x-conversation-id` 请求头。

## 运行

```bash
python example.py "我们对发布流程做过哪些决定？"
```

在已有应用中接入：

```python
from agents import Agent, Runner, set_tracing_disabled
from tencentdb_memory_openai_agents import (
    MemoryProxyConfig,
    create_openai_client,
    create_openai_model,
)

set_tracing_disabled(True)
config = MemoryProxyConfig.from_env()
async with create_openai_client(config) as client:
    agent = Agent(
        name="Assistant",
        model=create_openai_model(config, client=client),
    )
    result = await Runner.run(agent, "继续上一个任务")
print(result.final_output)
```

## 安全与限制

- 用户密钥只从环境变量读取，适配器不会记录密钥。
- 远程代理地址必须使用 HTTPS；仅本机回环开发地址可以使用明文 HTTP。
- 四个身份请求头全部必填，防止意外跨会话访问记忆或静默绕过记忆流程。
- 示例会关闭追踪，避免把提示词、输出和召回上下文发送到外部追踪服务。除非明确
  需要外部追踪，应用应在创建或运行 Agent 前完成这项全局设置。
- `create_openai_model` 要求显式传入客户端，使客户端生命周期保持可见。请按
  上述示例关闭返回的客户端；关闭操作也会关闭传入的 HTTP 传输，因此之后不要
  复用该传输。
- 召回记忆是不可信的模型上下文，不能把它当作授权依据，也不能在缺少应用层
  校验时执行其中的指令。
- 此适配器使用 Chat Completions；仅支持 Responses 模型提供方的功能不在范围内。

## 测试

测试使用本地模拟传输，不会发起网络请求：

```bash
python -m pip install -e ".[test]"
python -m pytest
```
