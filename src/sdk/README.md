# TDAI Adapter SDK — 宿主接入指南

本目录是 TencentDB-Agent-Memory 的**适配器 SDK 层**：把宿主中立的契约集中到一处，让新平台接入只需实现一个接口。

核心引擎 [`TdaiCore`](../core/tdai-core.ts) 不关心宿主是谁——它只消费两个接口之一：

| 接口 | 位置 | 谁消费 | 谁实现 |
|---|---|---|---|
| [`HostAdapter`](../core/types.ts) | `src/core/` | TdaiCore（引擎侧） | Track 1 宿主 |
| [`HostEventBinding`](./event-binding.ts) | `src/sdk/` | 宿主侧适配器 | Track 2 宿主 |

## 模块索引

| 文件 | 作用 |
|---|---|
| [`event-binding.ts`](./event-binding.ts) | Track 2 宿主侧事件绑定契约（`HostEventBinding` 4 方法 + `HostEventContext` / `RecallInjection` / `CaptureAck` / `HostCompletedTurn` / `ToolSchema`） |
| [`client.ts`](./client.ts) | `TdaiClient` 接口 + `TdaiHttpClient`（fetch + Bearer + 超时 + 重试 + `TdaiClientError`） |
| [`tool-schemas.ts`](./tool-schemas.ts) | 3 个记忆工具 schema 常量（`TDAI_TOOL_SCHEMAS`），跨宿主统一 |
| [`lifecycle.ts`](./lifecycle.ts) | `GatewayLifecycleManager`——宿主中立的 Gateway 健康探测 + 熔断器（Track 2 共享） |

> 本目录零运行时依赖（`lifecycle.ts` 仅依赖同目录的 `TdaiClient` 类型），保持可移植。

---

## 两条接入路径

### Track 1 — 进程内（实现 `HostAdapter`）

**适用**：宿主是 JS/TS 运行时，且愿意把 `TdaiCore` 嵌入自己的进程（零网络开销）。

**做什么**：实现 [`HostAdapter`](../core/types.ts) 的 3 个方法，让 TdaiCore 能向宿主问三件事：

```
TdaiCore  ──getRuntimeContext()──▶  "当前用户/会话是谁？"
         ──getLogger()──────────▶  "日志往哪写？"
         ──getLLMRunnerFactory()─▶  "怎么调 LLM？"
```

**现有实现**：[`OpenClawHostAdapter`](../adapters/openclaw/index.ts)（OpenClaw 插件）。

**接入步骤**：
1. 实现 `HostAdapter`（3 方法）
2. 在宿主进程内 `new TdaiCore({ hostAdapter, ... })` 直接驱动
3. 用宿主的事件系统（钩子 / 回调）调 `tdaiCore.handleBeforeRecall` / `handleAgentEnd` / `handleGatewayStop`

**优点**：零网络开销、配置最简、引擎与宿主共享内存。
**缺点**：仅限 JS/TS 宿主；引擎崩溃会拖垮宿主进程。

---

### Track 2 — 进程外（实现 `HostEventBinding` + 选 `TdaiClient`）

**适用**：宿主是非 JS 运行时（Python），或希望引擎进程隔离（独立重启）。

**架构**：TdaiCore 跑在独立的 HTTP Gateway（[`src/gateway/server.ts`](../gateway/server.ts)）里；宿主侧持一个 `TdaiClient`（HTTP 客户端）+ 一个 `HostEventBinding`（事件翻译层）。

```
宿主事件                HostEventBinding              TdaiClient            Gateway
─────────              ────────────────              ──────────            ───────
用户提问  ─onUserPrompt─▶ recall()        ─HTTP─▶  POST /recall     ─▶ TdaiCore
轮结束    ─onTurnEnd───▶ capture()       ─HTTP─▶  POST /capture    ─▶ L0 入库
会话结束  ─onSessionEnd─▶ endSession()   ─HTTP─▶  POST /session/end ─▶ flush
工具调用  ─getToolSchemas▶ 返回 schema    （模型按 schema 显式调 search 工具）
```

**做什么**：实现 [`HostEventBinding`](./event-binding.ts) 的 4 个方法，把宿主事件翻译成 `TdaiClient` 调用。

### `HostEventBinding` 四方法契约

| 方法 | 触发时机 | 调用 | 失败语义 |
|---|---|---|---|
| `onUserPrompt(prompt, ctx)` | 用户提问后、LLM 前 | `client.recall()` | 返回 `null`（不注入记忆） |
| `onTurnEnd(turn, ctx)` | 对话轮结束 | `client.capture()` | 返回 `null`（不 capture） |
| `onSessionEnd(ctx)` | 会话退出 | `client.endSession()` | 静默返回（不 flush） |
| `getToolSchemas()` | 工具注册时 | （不调 client） | 返回静态常量，不应抛 |

> **核心原则**：记忆永不阻塞对话。所有方法 try/catch 软失败。

### `TdaiClient` 实现选择

| 语言 | 实现 | 位置 |
|---|---|---|
| TypeScript | `TdaiHttpClient` | [`src/sdk/client.ts`](./client.ts) |
| Python | `MemoryTencentdbSdkClient` | [`hermes-plugin/memory/memory_tencentdb/client.py`](../../hermes-plugin/memory/memory_tencentdb/client.py) |

两者方法签名一一对应（TS 用 camelCase，Python 用 snake_case），HTTP 端点契约相同。

---

## 最小示例：为新宿主写 EventBinding 骨架

下面是一个新 TS 宿主（假设叫 "MyAgent"）的最小接入骨架。**只需实现 4 个方法**。

