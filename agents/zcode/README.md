# ZCode

ZCode CLI 0.16.5 已验证 Anthropic 和 OpenAI-compatible 两种协议。
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
则追加 `/chat/completions`，两者 baseURL 均不带 `/v1`。

同时使用两种协议时，可分别配置 Proxy 上游：

```yaml
upstream:
  agents:
    zcode:
      anthropic: { url: "https://<host>/anthropic/v1", apiKey: "<模型密钥>" }
      openai: { url: "https://<host>/v1", apiKey: "<模型密钥>" }
```

协议条目优先于扁平 `url/apiKey`；无匹配条目时使用默认上游。
有条目但不配 `apiKey` 时透传客户端凭证，不继承全局密钥。

## 验证范围

真实 CLI 已验证双协议聊天、预选注册、L0 写入、`mem:sync`、任务创建及
通过注入的 memory-bridge 工具跨会话检索。L1 抽取需要 MemoryCore 模型可用。
双协议表单回填有回归测试；桌面点选、压缩和子代理尚未实测，请求暂按 `main` 处理。
