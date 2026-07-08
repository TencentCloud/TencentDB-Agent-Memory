# 平台对比：OpenClaw × Hermes × MCP (Claude Code) × Dify

四个平台接入同一个 TdaiCore 引擎——但宿主是不同 Agent 平台、不同语言、不同传输方式、不同生命周期机制。这份对比帮你理清差异，选对模式，避免踩坑。

## 1. 速览表

| 维度           | OpenClaw                                    | Hermes                                          | MCP (Claude Code)                               | Dify                                             |
| -------------- | ------------------------------------------- | ----------------------------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| 宿主语言       | TypeScript                                  | Python                                          | 任意（MCP 客户端）                              | Python                                           |
| 传输方式       | 进程内直接调用                              | HTTP → standalone Gateway                       | stdio JSON-RPC                                  | HTTP → standalone Gateway                        |
| 进程模型       | 单进程（Core 嵌入 OpenClaw）                | 多进程（Python Agent ↔ Node GW ↔ TdaiCore）     | 单进程（Core 嵌入 MCP server）                   | 多进程（Dify ← HTTP → Node GW ← TdaiCore）       |
| 工具注册       | `api.registerTool(...)`                     | `get_tool_schemas()` 返回 dict 列表             | MCP `tools/list` 标准协议                        | Dify Plugin SDK YAML + Python 混排               |
| 生命周期来源   | OpenClaw 钩子系统 (`api.on`)                | Hermes MemoryProvider 接口                      | Claude Code hooks JSON（外部配置）               | Dify Plugin SDK 接口                             |
| LLM 来源       | OpenClaw 内嵌 agent（`CleanContextRunner`）  | Gateway 内嵌 `StandaloneLLMRunner`               | MCP server 内嵌 `StandaloneLLMRunner`            | Gateway 内嵌 `StandaloneLLMRunner`                |
| 搜索工具数     | 2 (`tdai_memory_search` + `conv_search`)    | 2（同名工具）                                   | 5（含 recall / capture / session_end）           | 2（同名工具）                                    |
| 自动召回       | ✅ before_prompt_build 钩子                  | ✅ `prefetch()` 同步调用                        | ❌ 需宿主 hooks JSON 配置（用户操作）             | ❌ 同 Hermes，但 Dify 无 `prefetch` 等价机制      |
| 自动捕获       | ✅ agent_end 钩子                            | ✅ `sync_turn()` 异步线程                       | ❌ 需宿主 hooks JSON 配置（用户操作）             | ⚠️ `on_message()` 可选，需宿主支持                |
| 错误降级       | 静默跳过（try/catch + 日志）                 | 熔断器（5 次失败开断、60s 冷却）+ 看门狗        | JSON-RPC `isError` 字段 + 工具返回错误文本        | JSON 错误返回 + Dify 框架超时                     |
| Gateway 管理   | 不需要                                      | Supervisor 自动拉起进程                          | 不需要（Core 在 server 内）                      | 手动启 Gateway                                   |
| 代码量（估）   | ~900 行 index.ts + ~700 行 host-adapter/runner | ~1150 行 Python provider                        | ~500 行 host-adapter + ~250 行 server             | ~220 行 provider + ~80 行 client                   |
| 可复用比例     | 最高（共享整个 Core + utils）               | 最低（Python 需独立客户端 + socket 通信）        | 高（复用 StandaloneLLMRunnerFactory + Core）      | 中（复用 Gateway HTTP 端点，client 从 Hermes 抄）  |

## 2. 维度对照

### 2.1 进程模型

```text
OpenClaw (模式 A):                    MCP (模式 C):
┌──────────────────────┐            ┌──────────────────────┐
│ OpenClaw 宿主         │            │ MCP 客户端 (Claude)    │
│  ├─ Plugin SDK        │            │  ├─ stdio → JSON-RPC  │
│  ├─ TdaiCore          │            └──────────┬───────────┘
│  ├─ VectorStore       │                       │ 子进程
│  └─ sqlite-vec        │            ┌──────────┴───────────┐
└──────────────────────┘            │ MCP server             │
                                     │  ├─ TdaiCore          │
Hermes / Dify (模式 B):              │  ├─ VectorStore       │
┌──────────────┐    HTTP     ┌──────┬┴─┐ sqlite-vec         │
│ Python Agent │ ─────────→  │ Gateway │                    │
│ (Hermes/Dify)│ ←─────────  │ TdaiCore │                    │
└──────────────┘   JSON      └─────────┘                    │
                                     └──────────────────────┘
```

