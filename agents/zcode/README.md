# ZCode

支持 Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses。
前两种协议已用 ZCode CLI 0.16.5 实测；Responses 的验证范围见下文。
客户端原生发送每会话独立的 `x-session-id`，无需 wrapper。

## 接入

CLI 配置 `~/.zcode/cli/config.json`（桌面端为 `~/.zcode/v2/config.json`）：

```json
{
  "model": "memory/deepseek-v4-flash",
  "provider": {
    "memory": {
      "kind": "anthropic",
      "options": {
        "baseURL": "http://127.0.0.1:8096/zcode/default",
        "apiKey": "<业务用户 sk-mem-... user_key>"
      },
      "headers": { "x-team-id": "<team-id>", "x-agent-id": "<agent-id>" },
      "models": { "deepseek-v4-flash": { "name": "deepseek-v4-flash" } }
    }
  }
}
```

替换 Proxy 地址、实例 ID（示例为 `default`）、模型和身份。
`headers` 可省略以进入 `AskUserQuestion` 初始化；`x-task-id` 可选。
Anthropic 客户端追加 `/v1/messages`；改为 `kind: "openai-compatible"`
则追加 `/chat/completions`；`kind: "openai"` 使用 Responses API，追加
`/responses`。三者 baseURL 均可使用 `http://127.0.0.1:8096/zcode/default`。
Responses 同时接受带 `/v1` 的路径，以及 `/responses/compact` 辅助请求。

不同协议可分别配置 Proxy 上游（`openai` 对应 Chat Completions，
`responses` 对应 Responses，避免误用仅支持聊天接口的上游）：

```yaml
upstream:
  agents:
    zcode:
      anthropic: { url: "https://<host>/anthropic/v1", apiKey: "<模型密钥>" }
      openai: { url: "https://<host>/v1", apiKey: "<模型密钥>" }
      responses: { url: "https://<responses-host>/v1", apiKey: "<模型密钥>" }
```

协议条目优先于扁平 `url/apiKey`；无匹配条目时使用默认上游。
有条目但不配 `apiKey` 时透传客户端凭证，不继承全局密钥。

## 验证范围

真实 CLI 已验证双协议聊天、预选注册、L0 写入、`mem:sync`、任务创建及
通过注入的 memory-bridge 工具跨会话检索。L1 抽取需要 MemoryCore 模型可用。
双协议表单回填有回归测试；桌面点选、压缩和子代理尚未实测，请求暂按 `main` 处理。

Responses 自动化回归覆盖真实 Proxy 路由、ZCode `x-session-id`、
`AskUserQuestion` 表单往返、流式/非流式返回、记忆注入、L0 归档调用、
`mem:sync` / `mem:session-reset`、压缩透传及上游凭据隔离。
测试模拟了模型和 MemoryCore 服务，尚未完成真实 ZCode Responses 模型/桌面验收。
Responses 复用现有 handler，不包含 cost-guard 模型分流。
