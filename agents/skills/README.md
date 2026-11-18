# Skills（通用 OpenAI 兼容客户端）

> agentSource: `skills` | 协议: OpenAI Chat Completions（经通用 catch-all 路由） | 适配: `defaultAdapter`（未知客户端兜底）
>
> 这是 `agents/` 下与各 agent 平级的**通用接入文档**：任何兼容 OpenAI Chat Completions 的客户端 / 自研 SDK / 第三方平台，都可以用 `skills` 这个路径段接入 Proxy。

---

## ⚠️ 路由前提（务必先读）

Proxy **没有**为 `skills` 注册专用 adapter。`MemoryProxy/src/agent-adapters/index.ts` 的 `resolveAgentAdapter` 只识别 `claude-code / codebuddy / codex / workbuddy / dsh / opencode / pi`；未识别的 token（包括 `skills`）一律走 **`defaultAdapter`**（等价于改造前的老逻辑：请求恒为 `main`、content 内所有 text block 拼接）。

因此 `/skills/<spaceId>/...` 由 `server.ts` 的通用路由兜底：

- `POST /:agent/:spaceId/v1/chat/completions` → `handleChatCompletions`
- 顶层 `POST /*` catch-all → `handleChatCompletions`

即：**`skills` 当成“未知 OpenAI Chat 客户端”处理**，注入 / 写回 / L0 记忆 / skill buffer 全部生效（因为 `classifyRequest` 恒返回 `main`）。差异只在于没有 `skills` 专属的 session-init 交互表单。

---

## 1. 客户端接入配置

将客户端的 **OpenAI base URL** 指向 Proxy，模型 ID 与 API Key 保持不变：

```
http://127.0.0.1:8096/skills/default
```

- `skills` — URL 路径段（agent token），经通用路由落到 `defaultAdapter`
- `default` — memory 实例 ID（本地部署固定为 `default`）
- **不要在 base URL 尾部加 `/v1`** —— Proxy 的通用路由同时接受带 / 不带 `/v1` 两种写法，但多数 OpenAI SDK 会自动拼 `/v1/chat/completions`，此时 base 填 `.../skills/default` 即可

典型 OpenAI SDK 配置：

```json
{
  "baseURL": "http://127.0.0.1:8096/skills/default",
  "apiKey": "<业务用户的 sk-mem-... user_key>",
  "model": "<Proxy 上游支持的模型 ID，如 claude-opus-4.7>"
}
```

**绝对规则**：客户端必须打 **Proxy `:8096`**，禁止直连 Gateway `:8420`。直连 Gateway 会**绕过注入与写回**，记忆 / 技能 / 知识全部失效。

请求路径：
- `POST /skills/:spaceId/v1/chat/completions`（主路径，推荐）
- `POST /skills/:spaceId/chat/completions`（也接受）

---

## 2. Session ID

`skills` 走通用链路，Session ID 取以下 header（优先级从高到低）：

| 优先级 | Header |
|--------|--------|
| 1 | `x-conversation-id` |
| 2 | `x-session-id` |

客户端自行生成并携带即可；不强制。缺失时 Proxy 仍按单轮透传处理（不报错）。

---

## 3. Session Init（会话初始化）

`skills` 没有专用交互式 Form handler，因此**推荐用 Header 预选**一次性完成 session 注册（这是所有 agent 通用的能力，详见根 `agents/README.md` 的「Header 预选」一节）：

| Header | 说明 |
|--------|------|
| `Authorization: Bearer <user_key>` | 业务用户的 API Key（从面板获取） |
| `x-team-id` | 团队 ID |
| `x-agent-id` | Agent ID |
| `x-task-id` | 任务 ID（当前版本必填） |
| `x-conversation-id` | 会话标识，客户端自行生成 |

以上 header 齐全 → Proxy 直接完成 session 注册 + 注入资产，不弹 Form。

**选项：伪装成 `codebuddy` 走交互式 Form**
若你的客户端想要 Team → Agent → Task 的交互式表单体验，可把 base URL 的 token 换成 `codebuddy`（即 `.../codebuddy/default`）。按根 `agents/README.md`「其他平台接入」的说明，任何兼容 OpenAI 的平台都可伪装成已支持的 agent 之一接入。`codebuddy` 有完整的 `ask_followup_question` 表单流程，行为与 `skills` 同为 OpenAI Chat Completions，仅差一层 session-init 交互。

---

## 4. 请求分类

经由 `defaultAdapter`：

