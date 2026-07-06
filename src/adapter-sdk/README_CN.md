# Adapter SDK — 统一跨平台记忆客户端

> English version: [README.md](./README.md)。
> 架构：[docs/adapters/ARCHITECTURE_CN.md](../../docs/adapters/ARCHITECTURE_CN.md) ·
> 接入指南：[docs/adapters/NEW-PLATFORM-GUIDE_CN.md](../../docs/adapters/NEW-PLATFORM-GUIDE_CN.md)

平台**消费**一个接口（`MemoryClient`），平台**实现**一个接口（`PlatformAdapter`，经
`BasePlatformAdapter`），两种可互换的传输。Claude Code MCP 适配器
（`src/adapters/claude-code/`）与 Dify 适配器（`src/adapters/dify/`）均完全构建于本 SDK 之上。

## 快速上手

```ts
import {
  createMemoryClient,
  BasePlatformAdapter,
  type MemoryClient,
} from "./index.js"; // src/adapter-sdk

// 1. 获取客户端 — 传输是配置项，不是代码。
const client: MemoryClient = createMemoryClient({
  transport: "http",                       // 或 "in-process"
  baseUrl: "http://127.0.0.1:8420",        // TdaiGateway
  apiKey: process.env.TDAI_GATEWAY_API_KEY,
});

// 2. 使用六大能力。
const recall = await client.recall({ query: "用户偏好？", sessionKey: "app:s1" });
await client.capture({ userContent: "你好", assistantContent: "你好！", sessionKey: "app:s1" });
const mem = await client.searchMemories({ query: "喝茶", limit: 5 });
const conv = await client.searchConversations({ query: "部署", sessionKey: "app:s1" });
await client.endSession("app:s1");
await client.close();
```

## `MemoryClient` 一览

| 方法 | 底层能力 | 返回 |
| --- | --- | --- |
| `recall(p)` | `TdaiCore.handleBeforeRecall` / `POST /recall` | `{ context, prependContext?, strategy?, memoryCount }` |
| `capture(p)` | `handleTurnCommitted` / `POST /capture` | `{ l0Recorded, schedulerNotified }` |
| `searchMemories(p)` | `searchMemories(Structured)` / `POST /search/memories` | `{ text, total, strategy, items[] }` |
| `searchConversations(p)` | `searchConversations(Structured)` / `POST /search/conversations` | `{ text, total, items[] }` |
| `endSession(key)` | `handleSessionEnd` / `POST /session/end` | `void` — 只冲刷单个会话 |
| `health()` | 存储访问器 / `GET /health` | `{ status, vectorStore, embeddingService, version? }` |
| `close()` | 生命周期 | 仅当内核由本客户端自建时才销毁 |

参数/结果一律 camelCase；snake_case 只存在于 HTTP 传输内部。所有失败统一抛
`MemoryClientError`，其 `code` 稳定可判：
`"transport" | "auth" | "bad_request" | "unavailable"`（HTTP 场景另附 `httpStatus`）。

## 传输

### `http` — `HttpMemoryClient`
与 Hermes Python 客户端讲完全相同的 TdaiGateway REST 方言（同端点、同 snake_case 请求体、
key 非空时才带 Bearer）。搜索路由额外发送 `include_items: true` 以获得逐条结构化 `items`；
对忽略该字段的旧版 gateway 优雅兼容（items 缺省为 `[]`）。选项：`baseUrl`
（默认 `http://127.0.0.1:8420`）、`apiKey`、`timeoutMs`（默认 10 秒）、`fetchImpl`（测试注入）。

### `in-process` — `InProcessMemoryClient`
包装同进程内的 `TdaiCore`。两种模式：

- **注入内核** — 传入 `core`（满足结构化子集 `TdaiCoreLike` 即可，包括测试伪对象）。
  客户端不管理其生命周期。
- **自建内核** — 什么都不传；首次调用时用 Gateway 配置机制（`TDAI_DATA_DIR`、`TDAI_LLM_*`、
  `tdai-gateway.yaml`）构建独立内核，Promise 门闩式懒初始化（并发首调只会产生一个内核）。
  `close()` 时销毁。

方法↔内核的映射与 `src/gateway/server.ts` 完全一致，因此两种传输在语义上可互换 —
e2e 测试（`transports/http-gateway.e2e.test.ts`）对着真实 gateway 验证了协议兼容性。

## `BasePlatformAdapter`

```ts
class MyAdapter extends BasePlatformAdapter {
  readonly platformName = "my-platform";
  async start() { /* 绑定服务 / 订阅事件 */ }
  // stop() 继承自基类：负责关闭客户端。需要额外清理时覆写并调 super.stop()。
}
```

提供 `this.client`、`this.logger`（带标签的 console 兜底），以及韧性助手
`safeRecall` / `safeCapture` — 记日志并降级而非抛错，落实项目铁律：记忆永远不能弄坏宿主对话。

## 环境变量约定（`resolveClientOptionsFromEnv`）

| 变量 | 含义 | 默认 |
| --- | --- | --- |
| `TDAI_ADAPTER_TRANSPORT` | `"http"` 或 `"in-process"` | `http` |
| `TDAI_GATEWAY_URL` | gateway 基础 URL | `http://127.0.0.1:8420` |
| `TDAI_GATEWAY_API_KEY` | Bearer 令牌（与 gateway 读取的同名变量） | 未设（无鉴权） |
| `TDAI_ADAPTER_TIMEOUT_MS` | HTTP 超时 | `10000` |

## 测试你的适配器

注入伪对象：伪 `MemoryClient`（见 `src/adapter-sdk/base-platform-adapter.test.ts`），或向
`InProcessMemoryClient` 注入伪 `TdaiCoreLike`（见 `transports/in-process.test.ts`）。
无 sqlite、无 LLM、无网络。

## 导入卫生

从 `src/adapter-sdk/index.js`（或具体文件）导入。适配器代码绝不 import 根 `index.ts` 或
`src/adapters/index.ts` — 它们引用可选的 `openclaw` peer 依赖，在仅 gateway 的安装环境中不存在。
