# OpenClaw

> agentSource: `openclaw` | 协议: OpenAI Chat Completions | Session Init: Header 预选（无交互 Form）
>
> 本地历史导入 Memory Hub：见 [资产导入手册](./asset-import.md)。

---

## 1. 客户端接入配置

推荐使用 [Memory Proxy Bridge 插件](../../MemoryProxy/openclaw-provider-bridge/README_CN.md)。插件注册 Provider，并按 OpenClaw Agent/Session 动态附加身份 header；不再需要静态维护 Task 和 Conversation ID。

```bash
export MEMORY_PROXY_URL="http://<proxy-host>:8096"
export MEMORY_PROXY_INSTANCE_ID="<spaceId>"
export MEMORY_PROXY_API_KEY="<业务用户的 sk-mem-... user_key>"
export OPENCLAW_AGENT_ID="main"
export TDAI_TEAM_ID="<team_id>"
export TDAI_AGENT_ID="<agent_id>"
export MEMORY_PROXY_MODEL_ID="glm-5.2"
bash MemoryProxy/scripts/install-openclaw-provider-bridge.sh
```

旧版静态配置仍兼容。若暂不安装插件，可在 `~/.openclaw/openclaw.json` 的 `models.providers` 段配置：

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
          "x-agent-id": "<从面板获取的 agent_id>"
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
- `headers` — 只需 `x-team-id`、`x-agent-id`；Task 与 Conversation 均可省略
- `models[].id` — 必须与 Proxy 上游配置的模型 ID 匹配
- `allowPrivateNetwork: true` — 允许访问内网地址

请求路径：`POST /openclaw/:spaceId/v1/chat/completions`

---

## 2. Session ID

| 来源 | Header |
|------|--------|
| 插件（推荐） | OpenClaw `sessionId`，每个窗口自动独立，并在每轮动态发送 |
| Proxy 兜底 | 未传任何 session header 时按 API key 自动生成并续接，默认 30 分钟 TTL |
| 旧配置 | 显式 `x-conversation-id` 原样优先 |

插件无需用户手动更换 ID。未安装插件时，Proxy 的 `autoConversationId` 仍能为单窗口场景兜底。

---

## 3. Session Init（会话初始化）

### ⚠️ 核心差异：纯 Header 预选，无交互 Form

OpenClaw 与 Hermes 完全相同 —— **不支持交互式表单**，Session 注册依赖 Header：

| Header | 说明 | 必填 |
|--------|------|------|
| `x-team-id` | 团队 ID | ✅ |
| `x-agent-id` | Agent ID | ✅ |
| `x-task-id` | Task ID | ❌；不传时仅使用 Agent 级资产 |
| `x-conversation-id` | 会话标识 | ❌；插件或 Proxy 自动管理 |

**处理逻辑**：
- team + agent 都有效 → 直接注册；Task 可选
- 缺 team/agent 或显式 Task 无效 → bypass，不会静默忽略或回退交互表单
- `onMismatch: form` 对 OpenClaw 自动降级为 bypass，因为客户端没有表单能力
- 插件在 tool call 后续请求上继续附加 header，避免回流断档

HTTP 层由通用 `/:agent/:spaceId/v1/chat/completions` 路由保留 `agentSource=openclaw`；Session 层再由 `session/header-only` 独立分流，不进入 CodeBuddy/Claude Code 状态机。

---

## 4. 请求分类

所有请求均为 **main**。OpenClaw 没有 auxiliary 请求概念。

---

## 5. 注入 Profile

与 CB 相同——XML 结构注入到 `messages[0].content`（system message）。

---

## 6. 多副本说明

插件每轮都发显式 OpenClaw Session ID，因此可跨 Proxy 副本。仅依赖 Proxy `autoConversationId` 的无 header 客户端，应使用粘性路由；自动映射当前是进程内 TTL/LRU 状态。

---

## 7. 常见问题

**Q: 和 Hermes 有什么区别？**  
A: 对 proxy 来说行为完全相同（都是 header 预选 + OpenAI Chat）。区别仅在客户端配置文件格式（YAML vs JSON）和 agentSource 标记不同。

**Q: models 里 cost 填 0 可以吗？**  
A: 可以。OpenClaw 用 cost 做客户端侧预算计算，走 proxy 时实际计费在上游，客户端侧填 0 不影响功能。

**Q: `allowPrivateNetwork: true` 是什么？**  
A: OpenClaw 默认禁止请求内网地址（安全策略）。加这个配置才能访问 `127.0.0.1` 或内网 IP 上的 proxy。
