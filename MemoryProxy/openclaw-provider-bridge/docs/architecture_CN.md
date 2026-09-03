# OpenClaw Provider Bridge 架构

## 1. 设计目标

插件只负责 OpenClaw 框架适配与身份携带；记忆召回、Skill 注入、对话回流、鉴权和 Session 状态仍由 Memory Proxy/Core 负责。它不复制个人记忆版插件的数据访问逻辑，而是复用其“薄插件 + hooks/transport + 远端服务”的结构边界。

```text
OpenClaw Agent/Session
  │ provider transport wrapper（每次调用执行）
  │ x-team-id / x-agent-id / x-conversation-id / [x-task-id]
  ▼
Memory Proxy /openclaw/:instanceId/v1/chat/completions
  ├─ explicit conversation header（优先，并写入活跃映射）
  ├─ autoConversationId（header 丢失兜底、TTL、LRU）
  ├─ Session Init（team + agent 即可注册）
  ├─ Agent 级 / 可选 Task 级 memory + skill 注入
  ├─ LLM upstream
  └─ 对话与 tool call 回流 Memory Core
```

## 2. 身份作用域

| 层级 | 来源 | 生命周期 | 可变性 |
|---|---|---|---|
| OpenClaw Agent | `ctx.agentId` | Agent 配置期 | owner/admin 可改；只影响新 Session |
| Team + Memory Agent | `agentMappings` 或 Agent override | 新 Session 创建时冻结 | Session 内不可变 |
| OpenClaw Session | `options.sessionId` | OpenClaw 对话窗口 | 框架管理 |
| Conversation | 默认等于 OpenClaw Session ID | Session 级 | 可用命令轮换 |
| Task | 默认无 | Session 级 | 命令设置/清除；变更时轮换 Conversation |

注册键使用 `(OpenClaw Agent ID, OpenClaw Session ID)`，避免两个 Agent 恰好使用相同 Session ID 时共享身份。持久化文件按 `(proxyUrl, instanceId)` 哈希分域，避免多个 Memory 实例串用快照。

## 3. 请求链路

1. OpenClaw 从 `models.providers.memory-proxy.models[]` 识别并选择 `memory-proxy/<model>`。这份配置只是本地模型目录、协议能力和路由元数据；不会在 Proxy 之外额外调用模型。
2. `wrapStreamFn` 在每次底层模型请求前获得 `agentId + sessionId`。
3. Registry 首次创建 Session 时冻结 Team/Memory Agent；没有 Task 时不发 `x-task-id`。
4. Wrapper 合并 headers，并让动态身份值覆盖静态同名值。
5. Proxy 优先使用显式 conversation header。若后续请求未携带它，`autoConversationId` 使用 API key + agentSource 的活跃映射续接。
6. Proxy 的 `session/index.ts` 将 `openclaw`（以及 `hermes`）分流到共享 `session/header-only` 模块；该模块只校验 Team/Agent/可选 Task，然后直接注册或 bypass，绝不构造或推进交互表单状态。
7. 后续注入与回流都使用同一 session key。

OpenClaw 在发出请求前必须先解析一个已登记的 `provider/model`，以确定 transport 协议、Base URL、上下文窗口、输出上限以及工具/图片能力。插件负责动态身份 header 和 Session 映射，显式 `models.providers` 条目负责稳定的模型目录成员资格；真正的推理仍只发生在 Proxy 所配置的上游模型。

## 4. Proxy 自动会话算法

- 显式 ID：原样使用，并更新当前 key 的活跃映射。
- 无 ID、首轮文本不同：生成 UUID。
- 无 ID、已有 assistant/tool 历史：续接活跃 ID。
- 纯 `tool_result` user block：即使没有文本指纹也续接，避免误判新会话。
- 空闲达到 `ttlMinutes`：映射过期，下次请求生成新 UUID。
- `per-key-msg`：用第一条文本 user message 的 SHA-256 短摘要分区，允许同一 key 多窗口并行。
- 超过 `maxEntries`：按 Map 访问顺序淘汰最老项。

该映射不保存原始 API key 或消息文本。当前实现为进程内状态；插件始终发送显式 OpenClaw Session ID，因此正常 OpenClaw 流量天然支持多 Proxy 副本。只依赖 Proxy 自动兜底的无 header 客户端，在多副本部署中应使用粘性路由；未来可把 registry 抽象到 Redis。

## 5. Task 策略

| 输入 | `taskMissingPolicy` | 结果 |
|---|---|---|
| team + agent + 有效 task | 任意 | Agent + Task 级资产 |
| team + agent，无 task | `skip` | 仅 Agent 级资产 |
| team + agent，无 task | `default` | 绑定 `defaultTaskId` 占位 |
| team + agent，无 task | `reject` | 按 `onMismatch` |
| team + agent + 无效 task | 任意 | mismatch，按 `onMismatch`，绝不静默忽略 |

## 6. 安全与可靠性

- Team/Agent/Task 仍由 Proxy 对当前鉴权用户可见资源做校验，插件值不被盲目信任。
- header 值拒绝控制字符并限制为 256 字符。
- Registry 文件目录/文件权限分别请求 `0700/0600`，写入使用临时文件 + rename。
- Agent 级映射变更要求 owner 或 `operator.admin`。
- Session 身份冻结，避免运行中 Agent 映射变化污染已有对话。
- Registry 有 `maxSessions` 上限；Proxy 自动映射有 TTL + LRU 上限。

## 7. 向后兼容

- 旧客户端显式传四个 header 时，Proxy 原样采用 conversation/task，注册与注入路径不变。
- 显式会话 ID 永远优先于自动 ID。
- 不安装插件仍可使用原 `models.providers` 静态配置。
- `taskMissingPolicy: reject` 可恢复 task 必填行为；`autoConversationId.enabled: false` 可恢复缺会话 header 时不注入的行为。
