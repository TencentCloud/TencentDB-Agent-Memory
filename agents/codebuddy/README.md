# CodeBuddy (CB)

> agentSource: `codebuddy` | 协议: OpenAI Chat Completions / Anthropic Messages | Handler: `handler.ts` (共享)
>
> 本地历史导入 Memory Hub：见 [资产导入手册](./asset-import.md)。

---

## 1. 客户端接入配置

CB 通过**配置文件** `~/.codebuddy/models.json` 配置自定义模型：

```json
{
  "models": [
    {
      "id": "claude-sonnet-4-20250514",
      "name": "proxy-memory-agent",
      "vendor": "claude",
      "apiKey": "<业务用户的 sk-mem-... user_key>",
      "maxInputTokens": 200000,
      "url": "http://127.0.0.1:8096/codebuddy/default",
      "supportsToolCall": true,
      "supportsImages": true
    }
  ]
}
```

字段说明：
- `id` — Proxy 上游支持的模型 ID（如 `claude-sonnet-4-20250514`）
- `name` — 在 CodeBuddy 对话框中显示的名称，可自定义
- `vendor` — UI 展示用（如 `claude`、`openai`），不影响实际请求
- `apiKey` — 业务用户的 `user_key`（从面板获取，与 CC 的 `ANTHROPIC_AUTH_TOKEN` 相同）
- `url` — Proxy 地址 + `/codebuddy/<spaceId>`；`default` 是 memory 实例 ID

配置完成后在 CB 对话框中选择该模型即可。

### ⚠️ 版本限制

> CodeBuddy **4.10.2 ~ 4.10.4** 不携带 sessionId，无法完成 Session Init。  
> **请使用 ≥ 4.10.5 或 ≤ 4.10.1**。

请求路径：
- OpenAI: `POST /codebuddy/:spaceId/v1/chat/completions`
- Anthropic: `POST /codebuddy/:spaceId/v1/messages`

---

## 2. Session ID

| 优先级 | Header |
|--------|--------|
| 1 | `x-conversation-id` |
| 2 | `x-session-id` |
| 3 | `x-cb-session-id` |
| 4 | `x-codebuddy-session-id` |

CB IDE 插件会自动生成并携带 `x-conversation-id`。

---

## 3. Session Init（会话初始化 / Form）

### 3.1 机制

CB 使用 **`ask_followup_question`** function_call 发起交互式 Form：

- Tool name: `ask_followup_question`
- Call ID prefix: `call_session_init_` (OpenAI) / `toolu_session_init_` (Anthropic)
- 协议: OpenAI SSE tool_calls chunks 或 Anthropic SSE

### 3.2 状态机

```
asset_confirm → team_select → agent_task_select → initialized
```

4 步流程：
1. **asset_confirm** — 确认是否需要注入资产（"是否使用记忆/技能？"）
2. **team_select** — 选择团队
3. **agent_task_select** — 合并选择 Agent + Task
4. **initialized** — 注入资产，进入正常对话

### 3.3 分页

CB 的 `ask_followup_question` 选项列表 **无数量限制**，无需分页。  
所有选项一次性全部展示。

### 3.4 Plan Mode / Default Mode

CB **不存在** Default Mode gate。CB 客户端始终有 `ask_followup_question` tool 可用，form 始终可发。

### 3.5 跳过 Session Init

- 在 `asset_confirm` 步骤选择 "否" → 跳过所有后续步骤，直接透传
- 在任何步骤输入 "跳过" / "skip" → SKIP_RE 匹配后跳过

---

## 4. 请求分类

CB 的请求分类较简单：

| 类型 | 说明 |
|------|------|
| **main** | 所有请求默认都是 main |

CB **没有** fork / sidequery / compact 等辅助请求概念。每条请求都走完整链路。

---

## 5. 用户文本提取

CB 消息体 `message.content` 始终是 **纯字符串**（不是 content block 数组）。

提取逻辑：
1. 在字符串中查找 `<user_query>...</user_query>` XML 包裹
2. 若找到 → 提取内部文本
3. 若未找到 → 整个字符串作为用户文本
4. 剥离 CB 伪 XML 标签 (`<agent_context>`, `<code_context>` 等)

---

## 6. 注入 Profile

**XML 结构**的 system prompt 注入：

```xml
<agent_skills>
  <available_skills>...</available_skills>
</agent_skills>
<content_policy>...</content_policy>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

注入点：
- OpenAI: `messages[0].content`（system message 字符串内追加）
- Anthropic: `system` 字段

---

## 7. 特殊行为

- **独特 Header 集**: `x-agent-intent`, `x-conversation-message-id`, `x-conversation-request-id`
- **Assistant placeholder**: CB assistant 消息可能是 `"-"` 占位（空回复标记）
- **共享 Handler**: dsh 也复用此 handler (`handleChatCompletions`)
- **双协议支持**: 同一 CB 版本可能走 OpenAI 或 Anthropic 协议，handler 自动适配

---

## 8. 归档触发

- 对话超过阈值自动触发 `skill/conversation/add`
- 支持 `skill/conversation/force-archive`
- 归档数据写入 L0

---

## 9. 环境变量

无 CB 专属变量。使用全局 proxy 配置：

```env
PROXY_PORT=8096
FORWARD_URL=https://api.openai.com   # CB OpenAI 上游
# 或 FORWARD_URL=https://api.anthropic.com  # CB Anthropic 上游
```

实际上游由 `resolveForwardTarget` 动态决定（tokenhub / 直连 provider）。

---

## 10. 常见问题

**Q: CB 和 CC 的主要区别是什么？**  
A: 协议不同（OpenAI vs Anthropic）、内容结构不同（string vs content-block array）、无辅助请求分类、选项无分页。

**Q: CB 的 `<user_query>` 包裹是谁加的？**  
A: CB IDE 插件客户端在发送前自动包裹用户原文，proxy 提取时剥离。

**Q: CB 走 Anthropic 协议时和 CC 有什么区别？**  
A: form tool name 不同 (`ask_followup_question` vs `AskUserQuestion`)，content 仍是 string 格式，注入用 XML 而非 Markdown。agentSource 标记不同。
