# Cursor 通过自定义端点接入现有 MemoryProxy 的方案

## 文档状态与待验证假设

本文是接入方案与验证计划，不包含运行时代码。

核心待验证假设是：具备相应权限的 Cursor 账号可以配置 OpenAI-compatible 自定义端点、Base URL 和 API Key。该能力是否仅限 Cursor Pro、是否也向其他套餐开放，或是否受账号灰度权限影响，需要使用真实账号验证后才能确定，本文不预先将其作为 Free/Pro 的既定分层结论。

## 方案范围

现有 MemoryProxy 已为 Claude Code、Codex、CodeBuddy 等客户端实现鉴权、会话注册、身份隔离、记忆注入、模型供应商转发、流式响应和会话记录。本文不重新设计这些网关能力。

Cursor 侧真正需要完成的是：

1. 记录如何将 Cursor 的 OpenAI-compatible 自定义端点指向现有 MemoryProxy；
2. 确认 Cursor 如何提供 MemoryProxy 所需的身份请求头和稳定会话标识；
3. 验证 Cursor 的请求、响应、流式传输及多供应商兼容性；
4. 用中英文记录经过实测的配置和结果。

## 与 Hooks + MCP 适配器的关系

PR [#1138](https://github.com/TencentCloud/TencentDB-Agent-Memory/pull/1138) 提交了 Cursor Hooks + MCP 适配方案。该方案可以采集对话并提供显式的记忆召回和搜索，但不会让模型请求经过 MemoryProxy；记忆召回依赖 Agent 主动调用 MCP 工具。

本文是 #1138 的配套文档，不替代 #1138。若 #1138 合并，Hooks + MCP 仍作为 Cursor Free/Auto 的可用路径；自定义端点 Proxy 路由仅作为账号具备该能力时的可选扩展。任何 Proxy 专用运行时代码都必须独立开发、独立评审，不能混入 #1138 的适配器代码。

## 基于现有 Proxy 的建议配置

用户需要在 Cursor 中配置：

- Base URL：`http://<proxy-host>:<port>/<agent-source>/<spaceId>`；
- API Key：TencentDB 业务用户的 `user_key`；
- 已配置上游供应商支持的模型名称。

MemoryProxy 收到 OpenAI-compatible 请求后，沿用现有能力完成鉴权和会话流程、召回并注入记忆、转发到模型供应商、向 Cursor 回传响应或流，并记录完整会话。

当前通用 Proxy 契约还要求 `x-team-id`、`x-agent-id`、`x-task-id` 和 `x-conversation-id`。关键验证项是 Cursor 能否附加这些自定义请求头。如果不能，需要验证 MemoryProxy 现有的交互式/默认 Task 流程是否足够，或者是否需要单独评审一个很小的 Cursor 专用适配层。

当前 `<agent-source>` 支持列表中还没有 `cursor`。初步测试可以使用文档允许的兼容 source 验证协议，但正式支持应单独增加并评审 Cursor source，不应长期伪装成其他客户端。

## 身份与轮次映射

建议验证以下字段来源：

| MemoryProxy 字段 | 待验证来源 |
| --- | --- |
| `user_key` | Cursor 自定义端点 API Key，以 `Authorization: Bearer ...` 发送 |
| `team_id` | 从 TencentDB 管理面板取得并配置为 `x-team-id` |
| `agent_id` | 从 TencentDB 管理面板取得并配置为 `x-agent-id` |
| `task_id` | 从 TencentDB 管理面板取得并配置为 `x-task-id`，不是每轮 generation ID |
| `session_id` | Cursor `conversation_id`；如果 Cursor 支持，则作为 `x-conversation-id` 转发 |
| 单轮配对 | 沿用 #1138 的 Cursor `generation_id`，不能替代稳定的 session ID |

主要未知点是 Cursor 是否会在自定义端点请求中暴露 `conversation_id` 和 `generation_id`，以及是否允许通过请求头或 body metadata 转发。如果不能，Proxy 路径需要给出明确的回退方案，且不能混淆 Task、Session 和单轮 Generation。

## 用户可感知行为与取舍

- #1138 的 Hooks 路径为 fail-open：记忆服务故障不会阻塞 Cursor 原有模型调用。
- Proxy 路径天然为 fail-closed：MemoryProxy 不可用时，经其路由的模型请求会失败。
- 模型流量经过 MemoryProxy，意味着完整提示词、选中的代码/上下文、工具数据和响应都会经过所配置的网关。接入前必须向用户说明该数据流，并确认网关的隐私、访问控制、日志和数据保留策略。

## 验证计划与结果

目前不声明任何运行时验证结果。以下矩阵需要在真实测试后补充账号套餐/权限、Cursor 版本、Proxy 版本、供应商、模型、实际结果和证据：

- [ ] 确认哪些 Cursor 套餐/账号开放 OpenAI-compatible 自定义 Base URL。
- [ ] 确认 Base URL 路径拼接及 Cursor 是否正确追加 `/v1/chat/completions`。
- [ ] 验证非流式请求和响应 schema。
- [ ] 验证流式请求、响应 schema 和流结束行为。
- [ ] 验证 `Authorization` 及所需自定义身份请求头。
- [ ] 验证 tool-call 字段及多步工具调用。
- [ ] 验证 reasoning-content 和 usage 字段不会丢失或触发 schema 错误。
- [ ] 验证 `conversation_id` 和 `generation_id` 是否可获取且稳定。
- [ ] 验证重试、超时、取消、断连和上游错误传递。
- [ ] 验证多个模型供应商及供应商特定参数。
- [ ] 记录 Cursor 对自定义端点、模型、证书或路由的其他限制。
- [ ] 确认 MemoryProxy 的会话注册、记忆注入、响应回传和会话落库。

本文供评审与后续迭代实现参考。本人目前没有具备所需自定义端点权限的账号，无法完成上述本地端到端实测。
