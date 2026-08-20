# TencentDB Agent Memory — OpenCode 适配器

本适配器将 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) 集成到 [OpenCode](https://opencode.ai) 中，使 OpenCode 编程 Agent 在会话之间拥有持久长期记忆。

安装后，OpenCode 将自动：
- **回忆**每次会话前相关的历史经验
- **捕获**对话内容，并将其提炼为结构化记忆（L0 → L1 → L2 → L3）
- **暴露**两个只读搜索工具：`tdai_memory_search` 和 `tdai_conversation_search`

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
        "TDAI_ADMIN_KEY": "your-admin-key"
      }
    }
  }
}
```

将 `<本适配器目录的绝对路径>` 替换为本目录的绝对路径，`your-admin-key` 替换为您的网关 admin key。

### 第 2 步 — 通过 OpenCode Rules 添加记忆指令

在项目根目录（或全局 `~/.config/opencode/AGENTS.md`）中创建或追加 `AGENTS.md`：

```markdown
## 记忆指令

您可以使用以下两个记忆工具：
- `tdai_memory_search`：搜索长期记忆，获取相关事实、偏好或上下文
- `tdai_conversation_search`：搜索原始历史对话记录

在开始任何任务之前，请使用当前任务描述调用 `tdai_memory_search` 以回忆相关上下文。
```

### 第 3 步 — 验证

启动 OpenCode 并运行 `/tools` — 您应该能看到 `tdai_memory_search` 和 `tdai_conversation_search` 已列出。

---

## 工作原理

本适配器是一个轻量级 MCP stdio 服务器，将工具调用代理到 TencentDB Agent Memory 网关 HTTP API。所有记忆提取和存储（L0→L3 流水线）均由网关处理。

```
OpenCode 会话
  |
  +-- [工具调用] tdai_memory_search("任务描述")
  |     --> GET /v3/memory/recall { query, limit }
  |     <-- 返回排序后的记忆片段
  |
  +-- [工具调用] tdai_conversation_search("关键词")
        --> GET /v3/conversation/search { query, limit }
        <-- 返回匹配的对话摘录
```

---

## 环境变量配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `TDAI_GATEWAY_URL` | `http://localhost:8420` | 记忆网关基础 URL |
| `TDAI_ADMIN_KEY` | _(必填)_ | 网关 admin API 密钥 |
| `TDAI_AGENT_ID` | `opencode` | 记忆隔离的 Agent 标识符 |
| `TDAI_TEAM_ID` | `default` | 记忆隔离的团队标识符 |
| `TDAI_USER_ID` | `default` | 记忆隔离的用户标识符 |
| `TDAI_RECALL_LIMIT` | `5` | 每次搜索返回的最大记忆条数 |
| `TDAI_TIMEOUT_MS` | `5000` | HTTP 请求超时时间（毫秒） |

---

## 运行测试

```bash
node --test adapters/opencode/tests/mcp-server.test.mjs
```

测试基于假网关运行，无需任何外部服务。

---

## 相关链接

- [Issue #926 — 适配器征集](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/926)
- [OpenCode MCP 服务器文档](https://opencode.ai/docs/mcp-servers)
- [MCP 协议规范](https://modelcontextprotocol.io)
