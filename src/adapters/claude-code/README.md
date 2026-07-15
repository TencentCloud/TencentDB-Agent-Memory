# Claude Code Adapter（Pattern B-MCP）

把 [TencentDB Agent Memory](../../../README.md) 的记忆能力接入 [Claude Code](https://docs.claude.com/en/docs/claude-code)，让 Claude Code 跨会话记住你的偏好、项目背景与历史对话。

采用 **Pattern B-MCP**：一个 MCP stdio server 作为 Gateway 的 HTTP 客户端，Claude Code 通过 MCP 协议调用记忆工具。架构与选型理由见 [`docs/adapters/README.md`](../../../docs/adapters/README.md)。

---

## 架构一览

```
┌──────────────┐   MCP stdio    ┌─────────────────────┐   HTTP    ┌──────────────┐
│  Claude Code │ ◄────────────► │  memory-tdai-mcp    │ ◄───────► │  TDAI Gateway│
│  (Host)      │   3 个工具      │  (bin launcher +     │  :8420    │  (TdaiCore)  │
└──────────────┘                │   mcp-server.ts)    │           └──────────────┘
                                └─────────────────────┘
```

- **Claude Code** 作为 Host，通过 `.mcp.json` 注册 MCP server。
- **memory-tdai-mcp**（本适配器）是进程外薄客户端：注册 3 个记忆工具，把工具调用转发为 Gateway HTTP 请求。
- **TDAI Gateway** 是独立进程，承载 `TdaiCore` 引擎（L0 原始对话 / L1 结构化记忆 / L2 persona / L3 scene）。

> 阶段 2 已补充 hooks（`UserPromptSubmit` → 自动 recall、`Stop` → 自动 capture、`SessionEnd` → flush），与 MCP 工具互补：hooks 形成全自动记忆闭环，MCP 工具供 Agent 按需显式检索。

---

## 前置条件

1. **Node.js ≥ 22.16**（与主仓库一致）
2. **TDAI Gateway 已启动**——MCP server 只是客户端，记忆引擎在 Gateway 里。

   最简启动方式（项目根目录）：

   ```bash
   npm run gateway
   ```

   默认监听 `http://127.0.0.1:8420`，数据目录 `~/.memory-tencentdb/memory-tdai/`。详细配置见 [`src/gateway/`](../../gateway/)。

3. **（可选）API Key**：若 Gateway 启用了 `TDAI_GATEWAY_API_KEY`，需在 MCP server 侧配置相同的 key（见下文环境变量）。

---

## 安装

本适配器随主包一起发布，无需单独安装。开发环境下需先构建产物：

```bash
# 在项目根目录执行
npm run build:plugin      # tsdown 把 mcp-server.ts 打到 dist/
```

构建产物：`dist/src/adapters/claude-code/mcp-server.mjs`

启动器：[`bin/memory-tdai-mcp.mjs`](../../../bin/memory-tdai-mcp.mjs)（薄启动器，加载预编译产物并调用 `runMcpServer()`）

验证安装：

```bash
node ./bin/memory-tdai-mcp.mjs
# 应在 stderr 看到 Gateway 健康探测日志（若 Gateway 未启会打印警告但不崩溃）
```

---

## 配置

### 1. 注册 MCP server

在 Claude Code 项目根目录创建 `.mcp.json`（模板见 [`config/mcp.json.example`](./config/mcp.json.example)）：

```json
{
  "mcpServers": {
    "memory-tdai": {
      "command": "node",
      "args": ["./bin/memory-tdai-mcp.mjs"],
      "env": {
        "TDAI_GATEWAY_BASE_URL": "http://127.0.0.1:8420",
        "TDAI_MCP_API_KEY": "",
        "TDAI_USER_ID": "default_user"
      }
    }
  }
}
```

> `args` 路径相对于 Claude Code 的工作目录；若把包安装到全局，可改用 `npx memory-tdai-mcp`。

### 2. 环境变量

| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `TDAI_GATEWAY_BASE_URL` | `http://127.0.0.1:8420` | Gateway 完整 baseUrl（反代场景可覆盖） |
| `TDAI_GATEWAY_HOST` | `127.0.0.1` | Gateway 主机（仅当未设 `BASE_URL` 时生效） |
| `TDAI_GATEWAY_PORT` | `8420` | Gateway 端口（仅当未设 `BASE_URL` 时生效） |
| `TDAI_MCP_API_KEY` | （空） | Bearer 令牌（首选）；回退 `TDAI_GATEWAY_API_KEY` |
| `TDAI_USER_ID` | `default_user` | 用户标识，用于隔离不同用户的记忆空间 |

### 3. Hooks（自动 recall / capture / session-end）

阶段 2 已实装三个 Claude Code 事件钩子，配置模板见 [`config/settings.json.example`](./config/settings.json.example)：

| 钩子事件 | 脚本 | 作用 |
| :--- | :--- | :--- |
| `UserPromptSubmit` | `hooks/recall.ts` | 用户提交 prompt 时自动 recall，把 `<relevant-memories>` 注入上下文 |
| `Stop` | `hooks/capture.ts` | 助手回复结束时解析 transcript，把本轮 user/assistant 写入 L0 |
| `SessionEnd` | `hooks/session-end.ts` | 会话结束时通知 Gateway flush |

把 `.example` 复制为 `.claude/settings.json` 即可启用。钩子用 `npx tsx` 直接跑 TS 源码（需项目装 `tsx`：`npm i -D tsx`）。所有钩子吞掉异常、退出码 0，记忆永不阻塞对话。

> 与 MCP 工具的关系：hooks 是宿主事件驱动（自动），MCP 工具是模型主动调用（显式），两者互补。

---

## 工具说明

MCP server 注册 3 个工具（schema 定义见 [`src/sdk/tool-schemas.ts`](../../sdk/tool-schemas.ts)）：

### `tdai_memory_search` — L1 记忆搜索

搜索结构化长期记忆（persona / episodic / instruction）。

| 参数 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `query` | string | ✅ | 搜索查询 |
| `limit` | number | — | 返回条数上限（默认 5，最大 20） |
| `type` | enum | — | `persona` / `episodic` / `instruction` |
| `scene` | string | — | 按场景名过滤 |

### `tdai_conversation_search` — L0 会话搜索

搜索原始对话历史（当结构化记忆没有所需信息时使用）。

| 参数 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `query` | string | ✅ | 搜索查询 |
| `limit` | number | — | 返回消息条数上限（默认 5，最大 20） |
| `session_key` | string | — | 限定某个会话 |

### `tdai_capture` — 手动捕获对话轮

把一轮对话写入 L0，并调度 L1/L2/L3 抽取管线。通常由 hooks 自动完成；此工具供 Agent 在需要时显式持久化。

| 参数 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `user_content` | string | ✅ | 用户消息文本 |
| `assistant_content` | string | ✅ | 助手回复文本 |
| `session_key` | string | — | 会话分组键；缺省由 binding 注入 |

> **调用限额**：`tdai_memory_search` 与 `tdai_conversation_search` 共享每轮 3 次的上限。

---

## 手动验收清单

按以下步骤在真实 Claude Code 中验证跨会话记忆持久化：

- [ ] **1. Gateway 已启**：`curl http://127.0.0.1:8420/health` 返回 `{"status":"ok"}` 或 `{"status":"degraded"}`
- [ ] **2. MCP server 注册成功**：启动 Claude Code，在工具列表中看到 `tdai_memory_search` / `tdai_conversation_search` / `tdai_capture`
- [ ] **3. 写入记忆**：对 Claude Code 说「请用 tdai_capture 记住：我偏好用 TypeScript 写代码」
- [ ] **4. 即时搜索**：调用 `tdai_conversation_search` 查询 "TypeScript"，应返回上一步的对话
- [ ] **5. 跨会话召回**：退出 Claude Code，重新打开同一项目，再次询问「我喜欢用什么语言？」——Claude Code 应能通过 `tdai_memory_search` 或 `tdai_conversation_search` 找到 TypeScript 偏好
- [ ] **6. （可选）鉴权**：若设了 `TDAI_MCP_API_KEY`，确认无 key 时工具调用返回 401、有 key 时正常

---

## 已验证版本

| 组件 | 版本 | 状态 |
| :--- | :--- | :--- |
| Claude Code | *待阶段 2 真实环境验证后填写* | 计划验证 |
| Node.js | 22.16.0 | ✅ 已验证（CI 与本地） |
| MCP SDK | `@modelcontextprotocol/sdk` 1.29.0 | ✅ 已验证 |
| TDAI Gateway | 主仓库当前版本 | ✅ 已验证（集成测试 8/8 通过） |

> 阶段 2 将在真实 Claude Code 会话中跑通验收清单并回填本表。

---

## 故障排查

| 现象 | 可能原因 | 处理 |
| :--- | :--- | :--- |
| MCP server 启动时报「预编译产物不存在」 | 未执行 `npm run build:plugin` | 在项目根目录跑构建 |
| 工具调用返回 `ECONNREFUSED` | Gateway 未启动 | `npm run gateway` 启动 Gateway |
| 工具调用持续失败 | 触发熔断（5 次失败 → 60s 冷却） | 检查 Gateway 健康，等冷却期过后自动半开恢复 |
| 工具调用返回 401 | `TDAI_MCP_API_KEY` 与 Gateway 的 `TDAI_GATEWAY_API_KEY` 不一致 | 对齐两侧 key |
| Windows 下 `ERR_UNSUPPORTED_ESM_URL_SCHEME` | bin launcher 用了裸 Windows 路径 | 已通过 `pathToFileURL` 修复，确认用的是最新 `bin/memory-tdai-mcp.mjs` |

---

## 相关文档

- 设计规范：[`docs/adapters/claude-code-adapter-design.md`](../../../docs/adapters/claude-code-adapter-design.md)
- 实施计划：[`docs/adapters/claude-code-adapter-plan.md`](../../../docs/adapters/claude-code-adapter-plan.md)
- 平台对比：[`docs/adapters/README.md`](../../../docs/adapters/README.md)
- Gateway API：[`src/gateway/server.ts`](../../gateway/server.ts)
- SDK 接口：[`src/sdk/client.ts`](../../sdk/client.ts)、[`src/sdk/event-binding.ts`](../../sdk/event-binding.ts)