**关键差异：**

- 模式 A 和模式 C 只有一个进程——Core 的 SQLite 句柄直接归当前进程。性能最好，但该进程崩了什么都丢。
- 模式 B 有两个进程——Gateway 可以崩溃重启，Agent 不受影响。但多进程增加了运维复杂度。

### 2.2 传输协议

| 平台     | 协议             | 序列化          | 延迟        | 适用场景                     |
| -------- | ---------------- | --------------- | ----------- | ---------------------------- |
| OpenClaw | 函数调用          | 无（同进程内存） | < 1ms       | 紧密耦合、高频访问           |
| Hermes   | HTTP/1.1         | JSON body       | 1-10ms      | 跨语言、网络可达             |
| MCP      | stdio JSON-RPC   | JSON 行          | < 1ms       | 本地进程、工具暴露           |
| Dify     | HTTP/1.1         | JSON body       | 1-10ms      | 同 Hermes                    |

`★ Insight ─────────────────────────────────────`

MCP 的 stdio 传输不经过网络栈，在本地机器上延迟对标进程内调用。但每次调用需要完整的 JSON-RPC 往返（request → response → parse），跟直接函数调用比仍有 ~1ms overhead。高频搜场景（每秒 >100 次），模式 A 有显著优势。常规 Agent 工具调用频率（3 次/轮，每轮 ~30s），差异可忽略。

`─────────────────────────────────────────────────`

### 2.3 工具注册机制

**OpenClaw：**

```ts
api.registerTool({
  name: "tdai_memory_search",
  description: "...",
  parameters: { type: "object", properties: {...}, required: [...] },
  async execute(id, params) { ... }
});
```

- 类型安全（TypeScript），跑在同一个 V8 里
- Core 的 `searchMemories()` 直接调——零序列化
- 工具执行中可以访问 plugin 状态（`api.logger`、`core.instance`）

**Hermes：**

```python
def get_tool_schemas(self) -> list[dict]:
    return [MEMORY_SEARCH_SCHEMA, CONVERSATION_SEARCH_SCHEMA]
```

- Python dict，无类型检查
- `handle_tool_call()` 收到 tool_name + args dict → 调 HTTP client → Gateway 路由
- 工具 schema 跟实现代码分离——容易 schema 跟实现不同步

**MCP：**

```ts
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "tdai_memory_search", inputSchema: {...} }]
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  switch (req.params.name) { ... }
});
```

- 标准协议——任何 MCP 客户端都能消费
- schema 是内联的 JSON（无额外定义文件）
- `isError: true` 字段让客户端可靠识别工具失败

**Dify：**

```yaml
# tools.py — Python dict
MEMORY_SEARCH_TOOL = {
    "name": "memory_tencentdb_memory_search",
    "parameters": { "type": "object", "properties": {...} },
}
```

- Python dict 定义工具 schema，跟 Hermes 同风格
- Dify Plugin SDK 负责把 dict 渲染成 LLM function calling schema
- 工具调用在 provider 的 `invoke_tool()` 中分发

### 2.4 生命周期事件来源

| 事件            | OpenClaw                           | Hermes                             | MCP (Claude Code)                   | Dify                           |
| --------------- | ---------------------------------- | ---------------------------------- | ----------------------------------- | ------------------------------ |
| before_prompt   | `api.on("before_prompt_build", …)` | `prefetch(query)` 同步返回         | 用户配 `UserPromptSubmit` hook JSON | Dify 无等价机制                 |
| after_turn      | `api.on("agent_end", …)`           | `sync_turn(user, assistant)`       | 用户配 `Stop` hook JSON             | `on_message()` 可选，需宿主支持 |
| session_end     | 未接                               | `on_session_end()`                 | 用户配 `SessionEnd` hook JSON       | `on_session_end()`              |
| shutdown        | `api.on("gateway_stop", …)`        | `shutdown()`                       | SIGINT/SIGTERM 信号处理             | 插件卸载                         |