| 类型 | 识别方式 | 处理 |
|------|----------|------|
| **main** | 所有请求 | `classifyRequest` 恒返回 `main`，走完整注入 / 写回链路 |
| aux（embeddings / moderations / completions） | 路径后缀 | 走轻量透传 handler，不构成对话回合 |

`skills` 不经过 codex/workbuddy 的 compact / trace_summarize / realtime 等 aux 子路径判定。

---

## 5. 用户文本提取

`defaultAdapter.extractUserText` 把 `messages[].content` 内的**所有 `type:"text"` block 用 `\n` 拼接**：

- `content` 是 string → 直接返回
- `content` 是数组 → 收集每个 text block 拼接
- 其他 → 返回 null

即标准 OpenAI Chat Completions 的 message 形态即可，无需 `<user_query>` 包裹或 content block 特殊处理。

---

## 6. 注入 Profile

`skills` 复用通用注入逻辑（与 CodeBuddy 同源的 OpenAI Chat 注入点）：

```xml
<agent_skills>...</agent_skills>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

注入点：`messages[0].content`（system message 字符串内追加）。注入内容由 Proxy 按 `x-team-id` / `x-agent-id` / `x-task-id` 命中资产决定。

---

## 7. 特殊行为

- **通用兜底**: `skills` 走 `defaultAdapter`，没有任何客户端指纹 header 特判
- **协议**: 标准 OpenAI Chat Completions（`/v1/chat/completions`），SSE 流式受支持
- **无专属 Form**: 不带交互式 session-init tool；注册靠 Header 预选（见 §3）
- **与 `codebuddy` 的关系**: 协议、注入点、归档机制完全一致；区别仅在于 `codebuddy` 有专门的 `ask_followup_question` 表单，而 `skills` 没有

---

## 8. 归档触发

- 与 CodeBuddy / dsh 共享归档机制
- 对话超阈值自动 `skill/conversation/add`
- 支持 `skill/conversation/force-archive`

---

## 9. 环境变量

无 `skills` 专属变量。上游路由由 `resolveForwardTarget` 动态决定（一般指向配置的上游 LLM）。

---

## 10. 常见问题

**Q: 为什么 `skills` 不在 Proxy 的 agent 列表里？**
A: `skills` 是 `agents/` 目录下的**通用接入文档约定**，不是 Proxy 的专用 agent-source。Proxy 用通用 catch-all 路由 + `defaultAdapter` 兜住任意未知 token，所以 `/skills/default` 能直接工作。

**Q: 用 `skills` 还是 `codebuddy`？**
A: 想要最少配置、靠 header 预选注册资产 → 用 `skills`。想要交互式 Team/Agent/Task 表单 → 把 token 换成 `codebuddy`（协议相同，体验更完整）。

**Q: 直连 Gateway `:8420` 会怎样？**
A: 记忆 / 技能 / 知识注入与写回全部失效，等于没接 Memory Proxy。务必打 `:8096`。

**Q: 能不能用 Anthropic / Responses 协议？**
A: `skills` 走 OpenAI Chat Completions 兜底。若客户端是 Anthropic Messages，请改用 `/claude-code/default`；若是 Responses API，请改用 `/codex/default` 或 `/workbuddy/default`。

---

## 11. 与既有 agent 的差异

| 维度 | Claude Code | CodeBuddy | **skills（本页）** | dsh |
|---|---|---|---|---|
| 协议 | Anthropic Messages | OpenAI Chat | **OpenAI Chat（兜底）** | OpenAI Chat |
| URL 前缀 | `/claude-code/<spaceId>` | `/codebuddy/<spaceId>` | **`/skills/<spaceId>`** | `/dsh/<spaceId>` |
| adapter | claudeCodeAdapter | codebuddyAdapter | **defaultAdapter** | dshAdapter |
| Session init | 自动弹表单 | 自动弹表单 | **Header 预选（或伪装 codebuddy）** | 自动弹表单 |
| UI 表单 tool | `AskUserQuestion` | `ask_followup_question` | **无专属（靠 header）** | `ask_user_question` |
| 注入点 | system 前缀 | `messages[0].content` | **`messages[0].content`** | `messages[0].content` |

---

## 12. 当前状态

- ✅ 通用路由 + `defaultAdapter` 已支持（无需新增代码）
- ✅ 注入 / 写回 / L0 记忆 / 归档全部生效
- ⚠️ 无 `skills` 专属 session-init 交互表单（用 Header 预选或伪装 `codebuddy` 替代）
- 📌 接入方式见根 `agents/README.md`「其他平台接入」与「Header 预选」两节
