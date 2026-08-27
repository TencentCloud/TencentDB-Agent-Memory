# OpenCode

> agentSource: `opencode` | 协议: OpenAI Chat Completions | Handler: `handler.ts` (与 CB / dsh 共享)

---

## 1. 客户端接入配置

OpenCode 是 [SST 出品](https://github.com/sst/opencode) 的开源 AI 编码 CLI，通过
`~/.config/opencode/opencode.json` 配置自定义 provider 来对接 Proxy：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "proxy-memory": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Proxy Memory (OpenCode)",
      "options": {
        "baseURL": "http://127.0.0.1:8096/opencode/default/v1",
        "apiKey": "<业务用户的 sk-mem-... user_key>"
      },
      "models": {
        "claude-opus-4.7-1m": {
          "name": "claude-opus-4.7-1m"
        }
      }
    }
  }
}
```

字段说明：
- `baseURL` — Proxy 地址 + `/opencode/<spaceId>/v1`；`default` 是 memory 实例 ID（spaceId）
- `apiKey` — 业务用户的 `user_key`（从 MemoryPanel 面板 → OpenCode 卡片复制）
- `models.<id>.name` — Proxy 上游支持的模型 ID（如 `claude-opus-4.7-1m`）
- OpenCode 使用 `@ai-sdk/openai-compatible` provider，走 **OpenAI Chat Completions** 协议

启动 OpenCode 后在 `/model` 选择器里选择 `proxy-memory` 下的模型即可。

请求路径：
- 主路径: `POST /opencode/:spaceId/v1/chat/completions`
- 裸尾变体: `POST /opencode/:spaceId/chat/completions`（`baseURL` 不带 `/v1` 时）

---

## 2. Session ID

| 优先级 | Header |
|--------|--------|
| 1 | `x-conversation-id` |
| 2 | `x-session-id` |

OpenCode 客户端本身**不携带** session ID header，proxy 会自动为每条请求生成
一个稳定 sessionId（基于 request 上下文），行为上等价于"每次会话独立"。

如果通过 wrapper / 代理层附加 `x-conversation-id`，proxy 会优先使用。

---

## 3. Session Init（会话初始化 / Form）

### 3.1 机制

OpenCode 复用 CB 的 **`ask_followup_question`** function_call 机制发起交互式 Form：

- Tool name: `ask_followup_question`
- Call ID prefix: `call_oc_session_init_`（handler 针对 opencode 使用独立前缀，与 CB `call_session_init_` / dsh `call_dsh_session_init_` 区分）
- 协议: OpenAI SSE tool_calls chunks

### 3.2 状态机

复用 CB 状态机：

```
asset_confirm → team_select → agent_task_select → initialized
```

### 3.3 分页

无数量限制，所有选项一次性展示。

### 3.4 跳过 Session Init

- `asset_confirm` 选"否" → 直接透传
- 任何步骤输入 "跳过" / "skip" → 跳过

---

## 4. Marker 路由（⚠️ 重点）

OpenCode 支持通过 URL 段追加 **marker** 来触发 cost-guard 分流或 analyse 请求分类，
用法与 CB / Codex 完全对齐：

| Marker | 路径 | 用途 |
|--------|------|------|
| （无） | `/opencode/<spaceId>/v1/chat/completions` | 默认走通用管道 |
| **cost-guard** | `/opencode/<spaceId>/cost-guard/v1/chat/completions` | 强制走 cost-guard 档位 |
| **analyse** | `/opencode/<spaceId>/analyse/v1/chat/completions` | 请求分类标记为 analyse |

裸尾变体（`baseURL` 不含 `/v1` 时）：
- `/opencode/<spaceId>/cost-guard/chat/completions`
- `/opencode/<spaceId>/analyse/chat/completions`

### 4.1 marker 门控

两条 marker 路由都受配置门控 `assetReflection.markerOptIn` 控制：
- `markerOptIn: true` → 命中并生效
- `markerOptIn: false` → 返回 `404 {"error":"cost_guard_marker_disabled"}` / 类似

见 `MemoryProxy/z_config/config.yaml` → `assetReflection.markerOptIn`。

### 4.2 客户端如何使用

在 opencode.json 的 `baseURL` 中直接切换：

```jsonc
// 默认档位
"baseURL": "http://127.0.0.1:8096/opencode/default/v1"

// 强制 cost-guard
"baseURL": "http://127.0.0.1:8096/opencode/default/cost-guard/v1"

