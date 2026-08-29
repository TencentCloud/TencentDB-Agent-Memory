# Hermes

> agentSource: `hermes` | 协议: OpenAI Chat Completions | Session Init: Header 预选（无交互 Form）
>
> 本地历史导入 Memory Hub：见 [资产导入手册](./asset-import.md)。

---

## 1. 客户端接入配置

Hermes 通过**配置文件** `~/.hermes/config.yaml` 配置：

```yaml
model:
  default: gpt-5.5
  provider: custom
  base_url: http://<proxy-host>:8096/hermes/<spaceId>
  api_key: <业务用户的 sk-mem-... user_key>
  extra_headers:
    x-team-id: <从面板获取的 team_id>
    x-agent-id: <从面板获取的 agent_id>
    x-task-id: <从面板获取的 task_id>
    x-conversation-id: <自定义的会话标识>
```

字段说明：
- `base_url` — Proxy 地址 + `/hermes/<spaceId>`；`default` 是 memory 实例 ID
- `api_key` — 业务用户的 `user_key`（从面板获取）
- `x-team-id` / `x-agent-id` / `x-task-id` — 从面板对应页面获取
- `x-conversation-id` — 用户自定义会话标识（见下方 §6 已知限制）

请求路径：`POST /hermes/:spaceId/v1/chat/completions`

---

## 2. Session ID

| 来源 | Header |
|------|--------|
| 唯一 | `x-conversation-id`（用户在配置文件中静态指定） |

⚠️ Hermes 不自动管理 session ID，需要用户每次新对话手动更换 `x-conversation-id`。

---

## 3. Session Init（会话初始化）

### ⚠️ 核心差异：纯 Header 预选，无交互 Form

Hermes **不支持交互式表单**（客户端无法响应 proxy 返回的 function_call）。  
Session 注册完全依赖请求中携带的 Header：

| Header | 说明 | 必填 |
|--------|------|------|
| `x-team-id` | 团队 ID | ✅ |
| `x-agent-id` | Agent ID | ✅ |
| `x-task-id` | Task ID | ✅（当前版本） |
| `x-conversation-id` | 会话标识 | ✅ |

**处理逻辑**：
- 四个 header 都存在且 valid → 直接注册 session，注入资产
- 任一缺失 → session bypass（透传，不注入）

### 无 Plan Mode / Default Mode

Hermes 不涉及 Plan/Default mode 概念。要么 header 齐全走完整链路，要么 bypass。

---

## 4. 请求分类

所有请求均为 **main**。Hermes 没有 auxiliary 请求概念。

---

## 5. 注入 Profile

与 CB 相同——XML 结构注入到 `messages[0].content`（system message）。

---

## 6. 已知限制

### `x-task-id` 当前必填

Proxy 的 header 预选机制要求三 ID 齐全才能完成 session 注册。缺少 `x-task-id` 时 proxy 尝试弹 form，但 Hermes 无法响应 → session bypass → 记忆注入不生效。

**影响**：
- 用户需预先在面板创建 Task 并获取 task_id
- 切换任务需手动改配置文件

### `x-conversation-id` 需手动管理

- 同一个 conversation ID 的所有请求共享同一个 session
- 每次新对话需手动更换（否则沿用上次 session 状态）
- 部分客户端 tool call 后续请求可能不携带 extra headers → 那些轮次跳过注入

---

## 7. 常见问题

**Q: 记忆注入没生效？**  
A: 检查 `extra_headers` 四个值是否都填了且正确。任一缺失/错误都会导致 session bypass。

**Q: 怎么获取 team_id / agent_id / task_id？**  
A: 登录面板 → 对应页面 → 详情里有 ID 字段。或用面板 API `team/list`、`agent/list`、`task/list` 查询。

**Q: 不想绑 Task 怎么办？**  
A: 当前版本必填。可在 proxy `config.yaml` 配置 `sessionInit.defaultTaskId: "no-task"` 后使用该固定值。
