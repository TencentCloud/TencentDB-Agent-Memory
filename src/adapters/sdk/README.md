# PlatformAdapter SDK — 新平台接入只需实现一个接口

## 为什么用 SDK

手写 vs SDK：

| 模块              | 手写行数 | SDK 接入行数 | 省掉 |
| ----------------- | -------- | ------------ | ---- |
| HostAdapter 构造   | ~110     | 0（SDK 不造——由调用方提供）| 100% |
| TdaiCore bootstrap | ~40      | 5 | 87% |
| 工具 handler       | ~80      | 2-5 | 94% |
| 生命周期 handler   | ~60      | 2-5 | 92% |
| 错误降级           | ~40      | 0 | 100% |
| 信号处理 / teardown| ~25      | 0（`result.shutdown()`） | 100% |
| **总计**           | **~355** | **~30** | **92%** |

核心设计：SDK **不**构造 HostAdapter——调用方自己提供。`PlatformAdapterRuntime.createStandaloneHostAdapter()` 是便利工厂，不是硬编码依赖。模式 A（in-process）平台可以传自己的 OpenClawHostAdapter 进去。

## 5 分钟接入

### 1. 复制模板

```bash
cp src/adapters/sdk/templates/template-mcp.ts src/adapters/my-platform/server.ts
```

### 2. 实现 IPlatformAdapter

```ts
class MyPlatformAdapter implements IPlatformAdapter {
  readonly platformId = "my-platform";

  async registerHandlers(ctx: IPlatformAdapterContext) {
    // 搜索工具——零代码
    ctx.registerTool({ name: "memory_search",  description: "...", routeTo: "memory_search" });
    ctx.registerTool({ name: "conv_search",     description: "...", routeTo: "conversation_search" });

    // 自定义工具——传 customHandler
    ctx.registerTool({
      name: "my_recall", description: "...", routeTo: "custom",
      customHandler: async (params) => {
        const r = await ctx.core.handleBeforeRecall(String(params.query), String(params.session_key));
        return JSON.stringify(r);
      },
    });

    // 生命周期——默认 handler 直接连 Core
    ctx.onLifecycle("before_prompt");
    ctx.onLifecycle("after_turn");
  }
}
```

### 3. Bootstrap

```ts
import { PlatformAdapterRuntime } from "../sdk/index.js";

// 构建 HostAdapter（调用方负责——SDK 不硬编码）
const hostAdapter = PlatformAdapterRuntime.createStandaloneHostAdapter({
  dataDir, llmConfig, logger,
});

const result = await PlatformAdapterRuntime.bootstrap({
  adapter: new MyPlatformAdapter(),
  hostAdapter,
  dataDir,
  config: memoryConfig,
});

// result.toolSchemas          — 工具 schema 列表（挂宿主工具注册）
// result.executeTool(name, p) — 工具调用分发（挂宿主工具路由）
// result.lifecycleCallbacks   — 生命周期回调 Map（挂宿主钩子）
// result.shutdown()           — 关闭时调一次
// result.core                 — TdaiCore 实例（需要直接调 Core 时用）
```

## API 参考

### `IPlatformAdapter`

```ts
interface IPlatformAdapter {
  readonly platformId: string;
  registerHandlers(ctx: IPlatformAdapterContext): Promise<void> | void;
}
```

### `IPlatformAdapterContext`

| 成员           | 类型                                           | 说明               |
| -------------- | ---------------------------------------------- | ------------------ |
| `core`         | `TdaiCore`                                     | Core 实例（已 init）|
| `config`       | `MemoryTdaiConfig`                             | 已解析配置          |
| `logger`       | `Logger`                                       | stderr 安全日志     |
| `registerTool` | `(def: PlatformToolDefinition) => void`        | 注册工具            |
| `onLifecycle`  | `(event, handler?) => void`                    | 注册生命周期回调    |

### `PlatformToolDefinition`

| 字段              | 类型                                                | 说明            |
| ----------------- | --------------------------------------------------- | --------------- |
| `name`            | `string`                                            | LLM 可见工具名   |
| `description`     | `string`                                            | LLM 上下文描述   |
| `routeTo`         | `"memory_search" \| "conversation_search" \| "custom"` | 路由          |
| `extraParameters` | `Record<string, unknown>`                           | 额外 JSON Schema |
| `customHandler`   | `(params) => Promise<string>`                       | routeTo=custom 时必须 |

### `PlatformAdapterBootstrapResult`

| 字段                | 类型                     | 说明                       |
| ------------------- | ------------------------ | -------------------------- |
| `core`              | `TdaiCore`               | Core 实例                   |
| `toolSchemas`       | `PlatformToolSchema[]`   | 宿主注册工具用              |
| `executeTool`       | `(name, params) => ...`  | 宿主工具路由用              |
| `lifecycleCallbacks`| `ReadonlyMap<...>`       | 宿主角子用                  |
| `shutdown`          | `() => Promise<void>`    | 进程退出时调用              |

### `PlatformAdapterRuntime.createStandaloneHostAdapter()`

```ts
static createStandaloneHostAdapter(opts: {
  dataDir: string;
  llmConfig: StandaloneLLMConfig;
  logger: Logger;
  defaultUserId?: string;
}): HostAdapter
```

便利工厂——给模式 B/C 平台一键构造 McpHostAdapter。模式 A 平台传自己的 HostAdapter。

## 模板选择

| 模板                        | 适用场景                                          |
| --------------------------- | ------------------------------------------------- |
| `template-inprocess.ts`     | TS/JS 宿主、原生插件 API（模式 A）                 |
| `template-sidecar.ts`       | 非 JS 宿主、HTTP 桥接（模式 B）                    |
| `template-mcp.ts`           | MCP 宿主（模式 C）                                 |

## 自定义生命周期 handler

```ts
ctx.onLifecycle("before_prompt", async (payload, ctx) => {
  const p = payload as { userMessage: string; sessionId: string };
  const r = await ctx.core.handleBeforeRecall(p.userMessage, p.sessionId);
  ctx.logger.info(`Recalled ${r.recalledL1Memories?.length ?? 0} memories`);
  // 宿主负责把 r.prependContext / r.appendSystemContext 注入 prompt
});
```

## 迁移现有适配器

| 适配器              | 状态      | 迁移收益              |
| ------------------- | --------- | --------------------- |
| OpenClaw (index.ts) | 未迁      | 去掉 ~400 行样板       |
| MCP (server.ts)     | 未迁      | 切换到 SDK bootstrap   |
| Dify (provider.py)  | 不适用    | Python 不在 TS SDK 范围|