// analyse 分类（供后台链路识别）
"baseURL": "http://127.0.0.1:8096/opencode/default/analyse/v1"
```

---

## 5. 请求分类

OpenCode 的请求分类较简单：

| 类型 | 说明 |
|------|------|
| **main** | 所有请求默认都是 main |
| **analyse** | URL 带 `/analyse/` marker 时标记为 analyse（供 report 层识别） |

OpenCode **没有** fork / sidequery / compact 等辅助请求概念。

---

## 6. 用户文本提取

OpenCode 消息体 `message.content` 是**纯字符串**（不是 content block 数组，也不做
XML 包裹）：

- 不使用 `<user_query>` 包裹（与 CB 不同）
- 不使用 content block 数组（与 CC 不同）
- 直接取最后一条 user message 的 content string

图片输入通过 `image_url` content-part 透传（客户端 base64 编码后由 proxy 直接
转发到上游），proxy 侧不做特殊处理。

---

## 7. 注入 Profile

OpenCode 共享 CB 的 handler 路径（都是 OpenAI Chat Completions），注入方式一致：

```xml
<agent_skills>...</agent_skills>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

注入点: `messages[0].content`（system message 字符串内追加）。

---

## 8. 特殊行为

- **共享 Handler**: OpenCode 复用 CB 的 `handleChatCompletions`（与 dsh 同一路径）
- **agentSource 区分**: 路由层 `/opencode/` 段 → `agentSource=opencode`
- **无独立 header 指纹**: OpenCode CLI 不带自定义 header，proxy 依赖 URL 段 + user-agent 识别
- **Marker 路由**: `/cost-guard/` 和 `/analyse/` 两条 URL marker，见 §4

---

## 9. 归档触发

- 与 CB / dsh 共享归档机制
- 对话超阈值自动 `skill/conversation/add`
- 支持 `skill/conversation/force-archive`
- 归档数据写入 L0

---

## 10. 环境变量

无 OpenCode 专属变量。上游路由由 `resolveForwardTarget` 动态决定
（通常指向 tokenhub 或直连 provider）。

---

## 11. 常见问题

**Q: OpenCode 和 CB / dsh 共享 handler，怎么区分？**  
A: 路由层面由 `/:agent/` 段区分。进入 handler 后通过 `agentSource=opencode` 触发
OpenCode 特有行为（marker 路由、session ID 自生成等）。

**Q: opencode.json 里 `baseURL` 必须带 `/v1` 吗？**  
A: 推荐带（主路径），proxy 也接受裸尾变体（不带 `/v1`）。两种都支持。

**Q: marker 路由 404 怎么办？**  
A: 检查 `MemoryProxy/z_config/config.yaml` 的 `assetReflection.markerOptIn` 是否为
`true`。改完后 `./scripts/proxy.sh restart` 加载。

**Q: OpenCode CLI 本身支持 `@image:path` 语法吗？**  
A: 这是 OpenCode 客户端侧的能力，与 proxy 无关。客户端读文件转 base64 塞进 `image_url`
content-part 后 proxy 会透明透传到上游。

**Q: 本地历史 session / skill 能导入 Memory Hub 吗？**  
A: OpenCode 客户端本地不落 skill / session 文件（与 CB / dsh 不同），目前无
`asset-import.md`。如需导入历史对话，通过 Panel 手动导入或使用 `mem:sync` 命令。

---

## 12. 与 CB / dsh 的差异

| 维度 | CodeBuddy | dsh | **OpenCode** |
|---|---|---|---|
| 协议 | OpenAI Chat Completions | OpenAI Chat Completions | **OpenAI Chat Completions** |
| 配置文件 | `~/.codebuddy/models.json` | `~/.dsh/settings.yaml` + `.credentials.yaml` | **`~/.config/opencode/opencode.json`** |
| URL 前缀 | `/codebuddy/<spaceId>` | `/dsh/<spaceId>`（不带 `/v1`） | **`/opencode/<spaceId>`** |
| Provider 库 | 内置 | 内置 | **`@ai-sdk/openai-compatible`** |
| Key 传递 | JSON `apiKey` | `.credentials.yaml` 环境变量 | **JSON `provider.*.options.apiKey`** |
| Form tool | `ask_followup_question` | `ask_user_question` | **`ask_followup_question`**（同 CB） |
| Session ID | client 带 `x-conversation-id` | client 带 `x-deepseek-harness-session-id` | **proxy 自生成** |
| Marker 路由 | 无 | 无 | **`/cost-guard/` `/analyse/`** |
| 本地资产导入 | 有 (`asset-import.md`) | 有 (`asset-import.md`) | **无**（客户端不落文件） |

---

## 13. 当前状态

- ✅ 代码实现完成（handler 复用 CB 路径）
- ✅ marker 路由（cost-guard / analyse）单测 6/6 通过
- ✅ 端到端 curl 验证通过（3 条真实上游流式响应）
- ✅ Panel 已展示 OpenCode 卡片
