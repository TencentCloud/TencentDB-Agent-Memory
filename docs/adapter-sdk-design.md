# TDAI Memory Adapter SDK — Design & Validation

> **架构更新（2026-07）**：
> SDK 已从「进程内 TdaiCore」模式迁移至「Gateway HTTP Client」模式，
> 对齐 PR #316 的已验证基线。MemoryPlugin 内部不再嵌入 TdaiCore，
> 而是通过 GatewayMemoryClient (HTTP) 调用常驻 Gateway 进程中的 TdaiCore。

## 文件结构

```
src/sdk/
├── index.ts      # 桶导出
├── types.ts      # 共享类型 (ToolRegistration, PromptContext, TurnContext 等)
├── adapter.ts    # MemoryPlatformAdapter 接口（已废弃，保留向后兼容）
└── plugin.ts     # MemoryPlugin 类 — 包装 GatewayMemoryClient，提供高级 API

src/adapters/
└── gateway-client/
    ├── index.ts  # GatewayMemoryClient + createGatewayPlatformAdapter (#316 基线)
    └── README.md # 使用指南
```

---

## 架构总览

```typescript
// 推荐的新模式：直接使用 GatewayMemoryClient
import { GatewayMemoryClient } from "../adapters/gateway-client/index.js";

const client = new GatewayMemoryClient({
  baseUrl: "http://127.0.0.1:8420",
});
const recall = await client.recall({ query: "hello", session_key: "s-1" });

// 高级封装：MemoryPlugin（内部使用 GatewayMemoryClient）
import { MemoryPlugin } from "./plugin.js";
const plugin = new MemoryPlugin({ gatewayUrl: "http://127.0.0.1:8420" });
await plugin.initialize();
const result = await plugin.recall("hello", "s-1");
```

**MemoryPlugin** 暴露的核心方法：

| MemoryPlugin 方法 | 用途 | 底层实现 |
|-------------------|------|----------|
| `recall(text, sessionKey)` | 记忆召回 | GatewayMemoryClient → `POST /recall` |
| `capture(turn)` | 对话捕获 | GatewayMemoryClient → `POST /capture` |
| `searchMemories(params)` | L1 搜索 | GatewayMemoryClient → `POST /search/memories` |
| `searchConversations(params)` | L0 搜索 | GatewayMemoryClient → `POST /search/conversations` |
| `sessionEnd(sessionKey)` | 会话结束 | GatewayMemoryClient → `POST /session/end` |
| `initialize()` | 初始化（检查 Gateway 健康） | 创建 GatewayMemoryClient |
| `destroy()` | 销毁 | 释放本地引用 |

---

## 验证：OpenClaw 可实现该接口

### 现有代码对照

当前 `index.ts` ~800 行，用 SDK 可缩减为约 100 行的 adapter + 3 行 plugin 创建。

| MemoryPlatformAdapter 方法 | OpenClaw 现有实现 | 位置 |
|---|---|---|
| `platform` → `"openclaw"` | `hostAdapter.hostType` | `src/adapters/openclaw/host-adapter.ts:41` |
| `logger` → `api.logger` | `api.logger` | `index.ts:163` |
| `loadConfig()` → `api.pluginConfig` | `parseConfig(api.pluginConfig)` | `index.ts:173-179` |
| `resolveDataDir()` → `openclawStateDir + "/memory-tdai"` | `resolveOpenClawStateDir()` | `index.ts:249-250` |
| `resolveStandaloneLLM()` → `cfg.llm` | `StandaloneLLMRunnerFactory` (条件创建) | `tdai-core.ts:434-448` |
| `registerTool()` → `api.registerTool()` | `api.registerTool()` ×2 | `index.ts:353-518` |
| `on("beforePrompt")` → `api.on("before_prompt_build")` | `api.on("before_prompt_build", ...)` | `index.ts:530-613` |
| `on("afterTurn")` → `api.on("agent_end")` | `api.on("agent_end", ...)` | `index.ts:661-762` |
| `on("shutdown")` → `api.on("gateway_stop")` | `api.on("gateway_stop", ...)` | `index.ts:765-811` |

