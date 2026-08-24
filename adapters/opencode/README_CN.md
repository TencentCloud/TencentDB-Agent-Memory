# TencentDB Agent Memory OpenCode 适配器

本适配器无需修改 OpenCode，即可将其接入 TencentDB Agent Memory v3。每次模型请求前会
召回相关长期记忆；当 OpenCode 会话进入空闲状态时，会采集最近完成的一轮用户/助手对话。

> 状态：这是为 [issue #926](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/926)
> 开发的首版社区适配器，目前仍在评审中，尚未发布到 npm。

## 功能

- 针对每条用户消息召回 L1 原子记忆和 L3 核心记忆。
- 将有长度上限的召回结果注入系统上下文，并明确标记为不可信数据。
- 在 `session.idle` 时采集最近完成的一轮用户/助手对话。
- MemoryCore 不可用时 fail-open，不阻断正常编码会话。
- 提供原生 OpenCode 工具：
  - `tdai_memory_search`
  - `tdai_conversation_search`
  - `tdai_memory_status`
- 每次请求都携带 `team_id`、`agent_id` 和 `user_id`，满足 v3 隔离要求。

## 环境要求

- OpenCode，且 `@opencode-ai/plugin` 版本不低于 1.18.16。
- Node.js 22.16 或更高版本。
- 已运行的 TencentDB Agent Memory 服务。
- 可用的 Service ID 和 API Key。

## 从当前仓库安装

适配器发布前，请克隆本仓库，并通过 OpenCode 安装本地包：

```bash
opencode plugin "file:/path/to/TencentDB-Agent-Memory/adapters/opencode" --global
```

该命令会把本地包加入 OpenCode 的全局 `opencode.json`。等价的手动配置为：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:/path/to/TencentDB-Agent-Memory/adapters/opencode"]
}
```

请使用绝对路径，并在修改插件列表后重启 OpenCode。适配器发布后，可改用
`tencentdb-agent-memory-opencode-adapter` 包名。

## 配置

启动 OpenCode 前设置以下环境变量：

```bash
export TDAI_MEMORY_ENDPOINT="http://127.0.0.1:8420"
export TDAI_MEMORY_API_KEY="replace-me"
export TDAI_MEMORY_SERVICE_ID="memory-service"
export TDAI_MEMORY_TEAM_ID="my-team"
export TDAI_MEMORY_AGENT_ID="opencode"
export TDAI_MEMORY_USER_ID="my-user"
```

必填变量：

| 变量 | 用途 |
| --- | --- |
| `TDAI_MEMORY_API_KEY` | MemoryCore 请求使用的 Bearer Token |
| `TDAI_MEMORY_SERVICE_ID` | `x-tdai-service-id` 请求头的值 |
| `TDAI_MEMORY_TEAM_ID` | v3 团队隔离标识 |
| `TDAI_MEMORY_AGENT_ID` | v3 Agent 隔离标识，推荐使用 `opencode` |
| `TDAI_MEMORY_USER_ID` | v3 用户隔离标识 |

可选变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `TDAI_MEMORY_ENDPOINT` | `http://127.0.0.1:8420` | MemoryCore 地址 |
| `TDAI_MEMORY_TASK_ID` | 未设置 | 可选任务隔离标识 |
| `TDAI_OPENCODE_TIMEOUT_MS` | `5000` | 请求超时，范围 100-60000 毫秒 |
| `TDAI_OPENCODE_RECALL_LIMIT` | `5` | 最多召回的原子记忆数量，范围 1-20 |
| `TDAI_OPENCODE_MAX_CONTEXT_CHARS` | `8000` | 注入上下文的最大字符数 |
| `TDAI_OPENCODE_RECALL_ENABLED` | `true` | 是否启用自动召回 |
| `TDAI_OPENCODE_CAPTURE_ENABLED` | `true` | 是否采集已完成对话轮次 |
| `TDAI_OPENCODE_ALLOW_INSECURE_HTTP` | `false` | 是否允许远程明文 HTTP |

默认拒绝远程明文 HTTP，因为它会暴露 Bearer Token。远程 MemoryCore 部署应使用 HTTPS。

## 生命周期

1. `chat.message` 将最新用户文本记录为召回查询。
2. `experimental.chat.system.transform` 召回记忆，并把有界、不可信的上下文块追加到系统提示词。
3. `session.idle` 读取会话历史并采集最近完成的一轮对话。
4. 进程内内容哈希会阻止 OpenCode 重复发送 idle 事件时重复采集。

去重状态仅在当前进程内有效。如果服务端接受采集后 OpenCode 立即重启，最后一轮仍可能被重复
采集，因为 `/v3/conversation/add` 的消息 ID 由服务端生成。

跨重启的持久化幂等由 [issue #1087](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/1087)
跟踪。[PR #1142](https://github.com/TencentCloud/TencentDB-Agent-Memory/pull/1142) 提议为
`/v3/conversation/add` 增加服务端可选的 `idempotency_key`；该契约合并后，适配器再接入该能力。
在此之前，跨进程重启或分布式后端场景不保证对话采集严格只写入一次。

## 安全行为

- 召回内容属于数据，而不是指令；存储内容中的边界标记会被转义。
- 召回结果进入模型上下文前会受到长度限制。
- 凭据只从环境变量读取，不会写入 OpenCode 消息。
- Hook 失败会通过 `client.app.log` 记录，但不会阻断编码会话。
- 适配器不会记录提示词、回复、API Key 或召回记忆正文。

## 开发

```bash
cd adapters/opencode
npm install
npm run check
npm run pack:check
```

测试覆盖配置校验、提示词边界转义、召回注入、已完成轮次采集、重复 idle 事件以及原生工具注册。
