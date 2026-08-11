# OpenCode × TencentDB Agent Memory

OpenCode 适配器：让每个 Agent 会话都拥有由
[TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) 支撑的持久记忆。

## 功能

- `session.idle` 时，通过官方 OpenCode SDK（`client.session.messages`）读取结束的会话，
  并沉淀为记忆网关的 L0 conversation（`POST /v3/conversation/add`）。
- 提供 `memory_search` 工具，Agent 可在会话中检索结构化记忆（`POST /v3/atomic/search`）。
- Pull 式召回：由 Agent 决定何时检索，记忆上下文不会被动注入每条消息。
- 零依赖：无构建步骤、无传递依赖，插件是单一可审计的 ESM 文件，Node ≥ 18 即可运行。

## 为什么这样设计

- **天然可审计**：整个适配器只有一个文件。沉淀与召回保持轻量，抽取、向量化、检索
  全部留在 MemoryCore，职责边界清晰。
- **绝不写入占位数据**：读不到对话原文时，直接跳过沉淀并告警，而不是往记忆里塞假消息。
- **回合去重**：同一段已结束的对话只沉淀一次，即使 `session.idle` 重复触发。
- **失败有界**：每次网关调用都有超时与一次重试；校验 v3 信封 `{code, message, data}`，
  Agent 看到的是真实错误，而不是静默的部分成功。

## 工作原理

```text
OpenCode 会话
   │  session.idle
   ▼
适配器 (src/index.js)
   │  client.session.messages()          （读取已结束的对话）
   │  POST /v3/conversation/add          （沉淀为 L0 conversation）
   ▼
TencentDB Agent Memory 网关 ──► MemoryCore 流水线 ──► 可检索记忆
   ▲
   │  memory_search 工具
   │  POST /v3/atomic/search
   └── Agent 提问"搜索我关于 X 的记忆"
```

两个钩子覆盖完整闭环：**沉淀**（capture）记录发生了什么，**召回**（recall）
让后续会话可用。召回是 Agent 驱动的：不在每条消息里注入上下文，而是当 Agent
确实需要历史事实时主动调用 `memory_search`——更少污染 prompt，行为更可预期。

## 前置条件

- OpenCode CLI（支持插件的新版本）。
- 本地已启动 TencentDB Agent Memory 网关：

  ```bash
  cd deploy/global-images
  cp .env.example .env && $EDITOR .env
  ./start-all.sh
  ```

## 安装

在项目配置中引入插件：

```jsonc
// opencode.json
{
  "plugin": ["./adapters/opencode-memory/src/index.js"]
}
```

可选环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OPCODE_MEMORY_GATEWAY_URL` | `http://127.0.0.1:8420` | 记忆网关地址 |
| `OPCODE_MEMORY_API_KEY` | `local` | 网关 API Key（开启鉴权时）|
| `OPCODE_MEMORY_TEAM_ID` / `_AGENT_ID` / `_USER_ID` | `default` / `opencode` / `default` | 多租户隔离 |
| `OPCODE_MEMORY_TIMEOUT_MS` | `10000` | 单次网关请求超时 |

## 使用

让 Agent"搜索我关于 X 的记忆"，它会调用 `memory_search` 工具并基于持久记忆回答。
每个结束的会话都会自动去重沉淀，供下一次会话复用。

## 开发

测试仅使用 Node 内置测试运行器与本地 mock 网关：

```bash
node --check src/index.js
node --test
```

无需安装依赖，适配器为纯 ESM JavaScript。