### OpenClawAdapter 实现草图

```typescript
// src/adapters/openclaw/sdk-adapter.ts
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolveOpenClawStateDir } from "../../utils/openclaw-state-dir.js";
import type { MemoryPlatformAdapter, ToolRegistration, PromptContext, TurnContext } from "../../sdk/adapter.js";

export class OpenClawAdapter implements MemoryPlatformAdapter {
  readonly platform = "openclaw";
  readonly logger;

  constructor(private api: OpenClawPluginApi) {
    this.logger = api.logger;
  }

  loadConfig(): Record<string, unknown> {
    return (this.api.pluginConfig ?? {}) as Record<string, unknown>;
  }

  resolveDataDir(): string {
    const stateDir = resolveOpenClawStateDir((this.api.runtime as any)?.state);
    return path.join(stateDir, "memory-tdai");
  }

  resolveStandaloneLLM() {
    return null; // OpenClaw 使用嵌入式 agent
  }

  registerTool(spec: ToolRegistration): void {
    this.api.registerTool(
      {
        name: spec.name,
        label: spec.label,
        description: spec.description,
        parameters: spec.parameters,
        async execute(toolCallId: string, params: Record<string, unknown>) {
          const text = await spec.execute(params);
          return { content: [{ type: "text" as const, text }], details: {} };
        },
      },
      { name: spec.name },
    );
  }

  on(event: "beforePrompt" | "afterTurn" | "shutdown", handler: Function): void {
    if (event === "beforePrompt") {
      this.api.on("before_prompt_build", async (event: any, ctx: any) => {
        await handler({ userText: event.prompt, sessionKey: ctx.sessionKey });
        // 返回记忆上下文让 OpenClaw 注入 — OpenClaw 的 before_prompt_build
        // 钩子可以通过 event 返回值注入 prependContext。
        // 开箱即用可能需要额外适配，因此平台也可选择直接调用 plugin.recall()
      });
    } else if (event === "afterTurn") {
      this.api.on("agent_end", async (event: any, ctx: any) => {
        const e = event as Record<string, unknown>;
        await handler({
          messages: (e.messages as unknown[]) ?? [],
          sessionKey: ctx.sessionKey,
          sessionId: ctx.sessionId,
          success: e.success !== false,
        });
      });
    } else if (event === "shutdown") {
      this.api.on("gateway_stop", handler);
    }
  }
}

// OpenClaw index.ts 简化后:
// const adapter = new OpenClawAdapter(api);
// const plugin = new MemoryPlugin({ adapter });
// await plugin.initialize();
```

### 可行性结论

✅ **OpenClaw 可直接实现 MemoryPlatformAdapter**。每个方法都有明确的 `api.*` 调用对应。现有 `index.ts` ~800 行可缩减为 ~100 行 adapter + SDK 内部的 300 行通用逻辑。SDK 接管了 TdaiCore 创建、工具注册、钩子编排、缓存管理。

---

## 验证：Hermes 可实现该接口

### 现有架构

Hermes Provider 使用 **HTTP Gateway 边车模式**：
```
Hermes (Python) → HTTP → Gateway (Node.js) → TdaiCore (in-process)
```

Python 侧的 `MemoryTencentdbProvider` 已经实现了与 `MemoryPlatformAdapter` 等价的语义——只是跨了语言边界。

验证分两层：

### 层 1：Gateway (Node.js 端)

Gateway 的 `TdaiGateway` 内部已经使用 `StandaloneHostAdapter` + `TdaiCore`，与 SDK 的模式完全一致。

```typescript
// src/gateway/server.ts (现有)
const adapter = new StandaloneHostAdapter({ dataDir, llmConfig, logger, platform: "gateway" });
const core = new TdaiCore({ hostAdapter: adapter, config });
```

这等价于 SDK 内部的行为。如果我们给 Gateway 加一个适配器：

