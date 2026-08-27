# DeepSeek Harness (dsh)

> agentSource: `dsh` | 协议: OpenAI Chat Completions | Handler: `handler.ts` (与 CB 共享)
>
> 本地历史导入 Memory Hub：见 [资产导入手册](./asset-import.md)。

---

## 1. 客户端接入配置

dsh 通过**配置文件** `~/.dsh/settings.yaml` + `~/.dsh/.credentials.yaml` 配置：

**`~/.dsh/settings.yaml`**：
```yaml
llm-deepseek:
  # dsh 从这个环境变量名里读 proxy user_key
  apiKeyEnv: PROXY_USER_KEY

  # ⚠️ 尾巴不要加 /v1 —— dsh 硬编码 ${baseURL}/chat/completions
  baseURL: http://127.0.0.1:8096/dsh/default

  # thinking 模式
  reasoningEffort: high
```

**`~/.dsh/.credentials.yaml`**：
```yaml
PROXY_USER_KEY: <业务用户的 sk-mem-... user_key>
```

**权限硬要求**（dsh 启动时检查，不对直接拒启动）：
```bash
chmod 700 ~/.dsh
chmod 600 ~/.dsh/.credentials.yaml
```

字段说明：
- `baseURL` — Proxy 地址 + `/dsh/<spaceId>`；**不带 `/v1`**（dsh 客户端硬编码 `${baseURL}/chat/completions`）
- `apiKeyEnv` — 指定从哪个环境变量名读 key，值本身在 `.credentials.yaml` 中
- `PROXY_USER_KEY` — 业务用户的 `user_key`（从面板获取）

请求路径（⚠️ dsh 不带 `/v1` 前缀）：
- `POST /dsh/:spaceId/chat/completions`（主路径）
- `POST /dsh/:spaceId/v1/chat/completions`（也接受）

---

## 2. Session ID

| 优先级 | Header |
|--------|--------|
| 1 | `x-deepseek-harness-session-id` |
| 2 | `x-session-id` |

dsh 客户端会自动生成并在 header 中携带 session ID，无需用户手动配置。Proxy 仅从 header 获取，没有 body 兜底。

---

## 3. Session Init（会话初始化 / Form）

### 3.1 机制

dsh 使用 **`ask_user_question`** tool_call 发起交互式 Form：

- Tool name: `ask_user_question`
- Call ID prefix: `call_dsh_session_init_`
- 协议: OpenAI Chat Completions SSE

### 3.2 状态机

复用 CB 状态机：

```
asset_confirm → team_select → agent_task_select → initialized
```

### 3.3 分页

dsh 的选项列表 **无数量限制**，无需分页。所有选项一次性展示。

### 3.4 Headless Bypass（⚠️ 重点差异）

dsh 有独特的 **headless bypass** 机制：

- 检查 `body.tools` 数组
- 如果 `body.tools` 非空 **但不包含** `ask_user_question` tool → proxy 判定为 headless 模式
- Headless 模式下 → **完全跳过** session-init，直接透传

这允许 dsh 在没有交互能力的场景（如 API 直调、batch 模式）正常工作。

### 3.5 reasoning_content 要求

dsh 客户端使用 DeepSeek 的 thinking mode，**硬校验** assistant 消息必须包含 `reasoning_content` 字段。  
proxy 生成 form 响应时需要填入非空 `reasoning_content` 占位。

### 3.6 跳过 Session Init

三种方式：
1. Headless bypass（tools 中无 `ask_user_question`）→ 自动跳过
2. 用户输入 "跳过" / "skip"
3. 在 asset_confirm 选"否"

### 3.7 首次会话 —— 选 Team → Agent → Task

启动 Web UI：

```bash
cd /path/to/deepseek-harness
pnpm dsh web --port 3080
# 或: node apps/cli/lib/bin.js web --port 3080
```

浏览器打开 <http://127.0.0.1:3080>，发一句话（比如 "hi"），Proxy 会返回 4 步按钮式表单：

1. "是否关联团队资产？" —— 选 **是** 关联注入，选 **否** 直接透传
2. Team 选择器（只有一个 team 时自动跳过）
3. Agent 选择器
4. Task 选择器（首项是虚拟 **"本次不关联任务"**）

选完后 Agent 会做一次自我介绍，之后每轮对话都会自动注入 `<session_context>` + `<available_skills>` + `<tdai_profile_memory>` 等块。

`mem:help` / `mem:sync` / `mem:create-skill` 等 mem 命令在 session init 完成后同样可用。

