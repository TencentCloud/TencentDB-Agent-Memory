# OpenCode × TencentDB Agent Memory

OpenCode 适配器：让每个 Agent 会话都拥有由
[TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) 支撑的持久记忆。

## 功能

- `session.idle` 时，把当前回合对话写入记忆网关（L0 conversation）。
- 提供 `memory_search` 工具，Agent 可在会话中检索结构化记忆（`/v3/atomic/search`）。
- 与框架解耦：直接调用网关 REST API（接口契约见
  `MemoryCore/hermes-plugin/memory/memory_tencentdb/client.py`）。
- 零依赖：无构建步骤、无传递依赖，插件是单一可审计文件，Node ≥ 18 即可运行。

## 工作原理

```text
OpenCode 会话
   │  session.idle
   ▼
适配器 (src/index.js)
   │  POST /v3/conversation/add      （把对话沉淀为 L0 conversation）
   ▼
TencentDB Agent Memory 网关 ──► MemoryCore 流水线 ──► 可检索记忆
   ▲
   │  memory_search 工具
   │  POST /v3/atomic/search
   └── Agent 提问"搜索我关于 X 的记忆"
```

两个钩子覆盖完整闭环：**沉淀**（capture）记录发生了什么，**召回**（recall）
让后续会话可用。两者都保持轻量，便于审计，重活（抽取、向量化、检索）留在
MemoryCore，职责边界清晰。

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
| `OPCODE_MEMORY_API_KEY` | 无 | 网关 API Key（开启鉴权时）|
| `OPCODE_MEMORY_TEAM_ID` / `_AGENT_ID` / `_USER_ID` | `default` / `opencode` / `default` | 多租户隔离 |

## 使用

让 Agent"搜索我关于 X 的记忆"，它会调用 `memory_search` 工具并基于持久记忆回答。
每个结束的会话都会自动沉淀，供下一次会话复用。

## 说明

- 网关契约采用 v3 信封 `{code, message, data}`；非零 code 会原样返回给 Agent，失败可见。
- 对话抓取优先使用 `ctx.client.session.chat`；若回合尚未落盘，则回退到事件元数据，保证链路不阻塞。

## 开发

```bash
node --check src/index.js
```

无需安装依赖，适配器为纯 ESM JavaScript。
