# AI 平台接入对比分析（OpenClaw / Hermes / Whale / Codex）

> 本文系统性地对比 TencentDB Agent Memory（TDAI）项目中四个 AI 平台的接入架构、
> 功能特性、性能与实现差异，并给出各平台的优劣势与适用场景，最后指出统一适配器
> SDK 的收敛点。

## 1. 总览：两种接入形态，一套记忆内核

TDAI 的记忆能力由统一内核 [`TdaiCore`](file:///d:/Develop/TencentDB/src/core/tdai-core.ts)
提供，四层记忆流水线为：

- **L0**：原始对话记录（conversation）
- **L1**：原子事实抽取（records / episodic / instruction）
- **L2**：场景块（scene blocks）
- **L3**：画像合成（persona）

`TdaiCore` 不直接绑定任何宿主，而是消费一个宿主中立的抽象接口
[`HostAdapter`](file:///d:/Develop/TencentDB/src/core/types.ts)（`getRuntimeContext` /
`getLogger` / `getLLMRunnerFactory`）。据此，四个平台被划分为两种接入形态：

| 形态 | 平台 | 与内核的关系 | LLM 调用方式 |
| --- | --- | --- | --- |
| 进程内厚客户端（in-process） | OpenClaw | 直接实现 `HostAdapter`，与 `TdaiCore` 同进程 | 宿主 `runEmbeddedPiAgent` |
| HTTP 薄客户端（out-of-process） | Hermes / Whale / Codex | 通过 HTTP 访问 `TdaiGateway`，Gateway 内部用 `StandaloneHostAdapter` 驱动 `TdaiCore` | Gateway 侧 OpenAI 兼容 API 直连 |

三个薄客户端平台的事实契约，是 Gateway 暴露的 7 个 HTTP 端点（见
[`src/gateway/types.ts`](file:///d:/Develop/TencentDB/src/gateway/types.ts)）：

```
GET  /health
POST /recall
POST /capture
POST /search/memories
POST /search/conversations
POST /session/end
POST /seed
```

这组端点是设计统一适配器 SDK 的天然收敛点。

---

## 2. OpenClaw 平台（进程内 HostAdapter）

**架构特点**：OpenClaw 是唯一进程内接入的平台。
[`OpenClawHostAdapter`](file:///d:/Develop/TencentDB/src/adapters/openclaw/host-adapter.ts)
封装宿主的 `OpenClawPluginApi`、插件数据目录（`~/.openclaw/state/memory-tdai`）与
OpenClaw 配置，直接实现 `HostAdapter`（`hostType = "openclaw"`）。

**实现机制**：

- **运行时上下文**：`getRuntimeContext()` 返回默认上下文，`buildRuntimeContextForSession()`
  在每个 hook 调用时合并 `sessionKey` / `sessionId`。
- **模型调用**：[`OpenClawLLMRunner`](file:///d:/Develop/TencentDB/src/adapters/openclaw/llm-runner.ts)
  把宿主原生的 `CleanContextRunner`（底层 `runEmbeddedPiAgent`）包装为中立
  `LLMRunner`。`OpenClawLLMRunnerFactory` 按 `modelRef` / `enableTools` 创建 runner。
- **生命周期集成**：`before_prompt_build` → recall，`agent_end` → capture。
- **日志**：直接复用宿主 `api.logger`。

**特点**：无需 Gateway、无网络往返，延迟最低；但强依赖 OpenClaw 宿主 API，无法脱离宿主运行。

---

## 3. Hermes 平台（Python MemoryProvider + Gateway sidecar）

**核心功能与设计原理**：Hermes 通过 Python 实现
[`MemoryTencentdbProvider`](file:///d:/Develop/TencentDB/hermes-plugin/memory/memory_tencentdb/__init__.py)
（实现 Hermes 的 `MemoryProvider` 接口），并自带一个进程管家
[`GatewaySupervisor`](file:///d:/Develop/TencentDB/hermes-plugin/memory/memory_tencentdb/supervisor.py)
负责拉起与守护 Node.js Gateway sidecar。它是四个平台中最"厚"的客户端。

**关键机制**：

- **进程管理**：`ensure_running()` 用 `shlex.split + Popen` 启动 Gateway，stdout/stderr
  重定向到日志文件避免管道阻塞；健康等待最长 30s；优雅关停 SIGTERM→SIGKILL；僵尸进程回收。
  支持自动发现 `server.ts`（in-tree → `$HOME` 顺序）。
- **弹性**：熔断器（连续 5 次失败暂停 60s）、看门狗守护线程（每 10s 探活并复活）、
  懒探活 `_ensure_alive_for_request`、Gateway 自动复活（15s 冷却 + 非阻塞锁）。
- **并发控制**：后台 sync 线程池上限 4 个并发，防止 Gateway 挂起时线程无限增长。
- **生命周期映射**：`initialize`（后台线程启动 Gateway）、`prefetch` → `/recall`、
  `sync_turn`（异步）→ `/capture`、`shutdown` / `on_session_end` → `/session/end`。
- **工具接入**：暴露 `memory_tencentdb_memory_search` /
  `memory_tencentdb_conversation_search` 两个 LLM 工具，`handle_tool_call` 路由。
- **HTTP 客户端**：[`client.py`](file:///d:/Develop/TencentDB/hermes-plugin/memory/memory_tencentdb/client.py)
  为零依赖 urllib 客户端，支持可选 Bearer 头，覆盖全部 7 个端点（含 seed）。

**特点**：自治性极强（可自启动、自愈、自守护），适合长期后台运行；实现复杂度最高。

---

## 4. Whale 平台（当前分支新增：Python hooks + MCP Bridge）

**特性与集成方式**：Whale 是薄客户端，通过
[`hooks.toml`](file:///d:/Develop/TencentDB/whale-memory-tdai/hooks.toml) 声明三个生命周期钩子：

- `SessionStart` → `health.py`（探活，永远 exit 0）
- `UserPromptSubmit` → `recall.py`（POST `/recall`）
- `Stop` → `capture.py`（POST `/capture`）

**数据处理**：Whale 的 Stop payload **直接携带 `last_assistant_text`**，无需解析
transcript（比 Codex 简单）；capture 用守护线程异步发送，不阻塞回合结束。

**recall 输出格式**：`{"decision": "pass", "additional_context": "## Memory Context\n..."}`。

**按需搜索**：[`mcp-bridge.js`](file:///d:/Develop/TencentDB/whale-memory-tdai/mcp-bridge.js)
是零依赖 Node.js stdio JSON-RPC 2.0 服务，暴露 `search_memories` /
`search_conversations`，代理到 Gateway。`/memory` 斜杠命令与 `memory-hint.md` 规则提示
向模型说明记忆系统的存在与用法。

**语言选型**：hook 脚本为 Python 标准库，MCP bridge 为 Node.js。

**当前缺口**：hook 与 MCP bridge 均**未附带 Bearer 认证头**，且**没有调用 /session/end**。

---

## 5. Codex 平台（当前分支新增：零依赖 Node.js hooks + MCP Bridge）

**特性与集成方式**：Codex 亦为薄客户端，通过
[`hooks.json`](file:///d:/Develop/TencentDB/codex-memory-tdai/hooks/hooks.json)
（Claude-plugin 风格）声明三个钩子，命令均为 `node`，路径用 `${CLAUDE_PLUGIN_ROOT}` 展开：

- `SessionStart` → `health.js`
- `UserPromptSubmit` → `recall.js`
- `Stop` → `capture.js`

**数据处理（关键差异）**：Codex 的 Stop payload 只给 `transcript_path`，脚本需**读取
JSONL transcript 的最后 20 行**提取最近的 user / assistant 消息（比 Whale 复杂）。

**recall 输出格式**：`{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
"additionalContext": "..."}}`（与 Whale 的 `decision/additional_context` 不同）。

**语言选型**：hook 与 MCP bridge 全部零依赖 Node.js（原生 `fetch` +
`AbortSignal.timeout`），刻意规避 Windows 下 bash/jq/curl 的不可靠问题。附带
`skills/memory-usage/SKILL.md` 向模型说明机制。

**当前缺口**：同 Whale — 无认证头、无 /session/end 调用。

---

## 6. 横向对比表

| 维度 | OpenClaw | Hermes | Whale | Codex |
| --- | --- | --- | --- | --- |
| 接入形态 | 进程内 HostAdapter | HTTP 薄客户端 | HTTP 薄客户端 | HTTP 薄客户端 |
| 客户端厚度 | 中（宿主插件） | 最厚（熔断/看门狗/supervisor） | 极薄（无状态 hook） | 极薄（无状态 hook） |
| 数据处理（capture 来源） | 宿主会话事件 | `sync_turn` 传入文本 | payload 直带 `last_assistant_text` | 解析 transcript JSONL |
| 内存/进程管理 | 宿主进程内 | 自启动 + 自愈 + 守护 Gateway | 假设 Gateway 外部运行 | 假设 Gateway 外部运行 |
| 模型调用 | `runEmbeddedPiAgent` | Gateway OpenAI 兼容直连 | 同左（经 Gateway） | 同左（经 Gateway） |
| hook 生命周期 | before_prompt_build / agent_end | prefetch / sync_turn / shutdown / on_session_end | SessionStart / UserPromptSubmit / Stop | SessionStart / UserPromptSubmit / Stop |
| recall 输出格式 | 内核直接注入 | `context` 字段拼接 | `decision` + `additional_context` | `hookSpecificOutput.additionalContext` |
| 认证（Bearer） | 不适用 | 支持（可选） | **缺失** | **缺失** |
| 会话结束语义 | 有 | 有（/session/end） | **无** | **无** |
| seed 支持 | CLI | 有（client.seed） | 无 | 无 |
| 语言 / 依赖 | TypeScript | Python 标准库 + Node Gateway | Python hooks + Node bridge | 零依赖 Node.js |
| 按需搜索 | 内核工具 | 两个 LLM 工具 | MCP bridge（2 工具） | MCP bridge（2 工具） |

---

## 7. 优劣势与适用场景

### OpenClaw
- 优势：零网络往返、延迟最低、与宿主深度集成。
- 劣势：强耦合宿主 API，不能独立运行。
- 适用：作为 OpenClaw 一等公民插件的场景。

### Hermes
- 优势：自治性最强（自启动、自愈、看门狗），生产环境稳定；功能最全（含 seed、双工具）。
- 劣势：实现复杂、维护成本高（Python + Node 双栈 + 进程管理）。
- 适用：需要长期后台、无人值守、对可用性要求高的部署。

### Whale
- 优势：接入极简、无状态、失败静默；capture 无需解析 transcript。
- 劣势：不管理 Gateway 生命周期；缺认证与 session/end。
- 适用：Gateway 已由外部（systemd / ctl 脚本）托管的轻量接入。

### Codex
- 优势：零依赖、跨平台可靠（Windows 友好）；纯 Node.js 一致技术栈。
- 劣势：capture 需自行解析 transcript；缺认证与 session/end。
- 适用：Windows / 无 Python 环境、追求零外部依赖的接入。

---

## 8. 差异收敛结论与统一 SDK 的价值

三个薄客户端平台高度同构：都围绕 Gateway 的少数端点，都做 recall/capture/health 三件事，
都用一个近乎相同的 MCP bridge。Whale 与 Codex 之间的差异其实只有三点：

1. **capture 数据来源**（payload 直带文本 vs 解析 transcript）；
2. **recall 输出格式**（`decision/additional_context` vs `hookSpecificOutput`）；
3. **hook 脚本语言**（Python vs Node.js）。

其余（HTTP 调用、超时、错误静默、MCP 工具、认证、session/end）都应当共享。为此本项目引入
统一适配器 SDK（`sdk/tdai-adapter-sdk/`，零依赖 Node.js）：把 Gateway 客户端、Hook 运行框架、
MCP bridge 抽象为可复用组件，新平台只需实现一个描述上述三点差异的 **平台描述符（descriptor）**
即可接入，并在过程中统一补齐 **Bearer 认证头** 与 **/session/end** 两个缺口。详见
[`sdk/tdai-adapter-sdk/README.md`](file:///d:/Develop/TencentDB/sdk/tdai-adapter-sdk/README.md)。
