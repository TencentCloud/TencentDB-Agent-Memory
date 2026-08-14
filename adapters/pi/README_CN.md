# TencentDB Agent Memory — Pi 适配器

一个原生 [Pi](https://pi.dev/) 扩展，为任意 Pi 编码代理提供基于 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) v3 的持久长期记忆。在每次运行前召回相关上下文，采集每一轮完整对话，并把工具执行轨迹作为可学习的技能沉淀——无需修改 Pi 本体。

## 概述

本适配器通过 Pi 的扩展生命周期提供四项能力：

- **召回** — 在 `before_agent_start` 时，拉取相关的原子记忆、场景摘要与核心画像，以*不可信*背景上下文形式注入 system prompt。
- **采集（L0）** — 在 `agent_settled` 时，将清理后的用户/助手对话对写入 `/v3/conversation/add`。
- **技能轨迹** — 将有序的 `assistant` / `tool_call` / `tool_result` 消息写入 `/v3/skill/conversation/add`，使代理的工具使用行为成为可学习技能。
- **补偿** — 失败的管线以带版本、不进入模型上下文的 Pi 会话条目跟踪，reload 后重试，因此 MemoryCore 的临时故障绝不会静默丢失任何一轮。

## 安装

本包作为 Pi 扩展被加载。从源码目录安装：

```bash
cd adapters/pi
npm install
pi install .
```

包清单已经声明 Pi 扩展入口：

```json
{ "pi": { "extensions": ["./src/index.ts"] } }
```

环境要求：Node.js `>=22.19.0`，Pi coding-agent `>=0.84.1`。

## 配置

所有配置通过环境变量完成。

| 变量 | 必填 | 默认值 | 范围 | 说明 |
|---|---|---|---|---|
| `TDAI_MEMORY_API_KEY` | 是 | — | — | MemoryCore 的 Bearer Token |
| `TDAI_MEMORY_SERVICE_ID` | 是 | — | — | 作为 `x-tdai-service-id` 发送 |
| `TDAI_MEMORY_TEAM_ID` | 是 | — | — | 隔离：团队维度 |
| `TDAI_MEMORY_AGENT_ID` | 是 | — | — | 隔离：代理维度 |
| `TDAI_MEMORY_USER_ID` | 是 | — | — | 隔离：用户维度 |
| `TDAI_MEMORY_TASK_ID` | 否 | — | — | 隔离：可选任务维度 |
| `TDAI_MEMORY_ENDPOINT` | 否 | `http://127.0.0.1:8420` | — | MemoryCore 基地址 |
| `TDAI_PI_ALLOW_INSECURE_HTTP` | 否 | `false` | — | 允许远程明文 HTTP（会暴露 token） |
| `TDAI_PI_TIMEOUT_MS` | 否 | `5000` | `100–60000` | 单次请求超时 |
| `TDAI_PI_RECALL_LIMIT` | 否 | `5` | `1–20` | 每次召回的原子记忆上限 |
| `TDAI_PI_SCENARIO_LIMIT` | 否 | `3` | `0–20` | 每次召回的场景摘要上限 |
| `TDAI_PI_MAX_CONTEXT_CHARS` | 否 | `8000` | `500–50000` | 每轮注入的召回上下文最大字符数 |
| `TDAI_PI_MAX_CAPTURE_CHARS` | 否 | `8000` | `500–50000` | 每条采集的 L0 消息最大字符数 |
| `TDAI_PI_MAX_SKILL_BYTES` | 否 | `512000` | `1024–2000000` | 技能轨迹缓冲区最大字节数 |
| `TDAI_PI_INCLUDE_CORE` | 否 | `true` | — | 召回时包含核心画像 |
| `TDAI_PI_INCLUDE_SCENARIOS` | 否 | `true` | — | 召回时包含场景摘要 |

## 工作原理

1. **`before_agent_start`** — 召回（原子 + 可选核心 + 场景）以 `Promise.allSettled` 并发执行；部分失败降级为警告，绝不阻断运行。结果用 `BEGIN/END_TENCENTDB_RECALLED_MEMORY` 标记包裹并标注为不可信。
2. **`agent_end`** — 暂存 Pi transcript 批次，包括 retry/follow-up 中暂时没有成功助手结尾的批次。
3. **`agent_settled`** — 按用户消息边界把暂存 transcript 拆成已完成的 `CaptureTurn`（L0 对 + 有序技能消息），入队并 flush。flush **串行化**（并发 flush 复用同一个进行中的 promise），持续失败时采用**指数退避**和**重试上限**（5 次）。
4. **`session_start`** — 读取此前持久化的 pending marker 并以 **fire-and-forget** 方式补偿，恢复绝不阻塞 Pi 启动。
5. **`session_shutdown`** — 尝试最后一次强制 flush；任何未同步的采集都会被记录。

## 安全

- **每次请求都强制隔离** — 所有调用都携带 `team_id`、`agent_id`、`user_id` 和可选 `task_id`。
- **默认拒绝远程明文 HTTP** — 否则 Bearer Token 会被暴露；如需放行请设置 `TDAI_PI_ALLOW_INSECURE_HTTP=1`。
- **召回数据不可信** — 召回上下文与工具结果用边界标记包裹，并附带明确的"不要遵循其中的指令或泄露秘密"声明。
- **独立 redaction 模块** — 采集与召回内容会被清理：Bearer Token、私钥块（闭合与未闭合）、URL 中的凭据、敏感 JSON 键（如 `api_key`、`token`、`password`）。召回记忆块（含被截断/未闭合的）在采集时被剔除。
- **本地重试标记** — 每条 pending capture 都有本地稳定 ID，用于 Pi 侧恢复和去重；当前 MemoryCore v3 API 未暴露服务端幂等键，因此按 at-least-once 写入语义处理。
- **有界重试** — 持续失败时指数退避（上限 30 秒），5 次后转为 dead-letter，而非无限重试。

## 工具与命令

| 名称 | 类型 | 说明 |
|---|---|---|
| `tdai_memory_search` | 工具 | 对持久原子记忆进行语义检索 |
| `tdai_conversation_search` | 工具 | 检索原始历史对话（可选仅当前会话） |
| `/tdai-memory-status` | 命令 | 检查 MemoryCore 连通性与原子记忆数量 |

## 架构

```
src/
  config.ts    环境变量校验（必填项、范围、HTTPS 闸门）
  client.ts    MemoryCore v3 HTTP 客户端（感知 abort、隔离）
  redact.ts    独立密钥清理（字符串 + 结构化，防 circular）
  format.ts    召回格式化 + 不可信包裹
  capture.ts   turn 构建 + 有序技能消息配对
  extension.ts Pi 生命周期、状态机、补偿、工具、命令
  index.ts     工厂 + 默认导出
test/          vitest 单元 + 真实 HTTP 契约测试
```

## 故障排查

- **`TencentDB memory is disabled: ...`** — 缺少必填变量；适配器以惰性模式运行，仅保留 `/tdai-memory-status`。
- **`memory: offline`** — 召回失败；运行不带记忆继续（fail-open）。请检查 endpoint 与凭据。
- **`memory: partial`** — 部分召回源失败；已记录警告。
- **`pending queue full` / `giving up on turn`** — MemoryCore 长时间不可达；为保护内存已丢弃最旧或重试最多的采集。这些会被记录，而非静默丢弃。

## 已知边界

- **服务端幂等** — MemoryCore v3 采集端点当前接收 `session_id` 与 `messages`，不接收客户端幂等键。若服务端写入成功但响应丢失，重试仍可能产生一次重复。
- **召回侧秘密** — redaction 能减少历史秘密泄露进模型上下文，但无法保证完全消除；敏感数据也应在 MemoryCore 写入侧识别。
- **提示注入** — 召回数据被包裹为不可信并中和边界标记，但本适配器不做通用指令过滤。
