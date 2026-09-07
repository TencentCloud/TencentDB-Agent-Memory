# 跨平台适配差异对比（深入）

对比三种适配方式：**OpenClaw 插件**（进程内）、**Hermes Provider**（HTTP sidecar）、**Claude Code 适配层**（HTTP + Adapter SDK）。

## 1. 总览对比表

| 维度 | OpenClaw 插件 | Hermes Provider | Claude Code 适配层（本次） |
| :-- | :-- | :-- | :-- |
| 适配层语言 | TypeScript | Python + TypeScript(Gateway) | TypeScript |
| 与核心通信 | **进程内直连** `TdaiCore` | HTTP → Gateway → `TdaiCore` | HTTP → Gateway → `TdaiCore` |
| HostAdapter | `OpenClawHostAdapter` | `StandaloneHostAdapter` | `StandaloneHostAdapter`（Gateway 侧） |
| LLM 执行 | 复用宿主 agent runtime | 独立 OpenAI 兼容 HTTP | 独立 OpenAI 兼容 HTTP |
| 召回接入点 | `before_prompt_build` 钩子 | `prefetch()` | `UserPromptSubmit` hook |
| 捕获接入点 | `agent_end` 钩子 | `sync_turn()` | `Stop` hook（读 transcript） |
| 会话结束 | `gateway_stop`→`destroy()` | `on_session_end`→`/session/end` | `SessionEnd` hook→`/session/end` |
| 工具暴露 | `api.registerTool` | `get_tool_schemas`+`handle_tool_call` | MCP server（stdio JSON-RPC） |
| 短期符号压缩(offload) | ✅ 支持（进程内钩子） | ⚠️ 经 backend 转发 | ❌ 暂不涉及（仅长期记忆读写） |
| 部署形态 | 宿主插件（随宿主进程） | sidecar（独立 Gateway 进程） | 复用同一 Gateway + hook 脚本/MCP |
| 健壮性设施 | 宿主托管 | 熔断器/看门狗/后台线程/自动拉起 | SDK 层错误吞没 + hook 永不失败退出0 |
| 新增成本 | 中（熟悉钩子系统） | 高（Python 生命周期 + 线程） | **低（实现一个 PlatformBinding）** |

## 2. 通信方式差异

- **进程内（OpenClaw）**：`index.ts` 直接 `new TdaiCore(...)`，方法调用即函数调用。延迟最低、能拿到宿主全部上下文（messages、runtime），但**强绑定 Node 宿主**，LLM 也复用宿主模型。
- **HTTP（Hermes / Claude Code）**：适配层是 Gateway 的**客户端**。跨语言、跨进程、可多宿主共享同一记忆库；代价是需要独立 LLM 凭据、需管理 Gateway 生命周期、每次调用有 HTTP 开销。

## 3. 生命周期映射差异

三个平台的「turn 前召回 / turn 后捕获 / 会话结束」语义一致，但事件名与载荷形态不同：

| 归一化操作 | OpenClaw | Hermes | Claude Code |
| :-- | :-- | :-- | :-- |
| recall | `before_prompt_build(event.prompt, ctx.sessionKey)` | `prefetch(query, session_id)` | `UserPromptSubmit`：stdin JSON `{prompt, session_id}` |
| capture | `agent_end(event.messages, ctx)` | `sync_turn(user, assistant, session_id)` | `Stop`：stdin JSON `{transcript_path, session_id}`，需自行读 transcript 提取最后一轮 |
| flush | `gateway_stop`（整进程销毁，用 `destroy()`） | `on_session_end(messages)` | `SessionEnd`：stdin JSON `{session_id, reason}` |

**关键差异点**：
- OpenClaw / Hermes 在捕获时**直接拿到** user/assistant 文本；Claude Code 的 `Stop` 事件**不带对话内容**，必须解析 `transcript_path` 指向的 JSONL 反推最后一轮（见 `ClaudeCodeBinding.readLastTurn`）。
- OpenClaw 的 `gateway_stop` 是**整进程关停**（对应 `destroy()` 全量释放）；而 Hermes/Claude Code 的会话结束只是**单会话 flush**（对应 `handleSessionEnd`），Gateway 进程继续服务其他会话。这条区别在 `tdai-core.ts` 的注释里被特别强调，切勿混用。

## 4. 工具暴露差异

| | 机制 | 工具命名 |
| :-- | :-- | :-- |
| OpenClaw | `api.registerTool` 进程内注册 | `tdai_memory_search` / `tdai_conversation_search` |
| Hermes | Provider 返回 schema + `handle_tool_call` 路由 | `memory_tencentdb_memory_search` / `..._conversation_search` |
| Claude Code | MCP stdio server（`initialize`/`tools/list`/`tools/call`） | `memory_search` / `conversation_search`（Claude 侧自动加 `mcp__memory-tencentdb__` 前缀） |

SDK 通过 `PlatformBinding.toolNames` 抹平命名差异，`MemoryAdapter.listTools()` / `handleToolCall()` 统一编排。

## 5. 健壮性策略差异

- **Hermes** 投入最多：熔断器（连续失败暂停）、看门狗（守护线程周期性复活 Gateway）、后台 sync 线程池、首个对话自动拉起 Gateway。原因是它要长期驻留、服务多会话、且 Gateway 是被托管的子进程。
- **Claude Code 适配层** 走轻量路线：每个 hook 是**短命一次性进程**，天然隔离；SDK 在 `MemoryAdapter` 层吞掉所有 Gateway 错误、hook-cli 任何异常都 `exit(0)`，保证「记忆失败绝不打断宿主 turn」。不需要看门狗/熔断，因为进程用完即退。
- **OpenClaw** 依赖宿主自身的插件生命周期与超时保护（如 `gateway_stop` 的 3s 硬超时）。

## 6. 选型建议

- 宿主是 **Node 且能装插件** → 进程内直连（OpenClaw 范式），延迟与能力最佳（含 offload）。
- 宿主是 **其他语言 / 只能 HTTP / 需多宿主共享记忆** → HTTP Gateway 范式。
- 走 HTTP 路线时 → **优先用 Adapter SDK**，新平台只实现一个 `PlatformBinding`，其余全部复用。