---

## 4. 请求分类

dsh 使用独立的分类逻辑：

| 类型 | 识别方式 | 处理 |
|------|----------|------|
| **compact** | `x-deepseek-harness-compact: 1` header | 辅助请求，跳过注入 |
| **title-gen** | Body 特征三合一：无 tools + thinking.disabled + max_tokens≤128 + system 以 "Create a concise title..." 开头 | 辅助请求，跳过注入 |
| **main** | 其他所有 | 完整链路 |

---

## 5. 用户文本提取

dsh 消息 content 始终是 **纯字符串**，无包裹标签：
- 不使用 `<user_query>` 包裹（与 CB 不同）
- 不使用 content block 数组（与 CC 不同）
- 直接取最后一条 user message 的 content string

---

## 6. 注入 Profile

dsh 共享 CB 的 handler 路径（都是 OpenAI Chat Completions），注入方式类似 CB：

```xml
<agent_skills>...</agent_skills>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

注入点: `messages[0].content`（system message 字符串内追加）。

---

## 7. 特殊行为

- **共享 Handler**: dsh 复用 CB 的 `handleChatCompletions`（不是独立 handler）
- **Client 指纹 Header**: 
  - `user-agent: deepseek-harness/*`
  - `x-deepseek-harness-user-id`
  - `x-deepseek-harness-session-id`
  - `x-deepseek-harness-compact`
- **Thinking mode**: assistant 消息可能携带 `reasoning_content` 字段（DeepSeek 思维链）
- **无 `<user_query>` 包裹**: 与 CB 共享 handler 但用户文本提取逻辑不同（dsh 不剥标签）

---

## 8. 归档触发

- 与 CB 共享归档机制
- 对话超阈值自动 `skill/conversation/add`
- 支持 `skill/conversation/force-archive`

---

## 9. 环境变量

无 dsh 专属变量。上游路由动态决定（一般指向 DeepSeek API）。

---

## 10. 常见问题

**Q: dsh 和 CB 共享 handler，怎么区分？**  
A: 路由层面由 `/:agent/` 段区分。进入 handler 后通过 `agentSource` 字段区分行为差异（form tool name、session ID header、content 提取逻辑等）。

**Q: dsh headless bypass 什么时候触发？**  
A: 当客户端发送的 `body.tools` 非空但不包含 `ask_user_question` 时。典型场景：dsh 在 API 模式直调（有自定义 tools 但没有用户交互 tool）。

**Q: dsh 的 `x-deepseek-harness-compact` header 是什么？**  
A: dsh 客户端在做对话压缩（compaction）时会带此 header。proxy 识别后跳过注入/归档，直接透传到上游做压缩。

**Q: 为什么 dsh 需要 reasoning_content 占位？**  
A: DeepSeek thinking mode 的客户端对 assistant 消息格式有硬校验——必须有 `reasoning_content` 字段。proxy 生成的 session-init form 响应也是 assistant 消息，所以必须包含此字段（内容可以为空字符串或 placeholder）。

---

## 11. 与 Claude Code / CodeBuddy / Codex 的差异

| 维度 | Claude Code | CodeBuddy | Codex | **dsh** |
|---|---|---|---|---|
| 协议 | Anthropic Messages | OpenAI Chat | OpenAI Responses | **OpenAI Chat** |
| 配置文件 | 环境变量 | `~/.codebuddy/models.json` | `~/.codex/config.toml` | `~/.dsh/settings.yaml` + `.credentials.yaml` |
| URL 前缀 | `/claude-code/<spaceId>` | `/codebuddy/<spaceId>` | `/codex/<spaceId>` | **`/dsh/<spaceId>`**（不带 `/v1`） |
| Key 传递 | env `ANTHROPIC_AUTH_TOKEN` | JSON `apiKey` | TOML `experimental_bearer_token` | `.credentials.yaml` 环境变量 |
| Session init | 自动弹表单 | 自动弹表单 | 首次需切 Plan 模式 | **自动弹表单** |
| UI 表单 tool | `AskUserQuestion` | `ask_followup_question` | fake `function_call` | **`ask_user_question`**（dsh 原生） |
| Wire 特殊 | cache_control markers | 无 | encrypted rs_id | **tool-call 轮 `reasoning_content` 必带**（Proxy 自动处理） |

---

## 12. 当前状态

- ✅ 代码实现完成
- ✅ 本地验证通过
- ⚠️ 生产环境暂未大规模使用
