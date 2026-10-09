# Issue #235 平台适配差异对比

## 结论

当前仓库已有 OpenClaw 原生插件和 Hermes/Gateway 适配，本次新增
Claude Code hook adapter 与 DeerFlow adapter 后，可以覆盖两类典型平台：

- 生命周期 hook 明确的平台：OpenClaw、Claude Code、Hermes。适合把 recall
  放在 prompt 构建前，把 capture 放在 turn 完成后。
- LangGraph/agent middleware 平台：DeerFlow。适合通过 middleware 在
  `before_agent` 注入召回内容，在 `after_agent` 采集最终用户/助手轮次。

优先推荐新平台复用 HTTP Gateway，而不是直接调用 `TdaiCore`。Gateway 的
`/recall`、`/capture`、`/search/*`、`/session/end` 已经稳定封装核心能力，
各平台只需要处理生命周期事件、session/user 映射和失败降级。

## 对比表

| 平台 | 接入形态 | 读取记忆 | 写入记忆 | 搜索能力 | 失败降级 | 适配复杂度 |
| --- | --- | --- | --- | --- | --- | --- |
| OpenClaw | 原生插件，进程内调用 `TdaiCore` | `before_prompt_build` 调 `handleBeforeRecall` | `agent_end` 调 `handleTurnCommitted` | 插件工具调用 `searchMemories` / `searchConversations` | 插件内日志与降级逻辑 | 高，依赖 OpenClaw 插件 API |
| Hermes | Python provider + Gateway sidecar | provider prefetch 调 `POST /recall` | provider sync_turn 调 `POST /capture` | provider 暴露 Gateway search 工具 | Gateway 失败后 provider 可恢复/重启 | 中，HTTP 边界清晰 |
| Claude Code | 命令 hook 脚本 | `UserPromptSubmit` 调 `POST /recall`，返回 `additionalContext` | `Stop` 调 `POST /capture` | 当前基础适配不暴露搜索命令，可继续扩展 slash command | hook exit 0 且 stdout 为空 | 低，生命周期简单 |
| DeerFlow | LangChain `AgentMiddleware` + 可选 `MemoryStorage` | `before_agent` 调 `POST /recall`，注入 hidden `HumanMessage` | `after_agent` 提取最终 human/ai 后调 `POST /capture` | 可通过 adapter client 调 `/search/*`，DeerFlow 原生 UI 暂未接工具 | warning 后返回 `None`，不阻塞 agent | 中，需兼容 LangGraph state/runtime |

## 核心差异

### 生命周期粒度

OpenClaw 和 Hermes 提供的生命周期最接近 TencentDB Agent Memory 的模型：
prompt 前召回、turn 后采集、session 结束 flush。Claude Code hook 也有相近
事件，但 `Stop` payload 不一定天然包含完整历史，因此 adapter 用本地状态文件
保存最近一次 user prompt，再与最后 assistant message 配对。

DeerFlow 的核心运行时是 LangGraph agent。它没有使用本仓库插件 API，而是通过
`AgentMiddleware` 暴露 `before_agent` 和 `after_agent`。这能直接拿到
`state["messages"]`，适合做基础记忆读写；同时 DeerFlow 已有
`memory.storage_class` 扩展点，因此 adapter 也提供 `TdaiMemoryStorage` 作为
配置式接入。

### 记忆注入角色

OpenClaw/Hermes/Claude Code 主要把召回内容作为平台提供的上下文块注入。
DeerFlow 已经在自身动态上下文中区分 system-owned date 和 user-owned memory，
所以适配器沿用更保守的做法：召回内容注入为隐藏 `HumanMessage`，不提升为
`SystemMessage`，减少把可被用户影响的长期记忆赋予 system 权限的风险。

### session 与 user 映射

OpenClaw 可以直接使用宿主 session key。Hermes 和 Claude Code 通过 provider
或 hook payload 生成 session key。DeerFlow 使用 `runtime.context["thread_id"]`
或 LangGraph configurable `thread_id`，adapter 映射为
`deer-flow:<thread_id>`；user id 优先取 DeerFlow request context，缺失时使用
环境变量或 OS 用户。

### 搜索工具暴露

`TdaiCore` 已有两种搜索能力：L1 结构化记忆搜索和 L0 原始对话搜索。OpenClaw
和 Hermes 已经把它们暴露为平台工具。Claude Code 和 DeerFlow 当前实现聚焦
基础读写，保留 adapter client 的 `/search/memories` 和
`/search/conversations` 方法，后续可以接入各自的 command/tool 系统。

## DeerFlow 适配选择

DeerFlow 适合作为 Issue #235 的新增平台，原因是：

- 有稳定的 middleware 注入点，不需要修改 DeerFlow 源码即可完成基础读写。
- 本地仓库已经提供 `DeerFlowClient(middlewares=...)`，便于在外部包中接入。
- 原生 `memory.storage_class` 是备用入口，适合配置驱动部署。
- DeerFlow 记忆格式与 TencentDB Agent Memory 的 L0/L1/L2/L3 不完全一致，
  通过 Gateway 做边界转换可以避免侵入 DeerFlow 内部存储结构。

主要限制是：middleware 只能在 DeerFlow agent 完成后读取 state 中的最终消息；
如果未来要把 `/search/*` 暴露成 DeerFlow 原生工具，还需要接入 DeerFlow 的
tool registry 或 MCP 配置。