```typescript
class GatewayPlatformAdapter implements MemoryPlatformAdapter {
  readonly platform = "gateway";
  readonly logger;

  constructor(private cfg: GatewayConfig) {
    this.logger = createConsoleLogger();
  }

  loadConfig()           { return this.cfg.memory as Record<string, unknown>; }
  resolveDataDir()       { return this.cfg.data.baseDir; }
  resolveStandaloneLLM() { return { baseUrl: this.cfg.llm.baseUrl, ... }; }

  registerTool(_spec: ToolRegistration) {
    // Gateway 不注册 LLM 工具 — 工具注册在 Hermes Python 端
  }

  on(_event: string, _handler: Function) {
    // Gateway 的生命周期由 HTTP 请求驱动，无需标准钩子订阅
  }
}
```

但 Gateway 不需要 SDK——它已经是简化后的 HTTP Server，路由直连 TdaiCore。SDK 的设计目标不在此。

### 层 2：Hermes Provider (Python 端)

Python 的 `MemoryTencentdbProvider` 通过 HTTP 调用 Gateway，其方法可以直接映射到 `MemoryPlatformAdapter` 的语义：

| MemoryPlatformAdapter | Hermes Provider 方法 | Gateway HTTP 端点 |
|---|---|---|
| `recall()` | `prefetch()` | `POST /recall` |
| `capture()` | `sync_turn()` | `POST /capture` |
| `searchMemories()` | `handle_tool_call("memory_tencentdb_memory_search")` | `POST /search/memories` |
| `searchConversations()` | `handle_tool_call("memory_tencentdb_conversation_search")` | `POST /search/conversations` |
| `sessionEnd()` | `on_session_end()` | `POST /session/end` |
| `on("shutdown")` | `shutdown()` | supervisor.shutdown() |
| `registerTool()` | `get_tool_schemas()` | 返回 tool schema 字典 |

如果 Hermes 端的 Provider 也要用此接口（假设有 TypeScript SDK for Hermes）：

```typescript
class HermesGatewayAdapter implements MemoryPlatformAdapter {
  readonly platform = "hermes";
  readonly logger;

  constructor(private client: MemoryTencentdbSdkClient, config: any) {
    this.logger = createLogger();
    this._config = config;
  }

  loadConfig()                { return this._config; }
  resolveDataDir()            { return this._config.dataDir; }
  resolveStandaloneLLM()      { return null; }  // 由 Gateway 内部处理

  registerTool(spec: ToolRegistration): void {
    // Hermes 的 tool 由 get_tool_schemas() 注册，SDK 不直接操控
  }

  on(event: string, handler: Function): void {
    // Hermes 通过 MemoryProvider base class 方法而非事件钩子
  }

  // 核心操作通过 HTTP client 调用 Gateway
  async recall(query: string, sessionKey: string) {
    return this.client.recall(query, sessionKey);
  }
  async capture(turn: TurnContext) { ... }
  async searchMemories(params: any) { ... }
  async searchConversations(params: any) { ... }
}
```

这与 Python 端 `MemoryTencentdbSdkClient` 的现有方法完全匹配。

### 可行性结论

✅ **Hermes 可实现该接口**。Gateway (Node.js) 端的 `TdaiGateway` 内部已经使用了与 SDK 完全对齐的模式。Python 端的 `MemoryTencentdbProvider` + `MemoryTencentdbSdkClient` 在语义上等价，核心操作映射一一对应。

---

## 验证总结

| 维度 | OpenClaw | Hermes (Gateway) | Hermes (Provider) |
|------|----------|-------------------|-------------------|
| 可直接适配 | ✅ 完全兼容 | ✅ 架构一致 | ✅ 语义等价 (跨语言) |
| 改动量 | ~100 行新 adapter | 无需改动（已对齐） | TypeScript 包装即可 |
| 工具注册 | `api.registerTool` | 无（Gateway 不面向 LLM） | `get_tool_schemas()` |
| 事件机制 | `api.on("hook_name")` | HTTP 请求驱动 | MemoryProvider 方法覆写 |
| config 源 | `api.pluginConfig` | tdai-gateway.yaml | 环境变量 |

**结论**：`MemoryPlatformAdapter` 接口具备覆盖 OpenClaw 和 Hermes 两种现有适配模式的能力，
同时为 Claude Code、Codex、Dify 等新平台提供了统一的接入契约。
