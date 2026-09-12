# ZCode

> agentSource: `zcode` | 协议: Anthropic Messages | Handler: `anthropicHandler.ts` (与 Claude Code 共享)

---

## 1. 客户端接入配置

ZCode（智谱出品的 AI 编码 CLI / 桌面端）的模型 provider 原生走 **Anthropic
Messages 协议**（内置 provider 的 `kind` 均为 `anthropic`，baseURL 形如
`https://open.bigmodel.cn/api/anthropic`），接入方式与 Claude Code 一致：
在 ZCode 设置的模型 provider 中新增一个自定义 provider，把 baseURL 指向
Proxy 即可。对应 `~/.zcode/v2/config.json` 中的目标状态：

```json
{
  "provider": {
    "proxy-memory": {
      "name": "Proxy Memory (ZCode)",
      "kind": "anthropic",
      "source": "custom",
      "enabled": true,
      "options": {
        "baseURL": "http://127.0.0.1:8096/zcode/default",
        "apiKey": "<业务用户的 sk-mem-... user_key>"
      },
      "models": {
        "GLM-5.3": { "name": "GLM-5.3" }
      }
    }
  }
}
```

字段说明：
- `baseURL` — Proxy 地址 + `/zcode/<spaceId>`；`default` 是 memory 实例 ID
  （spaceId），客户端会自动拼接 `/v1/messages`
- `apiKey` — 业务用户的 `user_key`
- `models.<id>` — Proxy 上游支持的模型 ID

请求路径：
- 主路径: `POST /zcode/:spaceId/v1/messages`
- 兼容变体: `POST /zcode/:spaceId/cost-guard/v1/messages`、
  `POST /zcode/:spaceId/analyse/v1/messages`（marker 语义与其他 agent 一致）

---

## 2. 当前支持范围

ZCode 与 Claude Code 同协议，proxy 侧当前按**保守策略**接入（本分支已通过
本地 E2E 验证：路由 → 鉴权 → 上游转发（含 SSE 流式）→ 注入 → L0 落库）：

| 能力 | 状态 |
| --- | --- |
| L0 记忆写入 / 共享召回 | ✅ 已验证（需会话身份，见下） |
| Skill buffer / `mem:` 命令 | ✅ 通用链路（用户文本提取走 default 规则） |
| 记忆注入 | ✅ 已验证（粗粒度锚点兜底，未注册精确 Profile） |
| 请求分类（main / fork / sidequery） | ➖ 恒按 main 处理 |
| 交互式 session-init 表单 | ✅ 共享 CC 状态机可用（`ask_followup_question` 工具块下发；ZCode 未内建该工具，实际以 header 预选为主） |

会话身份说明：ZCode 不携带 `x-session-id` 等 session header，裸接入时
conversationId 为空，注入 / L0 / session-init 均不激活（等价纯转发）。接入层
（wrapper / 启动器）需要附带以下 header：

- `x-session-id` — 会话隔离（必填，否则记忆链路不工作）
- `x-team-id` / `x-agent-id` — 团队与 Agent 预选（可选，跳过交互表单）

拿到 ZCode 真实请求抓包后，参考 `claude-code.ts`（adapter 特化）与
`injection/agents/pi/`（注入 Profile）补齐精确行为。
