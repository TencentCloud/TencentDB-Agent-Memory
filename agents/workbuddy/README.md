# WorkBuddy (WB)

> agentSource: `workbuddy` | 协议: OpenAI Responses API (Desktop) + Chat Completions (Web) | Handler: `workbuddyHandler.ts` (独立)
>
> 本地历史导入 Memory Hub：见 [资产导入手册](./asset-import.md)。

---

## 1. 客户端接入配置

WB 通过**配置文件** `~/.workbuddy/models.json` 配置自定义模型：

```json
[
  {
    "id": "claude-opus-4.7-1m",
    "name": "claude-opus-4.7-1m",
    "vendor": "Custom",
    "url": "http://127.0.0.1:8096/workbuddy/default",
    "apiKey": "<业务用户的 sk-mem-... user_key>",
    "supportsToolCall": true,
    "supportsImages": false,
    "supportsReasoning": false,
    "useCustomProtocol": false
  }
]
```

字段说明：
- `id` — Proxy 上游支持的模型 ID（如 `claude-opus-4.7-1m`）
- `name` — 在 WorkBuddy「自定义模型」列表中显示的名称
- `vendor` — UI 展示用（`Custom`、`claude` 等），不影响实际请求
- `url` — Proxy 地址 + `/workbuddy/<spaceId>`；`default` 是 memory 实例 ID
- `apiKey` — 业务用户的 `user_key`（从面板获取）

配置完成后在 WorkBuddy 模型选择器的「自定义模型」中选择该模型。  
Session init 与 CC/CB 一致（选 Team → Agent → Task），session ID 由客户端自动管理。

### 内置模型（官方额度）的接入边界

