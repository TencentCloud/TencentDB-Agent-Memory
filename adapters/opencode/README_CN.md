# TencentDB Agent Memory — OpenCode 适配器

本适配器将 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) 集成到 [OpenCode](https://opencode.ai) 中，通过 Model Context Protocol (MCP) 为 OpenCode 编程 Agent 提供显式记忆检索与召回工具。

### 适用范围与功能说明

- **显式召回与搜索**：提供 `tdai_memory_search`（调用 `/v3/atomic/search` 检索 L1/L2 原子记忆）与 `tdai_conversation_search`（调用 `/v3/conversation/search` 检索 L0 原始对话）。
- **无后台自动捕获**：本 MCP 适配器为按需检索工具，**不会**自动监听 OpenCode 的 `session.idle` 事件进行后台对话录制，亦不包含自动系统 Prompt 注入。

---

## 前置条件

| 要求 | 版本 |
|---|---|
| [OpenCode](https://opencode.ai/docs) | >= 0.1.0 |
| TencentDB Agent Memory 网关 | 本地运行（默认端口 `8420`） |
| Node.js | >= 22.16.0 |

> **请先启动网关。**
> 参考主 README 的 [快速开始](https://github.com/TencentCloud/TencentDB-Agent-Memory#quick-start) 启动 memory 网关后再进行以下操作。

---

## 安装

### 第 1 步 — 在 `opencode.json` 中配置 MCP 服务器

在 OpenCode 配置文件（`~/.config/opencode/opencode.json`）中添加 TencentDB memory MCP 服务器：

```jsonc
{
  "mcp": {
    "tdai-memory": {
      "type": "stdio",
      "command": "node",
      "args": ["<本适配器目录的绝对路径>/mcp-server.mjs"],
      "env": {
        "TDAI_GATEWAY_URL": "http://localhost:8420",
        "TDAI_MEMORY_API_KEY": "your-user-key",
        "TDAI_MEMORY_SERVICE_ID": "default",
        "TDAI_TEAM_ID": "default",
        "TDAI_AGENT_ID": "opencode",
        "TDAI_USER_ID": "default"
      }
    }
  }
}
```

将 `<本适配器目录的绝对路径>` 替换为本目录的绝对路径，`your-user-key` 替换为您的用户/业务 API Key。

### 第 2 步 — 通过 OpenCode Rules 添加记忆指令

在项目根目录（或全局 `~/.config/opencode/AGENTS.md`）中创建或追加 `AGENTS.md`：

```markdown
## 记忆指令

您可以使用以下两个 TencentDB 记忆工具：
- `tdai_memory_search`：搜索原子记忆（L1/L2），获取相关事实、规范或历史决策
- `tdai_conversation_search`：搜索原始历史对话记录（L0）

在开始任何任务之前，请使用当前任务描述调用 `tdai_memory_search` 以回忆相关上下文。
```

### 第 3 步 — 验证

启动 OpenCode 并运行 `/tools` — 您应该能看到 `tdai_memory_search` 和 `tdai_conversation_search` 已列出。

---

## 工作原理

本适配器是一个轻量级 MCP stdio 服务器，将工具调用代理到 TencentDB Agent Memory v3 网关 HTTP API，并在请求体中携带租户隔离参数。

```
OpenCode 会话
  |
  +-- [工具调用] tdai_memory_search("任务描述")
  |     --> POST /v3/atomic/search { team_id, agent_id, user_id, query, limit }
  |     <-- 返回排序后的原子记忆记录
  |
  +-- [工具调用] tdai_conversation_search("关键词")
        --> POST /v3/conversation/search { team_id, agent_id, user_id, query, limit }
        <-- 返回匹配的对话摘录
```

---

## 环境变量配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `TDAI_GATEWAY_URL` | `http://localhost:8420` | 记忆网关基础 URL |
| `TDAI_MEMORY_API_KEY` | `""` | 用户/业务 API 密钥（通过 `Authorization: Bearer <key>` 传递） |
| `TDAI_MEMORY_SERVICE_ID` | `default` | 空间/服务标识（通过 `x-tdai-service-id` 传递） |
| `TDAI_AGENT_ID` | `opencode` | 记忆隔离的 Agent 标识符 |
| `TDAI_TEAM_ID` | `default` | 记忆隔离的团队标识符 |
| `TDAI_USER_ID` | `default` | 记忆隔离的用户标识符 |
| `TDAI_TASK_ID` | `""` | 可选的任务标识符 |
| `TDAI_RECALL_LIMIT` | `5` | 每次搜索返回的最大记忆条数 |
| `TDAI_TIMEOUT_MS` | `5000` | HTTP 请求超时时间（毫秒） |

---

## 运行测试

```bash
node --test adapters/opencode/tests/mcp-server.test.mjs
```

测试基于符合 v3 契约的模拟网关运行，无需任何外部服务。

---

## 相关链接

- [Issue #926 — 适配器征集](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/926)
- [OpenCode MCP 服务器文档](https://opencode.ai/docs/mcp-servers)
- [MCP 协议规范](https://modelcontextprotocol.io)