```typescript
import type {
  HostEventBinding,
  HostEventContext,
  HostCompletedTurn,
  RecallInjection,
  CaptureAck,
  ToolSchema,
} from "../sdk/event-binding.js";
import { TdaiHttpClient } from "../sdk/client.js";
import type { TdaiClient } from "../sdk/client.js";
import { TDAI_TOOL_SCHEMAS } from "../sdk/tool-schemas.js";

export class MyAgentEventBinding implements HostEventBinding {
  readonly hostType = "my-agent";
  private readonly client: TdaiClient;

  constructor(client: TdaiClient) {
    this.client = client;
  }

  async onUserPrompt(
    prompt: string,
    ctx: HostEventContext,
  ): Promise<RecallInjection | null> {
    try {
      const resp = await this.client.recall(prompt, ctx.sessionKey, ctx.userId);
      const context = resp.context?.trim();
      if (!context) return null;
      return { additionalContext: `<relevant-memories>\n${context}\n</relevant-memories>` };
    } catch {
      return null; // 软失败：记忆不阻塞对话
    }
  }

  async onTurnEnd(
    turn: HostCompletedTurn,
    ctx: HostEventContext,
  ): Promise<CaptureAck | null> {
    try {
      const resp = await this.client.capture(
        turn.userText,
        turn.assistantText,
        ctx.sessionKey,
        { sessionId: ctx.sessionId, userId: ctx.userId, messages: turn.messages },
      );
      return {
        l0Recorded: resp.l0_recorded,
        schedulerNotified: resp.scheduler_notified,
      };
    } catch {
      return null;
    }
  }

  async onSessionEnd(ctx: HostEventContext): Promise<void> {
    try {
      await this.client.endSession(ctx.sessionKey, ctx.userId);
    } catch {
      // 静默
    }
  }

  getToolSchemas(): ToolSchema[] {
    return [...TDAI_TOOL_SCHEMAS];
  }
}

// ── 启动 ────────────────────────────────────────────────────────────
const client = new TdaiHttpClient({
  baseUrl: "http://127.0.0.1:8420",
  apiKey: process.env.TDAI_MCP_API_KEY, // 与 Gateway 端 TDAI_GATEWAY_API_KEY 一致
});
const binding = new MyAgentEventBinding(client);

// 把 binding 接到你的宿主事件系统：
//   宿主.on("prompt",  (p) => binding.onUserPrompt(p, ctx))
//   宿主.on("turnEnd", (t) => binding.onTurnEnd(t, ctx))
//   宿主.on("exit",    ()  => binding.onSessionEnd(ctx))
//   宿主.registerTools(binding.getToolSchemas())
```

Python 宿主的等价骨架见 [`dify-plugin/dify_memory_tencentdb/event_binding.py`](../../dify-plugin/dify_memory_tencentdb/event_binding.py)（`DifyEventBinding`）——同样 4 个方法，复用 `MemoryTencentdbSdkClient`。

---

## 生命周期管理（Track 2 可选）

长命进程（MCP server、常驻服务）可用 [`GatewayLifecycleManager`](./lifecycle.ts) 做健康探测 + 熔断，避免 Gateway 宕机时每个请求都等超时：

```typescript
import { GatewayLifecycleManager } from "../sdk/lifecycle.js";

const supervisor = new GatewayLifecycleManager({ client });
if (!(await supervisor.ensureAlive())) {
  console.error("Gateway 不可达，工具调用将返回错误");
}
// 熔断：连续失败 5 次 → 冷却 60s → 半开探测
```

短命进程（hooks、一次性脚本）不需要——它们不共享状态，直接调 `client` 即可。

Claude Code 适配器通过别名 `GatewaySupervisor` 消费它（[`src/adapters/claude-code/gateway-supervisor.ts`](../adapters/claude-code/gateway-supervisor.ts)）。

---

## 选型决策

```
你的宿主是？
├─ JS/TS 运行时，愿意嵌入引擎 ──────▶ Track 1（实现 HostAdapter，进程内）
│   现有示例：OpenClaw
│
└─ 其他情况 ────────────────────────▶ Track 2（实现 HostEventBinding + TdaiClient）
    ├─ TS 宿主 ──▶ TdaiHttpClient
    │   现有示例：Claude Code（MCP server + hooks）
    │
    └─ Python 宿主 ──▶ MemoryTencentdbSdkClient
        现有示例：Hermes、Dify
```

---

## 现有实现索引

| 宿主 | Track | 适配器位置 | TdaiClient |
|---|---|---|---|
| OpenClaw | 1（进程内） | [`src/adapters/openclaw/`](../adapters/openclaw/) | —（直接调 TdaiCore） |
| Claude Code | 2（MCP） | [`src/adapters/claude-code/`](../adapters/claude-code/) | `TdaiHttpClient` |
| Codex | 2（MCP） | 复用 Claude Code 的 MCP server | `TdaiHttpClient` |
| Hermes | 2（Python） | [`hermes-plugin/memory/memory_tencentdb/`](../../hermes-plugin/memory/memory_tencentdb/) | `MemoryTencentdbSdkClient` |
| Dify | 2（Python） | [`dify-plugin/dify_memory_tencentdb/`](../../dify-plugin/dify_memory_tencentdb/) | `MemoryTencentdbSdkClient`（复用） |

## 相关文档

- [适配器架构总览](../../docs/adapters/README.md) — 三路径架构图 + 数据流 + 三平台对照
- [三平台深度对比](../../docs/adapters/platform-comparison.md) — Pattern A vs B-Python vs B-MCP
- [Claude Code 适配器 README](../adapters/claude-code/README.md) — Track 2 TS 完整接入示例
- [Dify 适配器 README](../../dify-plugin/README.md) — Track 2 Python demo 级接入
- [Hermes 插件 README](../../hermes-plugin/memory/memory_tencentdb/README.md) — Track 2 Python 生产级实现