> 以下说明针对 [Issue #1741](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/1741) 所报告的 WorkBuddy Desktop 行为，不代表所有未来客户端版本。

上面的 `models.json` 方式适用于**可以自定义模型请求地址**的模型。WorkBuddy 某些内置模型的请求目标由客户端管理：即使在 `models.json` 中使用相同的模型 ID 配置 Proxy 地址，客户端仍可能请求内置的官方端点，而**不经过 MemoryProxy**。因此不能仅凭配置文件成功加载，就认定内置模型的对话已接入腾讯记忆系统。

确认是否生效时，应同时检查 WorkBuddy 请求日志里的实际 URL 与 MemoryProxy 的请求日志：

1. **请求确实经过 Proxy**：再检查鉴权、会话初始化与记忆注入/归档状态。
2. **请求直接发往 WorkBuddy 官方端点**：Proxy 无法在该请求上进行上下文注入或自动归档；更改本地自定义模型配置并不能保证覆盖内置模型路由。

Issue #1741 中有用户实验性地使用 WorkBuddy `Stop` Hook 读取会话转录并调用 Core 的 `/v3/conversation/add`，让内置模型产生的对话进入 L0。这属于**社区验证过的独立写入思路**，并非此仓库已提供或承诺支持的 WorkBuddy 官方适配功能。它也**不等同于 Proxy 的上下文注入**：写入历史不能让正在执行的内置模型自动获得已存储的记忆。多会话并行、重复写入、隐私与凭证管理还需要额外处理。

目前如需使用本指南介绍的完整 Proxy 接入流程，应选择能配置实际请求地址、且上游协议匹配的**自定义模型**；不要为了验证文档而把真实凭证、转录内容或私有 URL 贴到公开 Issue。

请求路径：
- Desktop: `POST /workbuddy/:spaceId/v1/responses` 或 `/workbuddy/:spaceId/responses`
- Web: `POST /workbuddy/:spaceId/v1/chat/completions`

辅助路径（同 Codex）：
- `/workbuddy/:spaceId/responses/compact`
- `/workbuddy/:spaceId/memories/trace_summarize`
- `/workbuddy/:spaceId/realtime/calls`

---

## 2. Session ID

| 优先级 | 来源 |
|--------|------|
| 1 | `session-id` header |
| 2 | `body.client_metadata.session_id` |

WB 客户端会自动生成并携带 session ID，无需用户手动配置。

---

## 3. Session Init（会话初始化）

WB 的 session init 与 CC/CB 一致——交互式 Form 选择 Team → Agent → Task。

### 3.1 交互式 Form

客户端 `body.tools` 包含 `AskUserQuestion` tool 时走交互式 form：

- Tool name: `AskUserQuestion`（与 CC 相同）
- Call ID prefix: `call_wb_session_init_`
- 分页: CC 式分页（max 4 选项）
- 状态机: 复用 CB 状态机

### 3.4 Default Mode Gate

WB Desktop 也有 Default mode gate（同 Codex）：  
客户端返回 `"request_user_input is unavailable in Default mode"` → 永久跳过 form。

---

## 4. 请求分类

WB 使用与 Codex 相同的 **三信号** 辅助请求判定：

| 信号 | 检查内容 |
|------|----------|
| 路径后缀 | `/compact`, `/memories/trace_summarize`, `/realtime/calls` |
| Header | `x-openai-memgen-request: true` |
| Body | `body.client_metadata.thread_source` ≠ `"main"` |

---

## 5. 用户文本提取

WB 因为有两种协议，用户文本提取是 **双模式**：

| 模式 | 协议 | 提取方式 |
|------|------|----------|
| Desktop | Responses API | 从 `body.input[]` 提取（同 Codex 算法） |
| Web | Chat Completions | 从 `messages[].content` string 提取 + `<user_query>` 剥离（同 CB 算法） |

---

## 6. 注入 Profile

WB 有独立的注入 Profile，位于 `injection/agents/workbuddy/`：

- 独立 parser / serializer
- System prompt 使用 **nunjucks 模板**，含占位符：
  ```
  {{ WorkbuddyMemory_1 }}
  {{ WorkbuddySkills }}
  {{ WorkbuddyKnowledge }}
  ```
- 注入点取决于协议：
  - Responses API: `body.instructions`
  - Chat Completions: `messages[0].content`

---

## 7. 特殊行为

- **独立 Handler**: `workbuddyHandler.ts`，与 Codex/CB/CC 零交叉引用
- **双协议并存**: Desktop 走 Responses API，Web 走 Chat Completions，同一 handler 内处理
- **Desktop SDK**: 客户端使用 `@openai/agents 0.5.2` SDK
- **独特 Header 集**: `X-Agent-Intent`, `X-Agent-Purpose`, `X-User-Id`, `X-Codebuddy-Run-Timeout`
- **nginx 路由**: 内网 nginx 需配置 `/workbuddy/:iid/*` 转发到 proxy（2026-08-13 已加）

---

## 8. 归档触发

- 与 Codex 共享归档机制
- 对话超阈值自动 `skill/conversation/add`
- 支持 `skill/conversation/force-archive`

---

## 9. 环境变量

无 WB 专属变量。上游路由由 `resolveForwardTarget` 动态决定。

---

## 10. 常见问题

**Q: WB 接入最简单的方式是什么？**  
A: 在客户端请求中带上 `x-tdai-team-id` / `x-tdai-agent-id` / `x-tdai-task-id` 三个 header 即可。proxy 会直接注册并注入资产，零交互延迟。

**Q: WB 不带 header 又没 tool 会怎样？**  
A: 静默透传。不报错不阻塞，但也没有记忆/技能注入。这是故意设计——WB 不强制接入 memory。

**Q: WB Desktop 和 Web 为什么不同协议？**  
A: Desktop 版用了 `@openai/agents` SDK 走 Responses API；Web 版走标准 Chat Completions。proxy 两种都支持，由路径自动区分。

**Q: WB 和 Codex 的代码关系？**  
A: 完全独立。尽管都支持 Responses API，但 WB 有独立的 handler、injection profile、template 系统。没有 import 交叉。
