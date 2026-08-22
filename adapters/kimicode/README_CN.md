# TencentDB Agent Memory × Kimi Code CLI

本目录提供 Kimi Code CLI 的配置型适配示例。Kimi Code CLI 官方支持 OpenAI Chat Completions 兼容 Provider，因此可以通过 TencentDB MemoryProxy 接入长期记忆，不需要修改 Kimi Code 源码，也不需要安装插件。

## 配置

编辑 `~/.kimi/config.toml`：

```toml
[providers.tencentdb-memory]
type = "openai_legacy"
base_url = "http://127.0.0.1:8096/codebuddy/default"
api_key = "sk-tdai-replace-me"
custom_headers = { "x-team-id" = "team-replace-me", "x-agent-id" = "agent-replace-me", "x-task-id" = "task-replace-me", "x-conversation-id" = "conversation-replace-me" }

[models.deepseek-v4-flash]
provider = "tencentdb-memory"
model = "deepseek-v4-flash"
capabilities = ["thinking"]
```

将占位值替换为本地 TencentDB 用户 Key，或使用当前 Kimi Code 安装支持的凭证管理方式。不要提交真实密钥。上游 DeepSeek/OpenAI 等模型的 API Key 应只保存在 MemoryProxy 服务端。

`default` 是本地部署使用的 MemoryProxy memory instance/space ID。生产环境请替换为实际实例 ID。

模型名必须与 MemoryProxy 的 `PROXY_UPSTREAM_MODEL` 一致。本示例使用现有 OpenAI-compatible 路由；如果后续 Proxy 增加专用 `/kimicode/<spaceId>` 路由，只需修改 `base_url`。

`custom_headers` 遵循 TencentDB 对 Hermes/OpenClaw 等通用 OpenAI 客户端的接入约定：

- `x-team-id`：Team ID；
- `x-agent-id`：Agent ID；
- `x-task-id`：Task ID（当前版本必填）；
- `x-conversation-id`：当前会话标识。新建会话时生成一个新的值，继续同一会话时保持不变。

这些值不应写成全局固定业务资产；实际使用时由启动脚本、工作区配置或客户端包装层按会话注入。Kimi Code 当前版本没有把内部 session ID 自动转换为 TencentDB header，因此本适配采用官方通用客户端的显式 header 方式。

## 能力

首次请求经过 MemoryProxy 时，可以按代理配置完成 Team、Agent、Task 绑定；后续请求使用绑定的记忆上下文，完成的对话按 Proxy 配置回写 MemoryCore。

本适配只提供 Kimi Code 平台配置和文档，不重复实现已有的 MCP/Gateway 公共客户端层。

## 限制

- 必须先启动 TencentDB MemoryProxy 和 MemoryCore Gateway。
- Kimi Code CLI 必须通过该 Provider 发送 OpenAI Chat Completions 请求。
- Kimi Code 和 MemoryProxy 两侧的模型名称必须一致。
- Kimi Code 平台专属的搜索/抓取服务不会由 TencentDB 上游自动提供，需要单独配置或使用本地回退。
- Kimi Code 当前不会自动转发内部 session ID；必须通过 `custom_headers.x-conversation-id` 提供会话标识。
- 本目录不包含完整会话的额外存储，也不修改 Kimi Code、TencentDB Core 或 MemoryProxy 源码。

## 验证步骤

1. 启动 MemoryCore 和 MemoryProxy。
2. 准备一个能访问 Team 和 Agent 的 TencentDB 用户 Key。
3. 将 TencentDB user key、Team/Agent/Task ID 写入 `custom_headers`，为当前会话生成唯一 `x-conversation-id`。
4. 启动 Kimi Code CLI 并发送一条消息，确认流式响应正常。
5. 在 MemoryCore Chat Memory 中确认该会话回写内容。
6. 新建会话时只更换 `x-conversation-id`；切换任务时同步更换 Team/Agent/Task headers。

## 本地验证结果

本适配已在 Windows 本地完成端到端验证：

| 检查项 | 结果 |
|---|---|
| Kimi Code 配置解析 | 通过（`kimi doctor config`） |
| `openai_legacy` 请求构造 | 通过 |
| MemoryProxy OpenAI-compatible 路由 | 通过（HTTP 200） |
| DeepSeek 上游转发 | 通过（返回测试响应） |
| TencentDB session 初始化 | 通过 |
| Team/Agent/Task 绑定 | 通过（`default-team` / Kimi Code / Memory Write Test） |
| TencentDB L0 回流 | 通过（`tdai-recorder:write-l0`） |

配置示例 TOML 通过 Python `tomllib` 解析校验。测试使用的 API Key、user key 和本地部署文件均未加入仓库。

## 与 MCP 适配的关系

仓库中已有 Kimi Code MCP 适配讨论。本示例走的是 Kimi Code 官方 `openai_legacy` Provider + MemoryProxy 路线，重点是配置级、透明的模型 API 接入；公共 MCP/Gateway 客户端能力不在此目录重复实现。
