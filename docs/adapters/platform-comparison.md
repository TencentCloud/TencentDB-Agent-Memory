# 平台适配模式深度对比

TencentDB-Agent-Memory 的核心引擎 `TdaiCore` 宿主中立，通过三种接入模式覆盖不同 Agent 平台。本文档深入对比三种模式（Pattern A / B-Python / B-MCP），并给出选型建议与 Codex 配置差异。

> 简版对照表见 [`README.md`](./README.md)。本文档为「深入阶段」交付，补充架构细节、生命周期、鉴权、优缺点与适用场景。

---

## 1. 三种接入模式总览

| 维度 | Pattern A (OpenClaw) | Pattern B-Python (Hermes) | Pattern B-MCP (Claude Code / Codex) |
|---|---|---|---|
| **引擎位置** | 宿主进程内 | 进程外 Gateway | 进程外 Gateway |
| **实现 `HostAdapter`?** | 是（`OpenClawHostAdapter`） | 否（宿主侧仅 HTTP 客户端） | 否（宿主侧仅 HTTP 客户端） |
| **宿主侧语言** | TypeScript | Python | TypeScript |
| **宿主侧载体** | `index.ts` + Plugin SDK 钩子 | `MemoryProvider` + `client.py` | MCP server + hooks + `TdaiHttpClient` |
| **统一 SDK 接口** | 直接调 `TdaiCore` | `client.py`（同 `TdaiClient` 契约） | `TdaiClient` + `HostEventBinding`（Track 2 SDK） |
| **传输** | 进程内直接调用 | HTTP | HTTP |
| **事件绑定** | `api.on(before_prompt_build/agent_end)` | `prefetch/sync_turn/on_session_end` | `UserPromptSubmit/Stop/SessionEnd` 钩子 |
| **工具暴露** | Plugin SDK 工具注册 | Hermes 工具 schema | MCP stdio server |
| **鉴权** | 无（同进程信任） | Bearer | Bearer |
| **生命周期管理** | 跟随宿主 | `GatewaySupervisor` + 熔断 + 看门狗 + Popen 拉起 | v1 精简 supervisor（健康探测 + 熔断；Popen 拉起待拓展） |
| **跨会话记忆** | ✅ | ✅ | ✅ |
| **跨语言复用** | ❌（绑定 OpenClaw SDK） | ✅（Python 生态） | ✅（MCP 标准，多宿主共用） |

---

## 2. 架构对比

### Pattern A — OpenClaw 进程内

```
┌─────────────────────────────────────────┐
│  OpenClaw 宿主进程                       │
│  ┌──────────┐  ┌─────────────────────┐  │
│  │ Agent 对话│  │ OpenClawHostAdapter │  │
│  └────┬─────┘  │ (implements          │  │
│       │        │  HostAdapter)        │  │
│  ┌────▼─────┐  └─────────┬───────────┘  │
│  │ Plugin   │            │              │
│  │ 钩子/工具 │◄───────────┘              │
│  └────┬─────┘                           │
│       │ 直接调用                         │
│  ┌────▼─────┐                           │
│  │ TdaiCore │  L0→L1→L2→L3             │
│  └────┬─────┘                           │
│       │                                 │
│  ┌────▼─────┐                           │
│  │ SQLite + │                           │
│  │ sqlite-vec│                          │
│  └──────────┘                           │
└─────────────────────────────────────────┘
```

- **零网络开销**：引擎与宿主同进程，调用是函数级。
- **配置最简**：无需起独立 Gateway，无需鉴权。
- **代价**：绑定 OpenClaw Plugin SDK，无法迁移到其他宿主。

### Pattern B-Python — Hermes 进程外

```
┌──────────────────────┐         ┌──────────────────────┐
│  Hermes 宿主进程      │  HTTP   │  TDAI Gateway 进程    │
│  ┌────────────────┐  │         │  ┌────────────────┐  │
│  │ MemoryProvider │──┼────────►│  │ HTTP Server    │  │
│  │ (Python)       │  │  Bearer │  │ :8420          │  │
│  │  - prefetch    │  │         │  └───────┬────────┘  │
│  │  - sync_turn   │◄─┼─────────┤          │           │
│  │  - on_sess_end │  │         │  ┌───────▼────────┐  │
│  └───────┬────────┘  │         │  │ StandaloneHost │  │
│          │           │         │  │ Adapter        │  │
│  ┌───────▼────────┐  │         │  └───────┬────────┘  │
│  │ client.py      │  │         │  ┌───────▼────────┐  │
│  │ (TdaiClient 契约)│ │         │  │ TdaiCore       │  │
│  └────────────────┘  │         │  └───────┬────────┘  │
└──────────────────────┘         │  ┌───────▼────────┐  │
                                 │  │ SQLite + vec   │  │
                          GatewaySupervisor           │
                          (Popen + 熔断 + 看门狗)      │
                                 └──────────────────────┘
```

