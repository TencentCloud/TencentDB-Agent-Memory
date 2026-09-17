# Codex

> agentSource: `codex` | 协议: OpenAI Responses API | Handler: `codexHandler.ts` (独立)
>
> 本地历史导入 Memory Hub：见 [资产导入手册](./asset-import.md)。

---

## 1. 客户端接入配置

Codex 通过**配置文件** `~/.codex/config.toml` 配置：

```toml
# ~/.codex/config.toml
model_provider = "team-proxy"
model = "claude-opus-4.7"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.team-proxy]
name       = "TDAI team-proxy"
wire_api   = "responses"
base_url   = "http://127.0.0.1:8096/codex/default"
experimental_bearer_token = "<业务用户的 sk-mem-... user_key>"

request_max_retries    = 2
stream_max_retries     = 3
stream_idle_timeout_ms = 120000
```

字段说明：
- `wire_api = "responses"` — **必填**，Codex 使用 OpenAI Responses API 协议
- `base_url` — Proxy 地址 + `/codex/<spaceId>`；`default` 是 memory 实例 ID
- `experimental_bearer_token` — 业务用户的 `user_key`（从面板获取）
- `disable_response_storage = true` — 关闭本地缓存，确保每轮都经过 Proxy 注入
- `stream_idle_timeout_ms = 120000` — session-init 等待用户操作时避免被超时

> ⚠️ **首次对话前必须切到 Plan 模式**（`Shift+Tab`）。Codex 默认 Agent 模式会自动执行 tool call 跳过用户选择，导致 session-init 永远完不成。选完 Team→Agent→Task 后再切回 Agent 模式。

请求路径：
- `POST /codex/:spaceId/v1/responses`
- `POST /codex/:spaceId/responses`（无 v1 前缀，也接受）

辅助路径：
- `/codex/:spaceId/responses/compact` — compact 请求
- `/codex/:spaceId/memories/trace_summarize` — trace 总结
- `/codex/:spaceId/realtime/calls` — realtime 调用

---

## 2. Session ID

| 优先级 | 来源 |
|--------|------|
| 1 | `session-id` header |
| 2 | `body.client_metadata.session_id` |

Codex CLI 会自动生成并在 header 和 body 双写 session_id，无需用户手动配置。

---

## 3. Session Init（会话初始化 / Form）

### 3.1 机制

Codex 使用 **`request_user_input`** function_call 发起交互式 Form：

- Tool name: `request_user_input`
- ID prefix: `fc_codex_session_init_`（⚠️ 必须 `fc_` 前缀，OpenAI Responses 规范硬校验）
- Call ID prefix: `call_codex_session_init_`
- 协议: OpenAI Responses API SSE (`response.created` / `response.output_item.*` / `response.completed` events)

### 3.2 状态机

复用 CB 状态机，但带 `agentSource="codex"`, `protocol="responses"` 标记：

```
asset_confirm → team_select → agent_task_select → initialized
```

### 3.3 分页

Codex 使用专用的 `computeCodexPagination`，规则类似 CC（受限选项数），但实现独立。

### 3.4 ⚠️ Default Mode Gate（重点差异）

Codex 有两种运行模式：
- **Suggest mode** — `request_user_input` tool 可用 → 正常走 form
- **Default mode** — 客户端阻止 `request_user_input` 调用

**Default mode 判定**：当 proxy 发出 form 后，客户端返回的 `function_call_output.output` 包含：

```
"request_user_input is unavailable in Default mode"
```

proxy 检测到此 gate 字符串后 → **永久跳过** session-init，后续所有请求直接透传。

### 3.5 跳过 Session Init

三种方式：
1. Default mode gate 自动触发 → 永久跳过
2. 用户手动输入 "跳过" / "skip"
3. 在 asset_confirm 选"否"

---

## 4. 请求分类

Codex 使用 **三信号** 辅助请求判定：

