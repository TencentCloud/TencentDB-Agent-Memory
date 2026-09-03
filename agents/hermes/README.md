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
    # x-task-id: <可选：从面板获取的 task_id>
```

字段说明：
- `base_url` — Proxy 地址 + `/hermes/<spaceId>`；`default` 是 memory 实例 ID
- `api_key` — 业务用户的 `user_key`（从面板获取）
- `x-team-id` / `x-agent-id` — 必填，从面板对应页面获取
- `x-task-id` — 可选；不传时仅使用 Agent 级资产
- `x-conversation-id` — 可选；Proxy 默认按 API key 自动生成并续接

请求路径：`POST /hermes/:spaceId/v1/chat/completions`

---

## 2. Session ID

| 来源 | Header |
|------|--------|
| 显式配置（优先） | `x-conversation-id` |
| 自动兜底 | 按 API key 管理活跃会话，默认空闲 30 分钟过期 |

Hermes 无需再静态配置 session ID。若需要多窗口精确隔离，可显式传 ID，或把 Proxy 配为 `strategy: per-key-msg`。

---

## 3. Session Init（会话初始化）

### ⚠️ 核心差异：纯 Header 预选，无交互 Form

Hermes **不支持交互式表单**（客户端无法响应 proxy 返回的 function_call）。  
Session 注册完全依赖请求中携带的 Header：

| Header | 说明 | 必填 |
|--------|------|------|
| `x-team-id` | 团队 ID | ✅ |
| `x-agent-id` | Agent ID | ✅ |
| `x-task-id` | Task ID | ❌ |
| `x-conversation-id` | 会话标识 | ❌ |

**处理逻辑**：
- team + agent 有效 → 直接注册；Task 可选
- 缺 team/agent 或显式 Task 无效 → bypass，不会静默忽略或回退交互表单
- `onMismatch: form` 对 Hermes 自动降级为 bypass，因为客户端没有表单能力
- tool call 后续请求丢失 extra headers → Proxy 按 API key 续接活跃 Session

### 无 Plan Mode / Default Mode

Hermes 不涉及 Plan/Default mode 概念。要么 header 齐全走完整链路，要么 bypass。

---

## 4. 请求分类

所有请求均为 **main**。Hermes 没有 auxiliary 请求概念。

---

## 5. 注入 Profile

与 CB 相同——XML 结构注入到 `messages[0].content`（system message）。

---

## 6. 多窗口与多副本

`per-key` 是单活跃会话，适合单窗口 Hermes；多窗口可使用 `per-key-msg` 或显式 conversation ID。Proxy 自动映射当前保存在进程内，多副本部署应使用粘性路由。

---

## 7. 常见问题

**Q: 记忆注入没生效？**  
A: 检查 `x-team-id`、`x-agent-id` 是否正确，以及 Proxy `sessionInit`、`injection` 是否开启。显式 ID 无效会按 `onMismatch` 处理。

**Q: 怎么获取 team_id / agent_id / task_id？**  
A: 登录面板 → 对应页面 → 详情里有 ID 字段。或用面板 API `team/list`、`agent/list`、`task/list` 查询。

**Q: 不想绑 Task 怎么办？**  
A: 省略 `x-task-id`，并使用默认 `sessionInit.taskMissingPolicy: skip`。