- **进程隔离**：Gateway 可独立重启，宿主崩溃不丢记忆。
- **跨语言**：Python 宿主侧，引擎仍为 TS。
- **完整生命周期管理**：`GatewaySupervisor` 支持 Popen 拉起、熔断、看门狗自动恢复。
- **代价**：需 Python 运行时；Hermes 专属事件名。

### Pattern B-MCP — Claude Code / Codex 进程外

```
┌──────────────────────────┐  stdio   ┌─────────────────┐  HTTP  ┌──────────────┐
│ Claude Code / Codex 宿主 │  MCP     │ memory-tdai-mcp │        │ TDAI Gateway │
│  ┌────────────────────┐  │          │ (TS MCP server) │        │ (同 B-Python)│
│  │ Agent 对话         │  │  3 工具  │ ┌─────────────┐ │        │              │
│  └─┬──────────────────┘  │◄────────►│ │mcp-server.ts│ │◄──────►│ POST /recall │
│    │ UserPromptSubmit    │          │ └─────────────┘ │        │ POST /capture│
│    │ Stop                │          │ ┌─────────────┐ │        │ POST /search │
│    │ SessionEnd          │──hooks──►│ │ hooks/*.ts  │─┼────────►│ POST /session│
│    └► (settings.json)    │  (tsx)   │ └─────────────┘ │        │ /end         │
│  ┌────────────────────┐  │          │   ↓             │        └──────────────┘
│  │ TdaiHttpClient     │◄─┼──────────┤ ClaudeCodeEvent │
│  │ + HostEventBinding │  │          │   Binding       │
│  └────────────────────┘  │          │ ┌─────────────┐ │
└──────────────────────────┘          │ │gateway-     │ │
                                      │ │supervisor.ts│ │
                                      │ │(健康+熔断v1) │ │
                                      │ └─────────────┘ │
                                      └─────────────────┘
```

- **MCP 标准**：同一 MCP server 可被 Claude Code、Codex 等任何 MCP 客户端复用。
- **hooks + 工具互补**：hooks 自动 recall/capture，MCP 工具供 Agent 显式检索。
- **Track 2 SDK**：`HostEventBinding` + `TdaiClient` 两个接口，新平台接入只需实现 4 方法。
- **代价**：需宿主支持 MCP + hooks；v1 supervisor 较 Hermes 精简（无 Popen 拉起）。

---

## 3. 事件绑定对照

三种模式把各自宿主的事件翻译成同样的 4 个 `HostEventBinding` 方法：

| `HostEventBinding` 方法 | Pattern A (OpenClaw) | Pattern B-Python (Hermes) | Pattern B-MCP (Claude Code) |
|---|---|---|---|
| `onUserPrompt` (recall) | `before_prompt_build` | `prefetch` | `UserPromptSubmit` 钩子 |
| `onTurnEnd` (capture) | `agent_end` | `sync_turn` | `Stop` 钩子 |
| `onSessionEnd` (flush) | `gateway_stop` | `on_session_end` | `SessionEnd` 钩子 |
| `getToolSchemas` | Plugin SDK 工具注册 | Hermes 工具 schema | MCP `ListTools` |

> Pattern A 直接调 `TdaiCore.handleBeforeRecall` 等；Pattern B 两种模式通过 `TdaiClient` HTTP 转发到 Gateway，再由 Gateway 调 `TdaiCore`。

---

## 4. 鉴权对照

| 模式 | 鉴权方式 | 宿主侧 env | Gateway 侧 env | 说明 |
|---|---|---|---|---|
| Pattern A | 无 | — | — | 同进程信任，无需鉴权 |
| Pattern B-Python | Bearer | `MEMORY_TENCENTDB_GATEWAY_API_KEY` | `TDAI_GATEWAY_API_KEY` | 双名回退约定 |
| Pattern B-MCP | Bearer | `TDAI_MCP_API_KEY` → `TDAI_GATEWAY_API_KEY` | `TDAI_GATEWAY_API_KEY` | MCP 专用名优先，回退通用名 |

Gateway 端 `GET /health` 永不需鉴权（供健康探针/k8s liveness 用）；其他路由在 `apiKey` 设置后需 `Authorization: Bearer <key>`。

---

## 5. 生命周期管理对照

| 能力 | Pattern A | Pattern B-Python | Pattern B-MCP |
|---|---|---|---|
| 引擎启停 | 跟随宿主 | `GatewaySupervisor` Popen 拉起/停止 | v1 精简 supervisor（仅健康探测） |
| 熔断 | 不适用 | ✅（失败计数 + 冷却 + 半开恢复） | ✅（`GatewaySupervisor`，5 失败 → 60s 冷却） |
| 看门狗 | 不适用 | ✅（定时探活 + 自动重启） | ❌（待拓展阶段析出 `GatewayLifecycleManager`） |
| Gateway 不可达时 | — | 熔断后不阻塞宿主 | 启动时健康探测失败仅告警，不阻塞 MCP server 启动 |