这是四个平台差异最大的维度。OpenClaw 原生支持一套完整的事件系统，工具注册和生命周期在同一个插件 API 里。MCP 只定义了工具——生命周期全靠宿主外部配置 hook JSON 来桥接。Hermes 和 Dify 是 Python 宿主的中间态：有部分生命周期方法（`prefetch`、`sync_turn`），但缺乏统一的 hook 编排。

### 2.5 LLM 来源

| 平台     | 提取 LLM 来自              | 搜索 LLM 来自             | 不配 LLM key 时              |
| -------- | -------------------------- | ------------------------- | ---------------------------- |
| OpenClaw | `CleanContextRunner`（宿主内嵌 agent，走 OpenClaw 配置的模型） | 同左                      | 提取/搜索降级（无 LLM 调用）  |
| Hermes   | Gateway 配置的 `StandaloneLLMRunner`（OpenAI 兼容 HTTP） | 同左                      | 搜索返回降级消息（无 crash）  |
| MCP      | MCP server 的 `StandaloneLLMRunner`（环境变量驱动） | 同左                      | 同 Hermes                    |
| Dify     | Gateway 配置的 `StandaloneLLMRunner` | 同左                      | 同 Hermes                    |

**模式 A（OpenClaw）不需要单独配 LLM**——宿主的默认模型直接给 Core 用。模式 B/C 需要额外的 LLM 配置（环境变量或 yaml），因为 Core 跑在独立进程里，无法访问宿主的 LLM。

### 2.6 错误降级策略

| 策略           | OpenClaw            | Hermes                     | MCP                    | Dify                 |
| -------------- | ------------------- | -------------------------- | ---------------------- | -------------------- |
| 集群降压       | try/catch → 静默跳过 | 熔断器 (5 failures, 60s)   | isError 字段           | JSON 错误返回         |
| 自恢复         | 下一轮自动重试       | 看门狗 daemon + 自动重连    | server 进程存活即恢复   | 依赖手动重启 Gateway  |
| 降级信息       | 不注入 prompt       | 返回空                      | 返回错误文本 + isError  | 返回 error JSON       |
| 影响范围       | 仅当前轮             | 熔断后整 session 短路       | 仅当前工具调用          | 仅当前工具调用        |

`★ Insight ─────────────────────────────────────`

Hermes 的熔断器是最成熟的降级方案——当 Gateway 持续不可达时，不会每轮都尝试重连（否则每次 prefetch/sync_turn 都会卡一个 HTTP 超时），而是设一个冷闭期（60s）。MCP 和 Dify 目前没有这个机制——如果 LLM API 挂，每次工具调用都会等到 `TDAI_LLM_TIMEOUT_MS`（默认 120s）。把熔断器抽象回 SDK（拓展档）是值得做的改进。

`─────────────────────────────────────────────────`

### 2.7 多用户/多会话隔离

四个平台**共享同一个存储隔离模型**——跨平台通用的 session key 分片：

- L0 conversations: `dataDir/conversations/<sessionKey>.jsonl`
- L1 records: `dataDir/records/<sessionKey>.jsonl`
- L2 scene_blocks: `dataDir/scene_blocks/<sceneName>.md`
- L3 persona: `dataDir/persona.md`（用户级别，不按 session 分片）

SQLite WAL 模式支持并发读，但同一时刻只能有一个进程写。跨平台并发写入需切到 tcvdb 后端（支持多写）。

**跨平台数据共享体验：**

| 场景                            | 是否可行 | 说明                                   |
| ------------------------------- | -------- | -------------------------------------- |
| 同一个 `dataDir`，平台间读写     | ✅       | schema 一致，文件格式通用               |
| 同时用 OpenClaw + MCP 写入       | ⚠️       | SQLite 文件锁，串行写入；高频写会有阻塞  |
| 先用 OpenClaw 灌数据，再用 Dify 搜索 | ✅   | 搜索只读，无冲突                       |
| MCP recall 失败后切回 OpenClaw   | ✅       | 同 dataDir，数据都在                    |