| 信号 | 检查内容 |
|------|----------|
| 路径后缀 | `/compact`, `/memories/trace_summarize`, `/realtime/calls` |
| Header | `x-openai-memgen-request: true` |
| Body | `body.client_metadata.thread_source` ≠ `"main"` |

三者命中任一 → 判为 auxiliary → 跳过注入/归档。

---

## 5. 用户文本提取

从 `body.input[]` 数组中提取：
1. 找最后一条 `type: "message"` 且 `role: "user"` 的 item
2. 从其 `content[]` 中提取所有 `input_text` 类型 block 的文本
3. 拼接为最终用户文本

⚠️ Codex 的 body 结构与 Chat Completions 完全不同（`input[]` 而非 `messages[]`）。

---

## 6. 注入 Profile

使用 codex 专用注入构建器 `buildCodexInjectionBlock`：

```
instructions 字段注入（非 messages/input）
```

Codex 的注入点是 `body.instructions`（Responses API 的 system prompt 等价物）。

---

## 7. 特殊行为

- **独立 Handler**: `codexHandler.ts`，不与 CB/CC 共享
- **fc_ 前缀强制**: OpenAI Responses API 要求 function_call id 必须以 `fc_` 开头，否则客户端 replay 时返回 400
- **marker 路由**: `/codex/:spaceId/cost-guard/responses` 和 `/codex/:spaceId/analyse/responses` 支持 cost-guard/analyse 分流
- **归档 hook**: 2026-08-11 补齐了 codex 的 `skill/conversation/add` + TDAI L0 写入（之前静默丢数据）

---

## 8. 归档触发

- 对话超阈值自动 `skill/conversation/add`（通过 `normalize-conversation` 的 responses 分支）
- 支持 `skill/conversation/force-archive`
- Codex 归档需要经过 `normalizeCodexConversation` 转换为统一格式

---

## 9. 环境变量

```env
PROXY_PORT=8096
# Codex 上游（一般走 tokenhub 或 copilot.tencent.com）
# 由 resolveForwardTarget 动态路由
```

本机 codex 上游走 `https://copilot.tencent.com`（不带 /v1、/v2）。  
可用模型: `gpt-5.3-codex` / `gpt-5.4` / `gpt-5.5` / `gpt-5.6-*` / `deepseek-r1`，`claude-*` 硬拒。

---

## 10. 常见问题

**Q: Codex Default mode 下完全没有记忆注入吗？**  
A: 是的。Default mode gate 触发后 proxy 直接透传，不做任何注入。这是 codex 客户端设计决定的——Default mode 追求最小延迟。

**Q: fc_ 前缀问题是什么？**  
A: OpenAI Responses API 对 function_call 的 id 字段有正则校验，必须 `fc_` 开头。proxy 生成 form 时使用 `fc_codex_session_init_` 前缀，call_id 保持 `call_` 前缀。改前 codex 客户端 replay 第 5 次请求必 400。

**Q: Codex 的 /compact 请求是什么？**  
A: 类似 CC 的 conversation compaction（对话压缩），是客户端自动触发的辅助请求，不需要走注入/归档。

**Q: Codex 和 CB 的代码复用关系？**  
A: Codex 有独立的 `codexHandler.ts`，但 session-init 状态机底层复用 CB 的实现（传入不同 agentSource + protocol 参数）。

---

## 11. 与 Claude Code / CodeBuddy 的差异

| 维度 | Claude Code | CodeBuddy | Codex |
|------|-------------|-----------|-------|
| 协议 | Anthropic Messages | OpenAI Chat Completions | **OpenAI Responses** |
| 配置文件 | 环境变量 | `~/.codebuddy/models.json` | `~/.codex/config.toml` |
| URL 前缀 | `/claude-code/<spaceId>` | `/codebuddy/<spaceId>` | `/codex/<spaceId>` |
| Key 传递 | env `ANTHROPIC_AUTH_TOKEN` | JSON `apiKey` | TOML `experimental_bearer_token` |
| Session init | 自动弹表单 | 自动弹表单 | **首次需手动切 Plan 模式** |