> 拓展阶段计划：把 Pattern B-Python 的 Popen 拉起 + 看门狗析出为统一的 `GatewayLifecycleManager`，供 B-Python 与 B-MCP 共用。

---

## 6. Codex 配置差异（Step 2.2）

Codex（OpenAI 的编码 Agent）同样支持 MCP server。**同一 `memory-tdai-mcp` 二进制可直接复用**，仅配置文件格式与位置不同。

### 6.1 配置差异表

| 维度 | Claude Code | Codex |
|---|---|---|
| MCP 配置文件 | `.mcp.json`（项目根）或 `~/.claude.json` | `~/.codex/config.toml`（或项目级） |
| 配置格式 | JSON | TOML |
| 事件钩子 | `settings.json` 的 `hooks` 字段 | Codex 暂无等价钩子（仅 MCP 工具） |
| 自动 recall/capture | ✅（hooks 实现） | ❌（无 hooks，依赖 Agent 主动调工具） |
| 工具调用 | MCP stdio | MCP stdio |

### 6.2 Codex 配置示例（`~/.codex/config.toml`）

```toml
[mcp_servers.memory-tdai]
command = "node"
args = ["/path/to/bin/memory-tdai-mcp.mjs"]

[mcp_servers.memory-tdai.env]
TDAI_GATEWAY_BASE_URL = "http://127.0.0.1:8420"
TDAI_MCP_API_KEY = ""
TDAI_USER_ID = "default_user"
```

### 6.3 已验证状态

| 组件 | 状态 | 说明 |
|---|---|---|
| MCP server 二进制复用 | ✅ 已验证（单元 + 集成测试） | `memory-tdai-mcp` 与宿主无关，Codex 调用的是同一 HTTP 客户端 |
| Codex 真实环境调用 | ⏳ 待验证 | 需在真实 Codex 中配置 `config.toml` 并跑通 `tdai_memory_search`/`capture` |
| Codex 钩子（自动 recall/capture） | ❌ 不适用 | Codex 当前无 `UserPromptSubmit`/`Stop` 等价钩子，仅靠 MCP 工具 |

> **结论**：Codex 与 Claude Code 共用 Pattern B-MCP 的 MCP server 部分（工具调用），但 hooks（自动记忆闭环）是 Claude Code 专属能力。Codex 接入后 Agent 需主动调 `tdai_memory_search`/`tdai_capture` 工具。

---

## 7. 优缺点与适用场景

### Pattern A (OpenClaw 进程内)

- **优点**：零网络开销（函数级调用）；配置最简（无需 Gateway、无需鉴权）；与宿主生命周期完全一致。
- **缺点**：绑定 OpenClaw Plugin SDK，无法迁移；引擎崩溃会影响宿主。
- **适用场景**：宿主就是 OpenClaw 的生产部署。

### Pattern B-Python (Hermes 进程外)

- **优点**：进程隔离（Gateway 独立重启）；完整生命周期管理（Popen + 熔断 + 看门狗）；Python 生态友好。
- **缺点**：需 Python 运行时；Hermes 专属事件名，复用性低；网络开销（HTTP）。
- **适用场景**：宿主是 Python 生态（Hermes、Dify 等）。

### Pattern B-MCP (Claude Code / Codex 进程外)

- **优点**：MCP 标准，一份 server 多宿主复用；hooks + 工具互补（自动 + 显式）；Track 2 SDK 接口统一（`HostEventBinding` + `TdaiClient`）。
- **缺点**：v1 supervisor 较精简（无 Popen 拉起）；需宿主支持 MCP + hooks 才能全自动；网络开销（HTTP）。
- **适用场景**：宿主支持 MCP 且非 Python（Claude Code、Codex、未来其他 MCP 客户端）。

---

## 8. 选型建议

```
你的宿主是？
├─ OpenClaw ──────────────────────────► Pattern A（进程内，零开销）
├─ Python 生态（Hermes / Dify 等）────► Pattern B-Python（client.py + GatewaySupervisor）
└─ 支持 MCP 的其他宿主
    ├─ Claude Code ───────────────────► Pattern B-MCP（MCP server + hooks 全自动闭环）
    └─ Codex / 其他 MCP 客户端 ────────► Pattern B-MCP（MCP server，无 hooks，工具显式调用）
```

> 拓展阶段（`GatewayLifecycleManager` 析出后）Pattern B-Python 与 B-MCP 的生命周期管理将统一，届时两种 B 模式的差异仅剩宿主侧语言与事件名。

---

## 9. 记忆互通

三种模式最终都落到同一个 `TdaiCore`（同 Gateway 时），**记忆跨平台互通**：

- OpenClaw 写入的 L1 记忆，Claude Code 通过 `tdai_memory_search` 可检索。
- Claude Code capture 的 L0 对话，Hermes 通过 `searchConversations` 可查询。
- 前提：三种模式连同一个 Gateway（同 `baseDir`），用同一个 `userId`。

这是「宿主中立」设计的核心价值——记忆属于用户，不属于某个 Agent 平台。