## 3. 接入成本评估

| 平台     | 新写代码行数 | 需理解的概念           | 可复用度        | 难度 |
| -------- | ----------- | --------------------- | --------------- | ---- |
| OpenClaw | ~1600       | Plugin SDK + 钩子系统 + 工具注册 + CleanContextRunner | 基准 | 中 |
| Hermes   | ~1150       | Gateway HTTP 端点 + MemoryProvider 接口 + 熔断器/看门狗 | ~30%（HTTP client 独立） | 中 |
| MCP      | ~750        | MCP SDK (tools/list + tools/call) + stdio transport + 信号处理 | ~70%（复用 StandaloneLLMRunner + Core + Gateway config） | 中低 |
| Dify     | ~300        | Dify Plugin SDK + Gateway HTTP 端点 | ~60%（client 从 Hermes 抄，schema 一致） | 低 |

## 4. 选型决策树

```mermaid
flowchart TD
    START["新 Agent 平台想接入 TDAI 记忆引擎"] --> Q1

    Q1{平台语言是 TS/JS<br/>且有原生插件 API?}
    Q1 -- 是 --> QA["模式 A：进程内 HostAdapter<br/>参考 src/adapters/openclaw/<br/>性能最优，耦合最紧"]
    Q1 -- 否 --> Q2

    Q2{宿主讲 MCP 协议?<br/>(Claude Code, Codex, Cursor, Cline ...)}
    Q2 -- 是 --> QB["模式 C：MCP server<br/>参考 src/adapters/mcp/<br/>一次写，覆盖所有 MCP 客户端"]
    Q2 -- 否 --> Q3

    Q3{宿主有 HTTP 能力?<br/>(Python, Go, Rust, .NET ...)}
    Q3 -- 是 --> QC["模式 B：HTTP sidecar<br/>参考 hermes-plugin/ 或 dify-plugin/<br/>语言无关，运维需维护 Gateway"]
    Q3 -- 否 --> Q4

    Q4{宿主有其他 IPC 能力?<br/>(gRPC, Unix socket, stdin/stdout ...)}
    Q4 -- 是 --> QD["模式 B 变体：换个传输层<br/>Gateway 加一个 gRPC/unix-socket listener<br/>客户端适配新协议即可"]
    Q4 -- 否 --> QF["无合适传输层<br/>考虑把 TdaiCore 嵌入宿主运行时<br/>（需把 Core 的 LLM/sqlite 依赖迁过去）"]
```

## 5. 后续候选平台

| 平台             | 推荐模式    | 理由                                                                 |
| ---------------- | ----------- | -------------------------------------------------------------------- |
| Codex CLI        | 模式 C      | MCP 原生支持，一个 server 覆盖                                       |
| Cursor           | 模式 C      | MCP 原生支持                                                         |
| Cline            | 模式 C      | MCP 原生支持                                                         |
| LangChain        | 模式 B      | Python 生态，HTTP 客户端 + Gateway 是自然选择                        |
| AutoGen          | 模式 B      | 同上                                                                |
| CrewAI           | 模式 B      | 同上                                                                |
| Continue (VS Code)| 模式 C     | 已支持 MCP                                                          |
| Aider            | 模式 B      | Python，可复用 Hermes client                                        |
| Goose CLI        | 模式 C      | 已支持 MCP                                                          |

---

## 6. 关键回退约束（四平台通用）

当**所有**搜索/提取都不可用时，TdaiCore 的降级行为：

1. **Recall** → 返回空 `prependContext`（不注入，不阻塞 Agent）
2. **Capture** → L0 JSONL 仍然能写（纯文件追加，不需要 LLM/embedding）
3. **Search** → 返回解释性错误文本（"Embedding service is not configured"），不崩
4. **Pipeline (L1/L2/L3)** → 不触发（`scheduler.flushSession` 检查 LLM runner 可用性）

L0 对话记录是**最基础的记忆层**，只需要文件系统权限就能工作。L1/L2/L3 需要 LLM + embedding，但三者是增值层——不能因为 L1 崩了就连 L0 也不写。
