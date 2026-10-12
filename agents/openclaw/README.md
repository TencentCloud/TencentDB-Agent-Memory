# OpenClaw

> agentSource: `openclaw` | 协议: OpenAI Chat Completions | Session Init: Header 预选（无交互 Form）
>
> 本地历史导入 Memory Hub：见 [资产导入手册](./asset-import.md)。

---

## 1. 客户端接入配置

OpenClaw 通过**配置文件** `~/.openclaw/openclaw.json` 的 `models.providers` 段配置：

```jsonc
{
  "models": {
    "mode": "merge",
    "providers": {
      "memory-proxy": {
        "baseUrl": "http://<proxy-host>:8096/openclaw/<spaceId>",
        "apiKey": "<业务用户的 sk-mem-... user_key>",
        "api": "openai-completions",
        "headers": {
          "x-team-id": "<从面板获取的 team_id>",
          "x-agent-id": "<从面板获取的 agent_id>",
          "x-task-id": "<从面板获取的 task_id>",
          "x-conversation-id": "<自定义的会话标识>"
        },
        "request": {
          "allowPrivateNetwork": true
        },
        "models": [
          {
            "id": "gpt-5.5",
            "name": "GPT-5.5",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 128000,
            "maxTokens": 32000,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
          }
        ]
      }
    }
  }
}
```

字段说明：
- `baseUrl` — Proxy 地址 + `/openclaw/<spaceId>`；`default` 是 memory 实例 ID
- `apiKey` — 业务用户的 `user_key`（从面板获取）
- `api` — 必须为 `"openai-completions"`
- `headers` — 必须包含 `x-team-id`、`x-agent-id`、`x-task-id`、`x-conversation-id`
- `models[].id` — 必须与 Proxy 上游配置的模型 ID 匹配
- `allowPrivateNetwork: true` — 允许访问内网地址

请求路径：`POST /openclaw/:spaceId/v1/chat/completions`

---

## 2. Session ID

| 来源 | Header |
|------|--------|
| 唯一 | `x-conversation-id`（用户在配置文件中静态指定） |

与 Hermes 相同，OpenClaw 不自动管理 session ID，需手动更换。

---

## 3. Session Init（会话初始化）

### ⚠️ 核心差异：纯 Header 预选，无交互 Form

OpenClaw 与 Hermes 完全相同 —— **不支持交互式表单**，Session 注册依赖 Header：

| Header | 说明 | 必填 |
|--------|------|------|
| `x-team-id` | 团队 ID | ✅ |
| `x-agent-id` | Agent ID | ✅ |
| `x-task-id` | Task ID | ✅（当前版本） |
| `x-conversation-id` | 会话标识 | ✅ |

**处理逻辑**：
- 四个 header 都存在且 valid → 直接注册 session，注入资产
- 任一缺失 → session bypass（透传，不注入）

---

## 4. 请求分类

所有请求均为 **main**。OpenClaw 没有 auxiliary 请求概念。

---

## 5. 注入 Profile

与 CB 相同——XML 结构注入到 `messages[0].content`（system message）。

---

## 6. 已知限制

与 Hermes 完全相同：

### `x-task-id` 当前必填

缺少时 session bypass，记忆注入不生效。  
解决：proxy 配 `sessionInit.defaultTaskId: "no-task"` 后填固定值。

### `x-conversation-id` 需手动管理

- 同 ID 共享 session；新对话需手动换值
- 部分 tool call 后续轮次可能不携带 headers → 那些轮次跳过注入

---

## 7. 常见问题

**Q: 和 Hermes 有什么区别？**  
A: 对 proxy 来说行为完全相同（都是 header 预选 + OpenAI Chat）。区别仅在客户端配置文件格式（YAML vs JSON）和 agentSource 标记不同。

**Q: models 里 cost 填 0 可以吗？**  
A: 可以。OpenClaw 用 cost 做客户端侧预算计算，走 proxy 时实际计费在上游，客户端侧填 0 不影响功能。

**Q: `allowPrivateNetwork: true` 是什么？**  
A: OpenClaw 默认禁止请求内网地址（安全策略）。加这个配置才能访问 `127.0.0.1` 或内网 IP 上的 proxy。
