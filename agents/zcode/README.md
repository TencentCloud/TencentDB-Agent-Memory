# ZCode

> agentSource: `zcode` | 协议: Anthropic Messages（原生）+ OpenAI Chat Completions（可选）| Handler: `anthropicHandler.ts` / `handler.ts`

---

## 1. 客户端接入配置

ZCode（智谱出品的 AI 编码 CLI / 桌面端）的模型 provider 原生走 **Anthropic
Messages 协议**（provider `kind` 为 `anthropic`，baseURL 形如
`https://open.bigmodel.cn/api/anthropic`），接入方式与 Claude Code 一致：
在 provider 配置里把 baseURL 指向 Proxy 即可。CLI 的落盘位置是
`~/.zcode/cli/config.json`（桌面端为 `~/.zcode/v2/config.json`）：

```json
{
  "model": "proxy-ds/deepseek-v4-flash",
  "provider": {
    "proxy-ds": {
      "name": "Proxy Memory (ZCode)",
      "kind": "anthropic",
      "options": {
        "baseURL": "http://127.0.0.1:8096/zcode/default",
        "apiKey": "<业务用户的 sk-mem-... user_key>"
      },
      "headers": {
        "x-team-id": "<team-id>",
        "x-agent-id": "<agent-id>"
      },
      "models": {
        "deepseek-v4-flash": { "name": "deepseek-v4-flash" }
      }
    }
  }
}
```

字段说明：
- `baseURL` — Proxy 地址 + `/zcode/<spaceId>`；`default` 是 memory 实例 ID
  （spaceId），客户端会自动拼接 `/v1/messages`
- `apiKey` — 业务用户的 `user_key`
- `headers` — **provider 原生支持自定义 header**（CLI/桌面端同 schema），团队
  与 Agent 预选直接在这里配；`x-session-id` 不需要配（见下）
- `models.<id>` — Proxy 上游支持的模型 ID

**会话身份（无需 wrapper）**：ZCode 原生随每个会话携带动态 `x-session-id`
（UUID，与 `metadata.user_id` 内嵌 session_id 一致），proxy 侧记忆链路直接
激活。团队/Agent 未预选时首轮会收到 session-init 表单——ZCode 原生含
`AskUserQuestion` 工具，表单链路可应答（实测走预选 header 更稳）。

**OpenAI 协议（可选）**：provider `kind` 改为 `openai-compatible` 即走
`POST /zcode/<spaceId>/chat/completions`（客户端不拼 `/v1`）。此路径需要部署
侧在 `upstream.agents.zcode` 里给两种协议分别指上游（协议感知覆盖，其他
agent 的扁平写法不受影响）：

```yaml
upstream:
  agents:
    zcode:
      anthropic:
        url: "https://<anthropic-协议上游>"
        apiKey: "<key>"
      openai:
        url: "https://<openai-协议上游>"
        apiKey: "<key>"
```

只配其中一种协议时，另一种协议的请求回落到全局 `upstream.url`。

---

## 2. 实测支持范围（2026-09-13 双协议真机抓包）

| 能力 | 状态 |
| --- | --- |
| L0 记忆写入 / 共享召回 | ✅ 已验证（原生 `x-session-id` 激活会话身份） |
| Skill buffer / `mem:` 命令 | ✅ 用户文本提取：anthropic 格式取最后一个 text block（跳过 `<system-reminder>`），openai 格式裸字符串直返 |
| 记忆注入 | ✅ 走粗粒度锚点兜底（未注册精确 Profile，结构近 CC，值得后续做） |
| 请求分类（main / fork / sidequery） | ➖ 恒按 main；私有头 `x-zcode-session-type` 唯一实测值 "main"，未捕获 aux 信号 |
| 交互式 session-init 表单 | ✅ 双协议已适配：anthropic 走 CC 状态机（原生 `AskUserQuestion` tool_use + JSON tool_result 回填）；openai 复用 CB 状态机 + `AskUserQuestion` OpenAI SSE 外层重渲染（同 workbuddy 模式），不再下发 ZCode 没有的 `ask_followup_question` |
| 双协议 | ✅ anthropic + openai-compatible 均实测通过（openai 需上游覆盖） |

拿到更多真实流量（尤其 `x-zcode-session-type` 的其他取值）后，参考
`claude-code.ts`（请求分类）与 `injection/agents/pi/`（注入 Profile）补齐。
