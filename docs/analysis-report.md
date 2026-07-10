# Cross-Platform Adapter — 基础验收分析报告

> Issue #235: Cross-Platform Adapters for the Memory Plugin
>
> 本文档记录 Issue #235 第一阶段的验收标准分析结果，涵盖 TdaiCore 核心引擎、
> OpenClaw 插件入口、Hermes Provider 实现的完整分析，以及两种适配方式的
> 架构对比和数据流描述。

---

## 目录

- [1. TdaiCore 核心引擎分析](#1-tdaicore-核心引擎分析)
- [2. OpenClaw 插件入口分析 (index.ts)](#2-openclaw-插件入口分析-indexts)
- [3. Hermes Provider 分析](#3-hermes-provider-分析)
- [4. 两种适配方式的对比](#4-两种适配方式的对比)
- [5. 架构数据流](#5-架构数据流)
- [6. 验收清单](#6-验收清单)

---

## 1. TdaiCore 核心引擎分析

### 1.1 概述

**文件**: [src/core/tdai-core.ts](../../src/core/tdai-core.ts)
**类型**: 宿主无关（host-neutral）核心引擎
**职责**: 整合 L0~L3 四层记忆系统的所有能力，对外暴露统一的 API

TdaiCore 仅依赖抽象接口（`HostAdapter`、`LLMRunnerFactory`），
从不直接依赖任何具体平台（OpenClaw、Hermes 等）。这种设计使得
TdaiCore 可以在不同宿主环境中无缝重用。

### 1.2 对外暴露能力

#### recall — 记忆召回

```typescript
async handleBeforeRecall(
  userText: string,
  sessionKey: string,
): Promise<RecallResult>
```

| 项目 | 说明 |
|------|------|
| 触发时机 | LLM 推理之前（prefetch） |
| 输入 | `userText`（用户消息文本）, `sessionKey`（会话标识） |
| 输出 | `RecallResult` |
| OpenClaw 映射 | `before_prompt_build` 钩子 |
| Hermes 映射 | `prefetch()` 方法 |

**RecallResult 结构**:

```typescript
interface RecallResult {
  /** L1 相关记忆——预置到用户消息前缀（动态，每轮更新） */
  prependContext?: string;
  /** 稳定召回上下文——追加到系统提示（persona、scene nav、工具指南） */
  appendSystemContext?: string;
  /** 召回的记忆条目（用于指标上报） */
  recalledL1Memories?: Array<{ content: string; score: number; type: string }>;
  /** L3 Persona 内容 */
  recalledL3Persona?: string | null;
  /** 使用的搜索策略 */
  recallStrategy?: string;
}
```

#### capture — 对话捕获

```typescript
async handleTurnCommitted(
  turn: CompletedTurn,
): Promise<CaptureResult>
```

| 项目 | 说明 |
|------|------|
| 触发时机 | LLM 完成一轮推理之后 |
| 输入 | `CompletedTurn`（包含消息列表、会话标识等） |
| 输出 | `CaptureResult` |
| OpenClaw 映射 | `agent_end` 钩子 |
| Hermes 映射 | `sync_turn()` 方法 |

**CompletedTurn 结构**:

```typescript
interface CompletedTurn {
  userText: string;
  assistantText: string;
  messages: unknown[];       // 该轮所有消息（含工具调用结果）
  sessionKey: string;
  sessionId?: string;        // 子会话标识
  startedAt?: number;        // 起始时间戳（epoch ms）
  originalUserMessageCount?: number;  // 用于定位被 prependContext 注入的消息
}
```

**CaptureResult 结构**:

```typescript
interface CaptureResult {
  l0RecordedCount: number;       // 记录的 L0 消息数
  schedulerNotified: boolean;    // 是否通知了管线调度器
  l0VectorsWritten: number;      // 写入的 L0 向量数
  filteredMessages: Array<{ role: string; content: string; timestamp: number }>;
}
```

#### searchMemories — L1 结构化记忆搜索

```typescript
async searchMemories(
  params: MemorySearchParams,
): Promise<{ text: string; total: number; strategy: string }>
```

| 项目 | 说明 |
|------|------|
| 触发时机 | LLM 调用 `tdai_memory_search` 工具 |
| 输入 | `{ query, limit?, type?, scene? }` |
| 输出 | 格式化文本 + 总计 + 策略 |
| OpenClaw 映射 | `api.registerTool("tdai_memory_search")` |
| Hermes 映射 | `handle_tool_call("memory_tencentdb_memory_search")` |

#### searchConversations — L0 原始对话搜索

```typescript
async searchConversations(
  params: ConversationSearchParams,
): Promise<{ text: string; total: number }>
```

| 项目 | 说明 |
|------|------|
| 触发时机 | LLM 调用 `tdai_conversation_search` 工具 |
| 输入 | `{ query, limit?, sessionKey? }` |
| 输出 | 格式化文本 + 总计 |
| OpenClaw 映射 | `api.registerTool("tdai_conversation_search")` |
| Hermes 映射 | `handle_tool_call("memory_tencentdb_conversation_search")` |

#### sessionEnd — 会话结束

```typescript
async handleSessionEnd(sessionKey: string): Promise<void>
```

清空指定会话的缓冲数据。**注意**：此方法与 `destroy()` 不同——
`handleSessionEnd` 仅操作单个会话，不关闭共享资源（VectorStore、调度器等），
允许多个并发会话共享同一个 `TdaiCore` 实例。

#### destroy — 全量销毁

```typescript
async destroy(): Promise<void>
```

关闭调度器、VectorStore、EmbeddingService 等所有共享资源。
用于进程退出或 gateway 关闭时的完整清理。

### 1.3 依赖接口

#### HostAdapter

```typescript
// 文件: src/core/types.ts
interface HostAdapter {
  readonly hostType: "openclaw" | "hermes" | "standalone";
  getRuntimeContext(): RuntimeContext;   // 返回当前会话的用户/会话/目录上下文
  getLogger(): Logger;                   // 返回日志器
  getLLMRunnerFactory(): LLMRunnerFactory; // 返回 LLM 执行器工厂
}
```

#### LLMRunnerFactory

```typescript
interface LLMRunnerFactory {
  createRunner(opts?: LLMRunnerCreateOptions): LLMRunner;
}

interface LLMRunner {
  run(params: LLMRunParams): Promise<string>;
}
```

#### HostAdapter 的实现

目前存在两个实现：

| 实现 | 适用平台 | hostType | 构造参数 |
|------|---------|----------|---------|
| `OpenClawHostAdapter` | OpenClaw 插件 | `"openclaw"` | `OpenClawPluginApi`, `pluginDataDir`, `openclawConfig` |
| `StandaloneHostAdapter` | Gateway / Hermes 边车 | `"standalone"` | `dataDir`, `llmConfig`, `logger`, `platform` |

---

## 2. OpenClaw 插件入口分析 (index.ts)

### 2.1 概述

**文件**: [index.ts](../../index.ts)（~870 行）
**架构模式**: 薄壳（thin shell）——翻译 OpenClaw 事件为 TdaiCore 调用

### 2.2 主要职责

1. **配置解析** — 从 `api.pluginConfig` 读取原始配置，通过 `parseConfig()` 转化为 `MemoryTdaiConfig`
2. **TdaiCore 初始化** — 创建 `OpenClawHostAdapter` + `TdaiCore`
3. **工具注册** — 向 OpenClaw 注册两个 LLM 可调用工具
4. **钩子注册** — 挂载 OpenClaw 生命周期钩子
5. **缓存管理** — 跨钩子的 prompt/recall 结果缓存
6. **指标上报** — 采集 agent_turn 等指标
7. **CLI 注册** — 注册 memory-tdai CLI 子命令
8. **Context Offload 注册** — 可选的条件性注册

### 2.3 工具注册

```typescript
// tdai_memory_search — L1 结构化记忆搜索
api.registerTool(
  {
    name: "tdai_memory_search",
    description: "搜索用户的长期记忆...",
    parameters: {
      type: "object",
      properties: {
        query:   { type: "string", description: "搜索查询" },
        limit:   { type: "number", description: "最大结果数 (default: 5, max: 20)" },
        type:    { type: "string", enum: ["persona", "episodic", "instruction"] },
        scene:   { type: "string", description: "场景过滤" },
      },
      required: ["query"],
    },
    async execute(toolCallId, params) {
      // → core.searchMemories({ query, limit, type, scene })
    },
  },
  { name: "tdai_memory_search" },
);

// tdai_conversation_search — L0 对话搜索，同上模式
api.registerTool({ name: "tdai_conversation_search", ... }, { name: "tdai_conversation_search" });
```

### 2.4 钩子注册

| 钩子 | TdaiCore 方法 | 功能 | 行号 |
|------|-------------|------|------|
| `before_prompt_build` | `handleBeforeRecall()` | LLM 推理前检索记忆并注入到 prompt | 528-613 |
| `before_message_write` | (直接调用 `stripInjectedRecallFromMessage`) | 剥离已注入的记忆上下文 | 625-656 |
| `agent_end` | `handleTurnCommitted()` | LLM 推理后捕获对话 | 659-762 |
| `gateway_stop` | `destroy()` | 进程退出时有序清理 | 765-811 |

**before_prompt_build 钩子工作流**:

```
event.prompt  →  缓存原始用户消息 (pendingOriginalPrompts)
               →  core.handleBeforeRecall()
               →  缓存召回结果 (pendingRecallCache)
               →  返回 { prependContext, appendSystemContext }
                  → OpenClaw 运行时自动注入到 LLM prompt
```

**agent_end 钩子工作流**:

```
event.messages  →  获取缓存原始提示
                →  core.handleTurnCommitted()
                →  采集 agent_turn 指标
```

### 2.5 缓存管理

| 缓存 | 键 | 值 | 用途 |
|------|-----|-----|------|
| `pendingOriginalPrompts` | sessionKey | `{ text, ts, messageCount }` | 在 agent_end 中获取原始用户文本 |
| `pendingRecallCache` | sessionKey | `{ l1Memories, l3Persona, strategy, durationMs }` | 在 agent_end 中上报指标 |
| `pendingRecallEndTimestamps` | sessionKey | timestamp | 估算 LLM 推理时间 |

所有缓存有 10 分钟的 TTL 和 10,000 条硬上限。

---

## 3. Hermes Provider 分析

### 3.1 概述

**目录**: [hermes-plugin/memory/memory_tencentdb/](../../hermes-plugin/memory/memory_tencentdb/)
**语言**: Python（TypeScript Gateway sidecar 由 Node.js 提供）
**架构**: HTTP Gateway 边车模式

### 3.2 三层架构

```
┌─────────────────────────────────────────────────────────┐
│  Python 层 (Hermes MemoryProvider)                       │
│  MemoryTencentdbProvider                                 │
│  ├── prefetch() / sync_turn() / handle_tool_call()      │
│  ├── GatewaySupervisor (子进程管理)                      │
│  └── MemoryTencentdbSdkClient (HTTP 客户端)              │
├─────────────────────────────────────────────────────────┤
│  HTTP 层 (JSON over REST)                                │
│  GET  /health  POST /recall  POST /capture               │
│  POST /search/memories  POST /search/conversations       │
│  POST /session/end  POST /seed                           │
├─────────────────────────────────────────────────────────┤
│  Node.js 层 (TdaiGateway)                                │
│  TdaiGateway (HTTP 服务器)                               │
│  ├── StandaloneHostAdapter + TdaiCore                    │
│  └── 可选 Bearer token 认证 + CORS                       │
└─────────────────────────────────────────────────────────┘
```

### 3.3 MemoryTencentdbProvider

**文件**: [hermes-plugin/memory/memory_tencentdb/__init__.py](../../hermes-plugin/memory/memory_tencentdb/__init__.py)
**基类**: `agent.memory_provider.MemoryProvider`

**核心方法映射**:

| Python 方法 | HTTP 端点 | TdaiCore 方法 | 功能 |
|------------|-----------|--------------|------|
| `prefetch(query)` | `POST /recall` | `handleBeforeRecall()` | 同步召回记忆 |
| `sync_turn(user, assistant)` | `POST /capture` | `handleTurnCommitted()` | 异步捕获对话 |
| `handle_tool_call("memory_search")` | `POST /search/memories` | `searchMemories()` | L1 记忆搜索 |
| `handle_tool_call("conversation_search")` | `POST /search/conversations` | `searchConversations()` | L0 对话搜索 |
| `on_session_end()` | `POST /session/end` | `handleSessionEnd()` | 会话结束 |
| `initialize()` | — | `TdaiCore.initialize()` | 初始化（Gateway 生命周期） |
| `shutdown()` | — | `TdaiCore.destroy()` | 清理（Gateway 生命周期） |

**可靠性特性**:

| 特性 | 说明 |
|------|------|
| 断路器 | 连续 5 次失败后暂停 60 秒 |
| 后台同步线程 | 最多 4 个并发 capture 线程 |
| Watchdog 线程 | 每 10 秒检查 Gateway 健康状态，自动复活 |
| 优雅降级 | Gateway 不可用时空返回，不阻塞主流程 |
| 自动发现 | 自动定位 Gateway server.ts（项目内或 $HOME 下） |

### 3.4 MemoryTencentdbSdkClient

**文件**: [hermes-plugin/memory/memory_tencentdb/client.py](../../hermes-plugin/memory/memory_tencentdb/client.py)

**API 端点封装**:

```python
# 健康检查
client.health(timeout=3)         → GET  /health

# 核心操作
client.recall(query, session_key)              → POST /recall
client.capture(user_content, assistant_content) → POST /capture
client.search_memories(query, limit)           → POST /search/memories
client.search_conversations(query, limit)      → POST /search/conversations
client.end_session(session_key)                → POST /session/end
client.seed(data, session_key)                 → POST /seed
```

### 3.5 GatewaySupervisor

**文件**: [hermes-plugin/memory/memory_tencentdb/supervisor.py](../../hermes-plugin/memory/memory_tencentdb/supervisor.py)

**职责**: 管理 Node.js Gateway 子进程生命周期

```python
# 核心方法
supervisor.is_running()       → 健康检查（HTTP GET /health）
supervisor.ensure_running()   → 若未运行则启动子进程 + 等待就绪
supervisor.shutdown()          → SIGTERM → 等待 10s → SIGKILL
```

启动参数通过 `shlex.split()` 解析 `MEMORY_TENCENTDB_GATEWAY_CMD` 环境变量，
或通过自动发现定位 `src/gateway/server.ts`。

### 3.6 TdaiGateway (Node.js HTTP 服务器)

**文件**: [src/gateway/server.ts](../../src/gateway/server.ts)

**路由表**:

```
GET  /health              → 返回 { status, version, uptime, stores }
POST /recall              → core.handleBeforeRecall()
POST /capture             → core.handleTurnCommitted()
POST /search/memories     → core.searchMemories()
POST /search/conversations → core.searchConversations()
POST /session/end         → core.handleSessionEnd()
POST /seed                → executeSeed() 批量导入
```

**安全特性**:
- 可选 Bearer token 认证（`TDAI_GATEWAY_API_KEY`）
- CORS 白名单配置
- 启动时安全性日志审计

---

## 4. 两种适配方式的对比

### 4.1 对比表

| 维度 | OpenClaw | Hermes |
|------|----------|--------|
| **通信方式** | 进程内函数调用 | 进程间 HTTP 通信 |
| **语言** | TypeScript（插件本身） | Python（Provider）+ TypeScript（Gateway） |
| **部署模型** | 作为 OpenClaw 插件打包 | Gateway 作为独立子进程运行 |
| **LLM 访问** | OpenClaw 嵌入式 agent（`runEmbeddedPiAgent`） | 独立 OpenAI-compatible API |
| **数据存储** | 插件自身管理 L0~L3 目录 | Gateway 管理存储 |
| **工具注册** | `api.registerTool()` | `get_tool_schemas()` → 返回 schema 字典 |
| **事件模型** | `api.on("event_name", handler)` | MemoryProvider 基类方法覆写 |
| **配置源** | `api.pluginConfig`（openclaw.json） | 环境变量 + tdai-gateway.yaml |
| **生命周期** | OpenClaw 管理（register → hooks → gateway_stop） | 显式初始化（initialize → shutdown） |
| **可靠性** | 依赖 OpenClaw 运行时 | 断路器 + watchdog + 后台同步线程 |
| **进程模型** | 单进程（长驻） | 双进程（Provider + Gateway sidecar） |
| **开发语言** | TypeScript | Python + TypeScript |
| **抽象层** | `OpenClawHostAdapter` 实现 `HostAdapter` | `StandaloneHostAdapter` 实现 `HostAdapter` |

### 4.2 共同模式

两种适配方式共享相同的核心抽象：

```
TdaiCore (引擎)
    │ 依赖 HostAdapter 接口
    ▼
HostAdapter 实现 (OpenClawHostAdapter / StandaloneHostAdapter)
    │
    ├── getRuntimeContext()  → RuntimeContext
    ├── getLogger()         → Logger
    └── getLLMRunnerFactory() → LLMRunnerFactory
```

TdaiCore 自身不关心底层是哪个平台——它只通过 `HostAdapter` 获取
运行时上下文、日志器和 LLM 执行能力。

---

## 5. 架构数据流

### 5.1 完整数据流图

```
                         用户输入
                            │
                            ▼
                    ┌────────────────┐
                    │  Platform       │
                    │  beforePrompt   │
                    │  / prefetch()   │
                    └───────┬────────┘
                            │ recall(query, sessionKey)
                            ▼
                    ┌────────────────┐
                    │   TdaiCore     │
                    │ handleBeforeRecall │
                    │                │
                    ├─ L1 Vector Search
                    │   (embedding / keyword / hybrid)
                    ├─ L3 Persona Load
                    │                │
                    └───────┬────────┘
                            │ { prependContext, appendSystemContext, ... }
                            ▼
                    ┌────────────────┐
                    │  Platform       │
                    │  注入 context   │
                    │  → LLM 推理     │
                    └───────┬────────┘
                            │ LLM 响应完成
                            ▼
                    ┌────────────────┐
                    │  Platform       │
                    │  afterTurn      │
                    │  / sync_turn()  │
                    └───────┬────────┘
                            │ capture(turn)
                            ▼
                    ┌────────────────┐
                    │   TdaiCore     │
                    │ handleTurnCommitted│
                    │                │
                    ├─ L0 对话记录 (JSONL)
                    ├─ L0 向量化
                    ├─ 调度 L1 提取 ✦
                    │   (LLM 结构化记忆)
                    ├─ 调度 L2 场景 ✦
                    │   (LLM 场景块)
                    └─ 调度 L3 画像 ✦
                        (LLM 用户画像)
                            │
                            ▼
                    ┌────────────────┐
                    │  存储层        │
                    │ SQLite / tcvdb │
                    └────────────────┘

✦ = 异步调度，由 MemoryPipelineManager 根据条件触发
```

### 5.2 关键数据路径

#### 路径 A: 进程内调用（OpenClaw 模式）

```
用户输入
  → OpenClaw 触发 before_prompt_build 钩子
  → index.ts 调用 core.handleBeforeRecall(text, sessionKey)
  → TdaiCore 执行混合搜索 (hybrid: keyword + vector)
    → 返回 RecallResult { prependContext, appendSystemContext }
  → index.ts 将 context 返回给 OpenClaw 运行时
  → OpenClaw 将 prependContext 注入到用户消息前缀
  → LLM 处理注入后的 prompt
  → LLM 响应完成
  → OpenClaw 触发 agent_end 钩子
  → index.ts 调用 core.handleTurnCommitted(turn)
  → TdaiCore 记录 L0 + 调度 L1/L2/L3
  → 返回 CaptureResult
```

#### 路径 B: HTTP 调用（Hermes 模式）

```
用户输入
  → Hermes 调用 provider.prefetch(query)
  → MemoryTencentdbProvider 发送 POST /recall
  → TdaiGateway 接收请求
  → Gateway 调用 core.handleBeforeRecall(query, sessionKey)
  → TdaiCore 执行搜索
  → 返回 RecallResult
  → Gateway 序列化为 JSON 响应
  → Python 客户端解析响应，注入 context
  → LLM 处理注入后的 prompt
  → LLM 响应完成
  → Hermes 调用 provider.sync_turn(user, assistant)
  → MemoryTencentdbProvider 发送 POST /capture
  → TdaiGateway 接收请求
  → Gateway 调用 core.handleTurnCommitted(turn)
  → 返回 CaptureResult 序列化为 JSON
```

### 5.3 流程对比

| 阶段 | OpenClaw (进程内) | Hermes (HTTP) |
|------|------------------|---------------|
| Recall 延迟 | ~5-50ms（直接函数调用） | ~10-100ms（含 HTTP 序列化开销） |
| Capture 延迟 | ~5-50ms | ~10-100ms + Python 线程调度 |
| 通信开销 | 无 | JSON 序列化/反序列化 |
| 故障隔离 | 插件崩溃影响宿主 | Provider 崩溃不影响 Gateway |
| 部署复杂度 | 低（单进程） | 中（Gateway sidecar 管理） |
| 水平扩展 | 不适用（单进程） | 可扩展（多 Gateway 实例） |

---

## 6. 验收清单

### 6.1 基础指标

| 指标 | 是否达标 | 说明 |
|------|---------|------|
| TdaiCore 接口完整性 | ✅ | 5 个核心方法（recall/capture/searchMemories/searchConversations/sessionEnd）+ lifecycle |
| HostAdapter 接口清晰 | ✅ | 3 个方法（getRuntimeContext/getLogger/getLLMRunnerFactory） |
| 两种适配方式已分析 | ✅ | OpenClaw（进程内）和 Hermes（HTTP Gateway） |
| 数据流已归档 | ✅ | 两种路径 A/B 的完整时序图 |
| 架构差异已记录 | ✅ | 10+ 维度的对比表 |

### 6.2 文件引用清单

| 文件 | 行数 | 分析要点 |
|------|------|---------|
| [src/core/tdai-core.ts](../../src/core/tdai-core.ts) | ~535 | 核心引擎，5 个对外方法 + 2 个 lifecycle 方法 |
| [src/core/types.ts](../../src/core/types.ts) | ~242 | HostAdapter / RuntimeContext / LLMRunner 等核心接口 |
| [index.ts](../../index.ts) | ~871 | OpenClaw 插件入口，工具注册 × 2、钩子注册 × 4 |
| [src/adapters/openclaw/host-adapter.ts](../../src/adapters/openclaw/host-adapter.ts) | ~117 | OpenClawHostAdapter 实现 |
| [src/adapters/standalone/host-adapter.ts](../../src/adapters/standalone/host-adapter.ts) | ~97 | StandaloneHostAdapter 实现 |
| [src/gateway/server.ts](../../src/gateway/server.ts) | ~610 | Gateway HTTP 服务器，7 个路由 |
| [src/gateway/types.ts](../../src/gateway/types.ts) | ~144 | Gateway 请求/响应类型 |
| [hermes-plugin/memory/memory_tencentdb/__init__.py](../../hermes-plugin/memory/memory_tencentdb/__init__.py) | ~1131 | Python MemoryProvider（断路器/watchdog/线程管理） |
| [hermes-plugin/memory/memory_tencentdb/client.py](../../hermes-plugin/memory/memory_tencentdb/client.py) | ~197 | HTTP 客户端（recall/capture/search/seed） |
| [hermes-plugin/memory/memory_tencentdb/supervisor.py](../../hermes-plugin/memory/memory_tencentdb/supervisor.py) | ~330 | Gateway 子进程管理器 |

---

## 附录：关键接口速查

```
TdaiCore
├── handleBeforeRecall(userText, sessionKey)          → RecallResult
├── handleTurnCommitted(turn)                          → CaptureResult
├── searchMemories({ query, limit?, type?, scene? })   → { text, total, strategy }
├── searchConversations({ query, limit?, sessionKey? }) → { text, total }
├── handleSessionEnd(sessionKey)                       → void
├── initialize()                                       → Promise<void>
└── destroy()                                          → Promise<void>

HostAdapter
├── hostType: "openclaw" | "hermes" | "standalone"
├── getRuntimeContext()                                → RuntimeContext
├── getLogger()                                        → Logger
└── getLLMRunnerFactory()                              → LLMRunnerFactory

LLMRunnerFactory
└── createRunner({ enableTools?, modelRef? })          → LLMRunner

LLMRunner
└── run({ prompt, systemPrompt?, taskId, ... })        → Promise<string>

RuntimeContext
├── userId / sessionId / sessionKey
├── platform: "openclaw" | "hermes" | "cli" | "gateway"
├── workspaceDir / dataDir
└── agentIdentity / agentContext
```

---

> **文档版本**: v1.0
> **对应 Issue**: #235
> **创建日期**: 2026-07-04
> **相关文档**:
> - [SDK 适配器接口设计](./adapter-sdk-design.md)
> - [跨平台适配指南](./cross-platform-adapter-guide.md)
