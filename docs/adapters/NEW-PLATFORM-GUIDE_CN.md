# 如何接入新平台

> English version: [NEW-PLATFORM-GUIDE.md](./NEW-PLATFORM-GUIDE.md)。
> 背景阅读：[ARCHITECTURE_CN.md](./ARCHITECTURE_CN.md) · [PLATFORM-COMPARISON_CN.md](./PLATFORM-COMPARISON_CN.md) · [SDK 参考](../../src/adapter-sdk/README_CN.md)

有了 Adapter SDK（`src/adapter-sdk/`），接入一个新的 Agent 平台 = 面向**一个客户端**
（`MemoryClient`）实现**一个接口**（`PlatformAdapter`，实践中继承 `BasePlatformAdapter`）。
本文是分步操作手册，最后附完整可编译示例与测试骨架。

## 第 1 步 — 选传输方式

| 问题 | 是 → | 否 → |
| --- | --- | --- |
| 你的适配器是否运行在应当拥有记忆引擎生命周期的那个 Node 进程里？ | `in-process` | `http` |
| 是否有多个消费者（或非 Node 进程）需要共享同一份记忆存储？ | `http`（一个 Gateway，多客户端） | 皆可 |
| 本地开发希望零额外进程？ | `in-process` | `http` |

经验法则：**`http` 是默认选择**（与 Hermes、Claude Code、Dify 的部署形态一致，存储归
Gateway 所有）。只有当你的适配器进程本身就应当*是*记忆引擎时才选 `in-process`。

传输对适配器代码完全透明 — 两种实现的 `MemoryClient` 语义一致（由
`src/adapter-sdk/transports/*.test.ts` 中互为镜像的单测保证）。

## 第 2 步 — 创建客户端

```ts
import { createMemoryClient, resolveClientOptionsFromEnv } from "../../adapter-sdk/index.js";

// 方式 A：显式
const client = createMemoryClient({
  transport: "http",
  baseUrl: "http://127.0.0.1:8420",
  apiKey: process.env.TDAI_GATEWAY_API_KEY,
});

// 方式 B：标准环境变量约定（TDAI_ADAPTER_TRANSPORT、TDAI_GATEWAY_URL、
// TDAI_GATEWAY_API_KEY、TDAI_ADAPTER_TIMEOUT_MS）— 内置 CLI 都用这套。
const client2 = createMemoryClient(resolveClientOptionsFromEnv(logger));
```

## 第 3 步 — 继承 `BasePlatformAdapter`

只需实现三个成员：`platformName`、`start()`、`stop()`（基类的 `stop()` 已负责关闭客户端 —
自己的清理做完后调 `super.stop()`）。

## 第 4 步 — 把平台生命周期映射到客户端

对照表 — 在第 1 列找到你平台的事件，调用第 2 列：

| 平台事件（常见叫法） | MemoryClient 调用 | 说明 |
| --- | --- | --- |
| 「构建提示词前」/「回合前」/「prefetch」 | `safeRecall({query, sessionKey})` | `prependContext` 注入到用户消息附近，`context` 注入系统提示词。务必用 `safeRecall` — 记忆故障不能弄坏回合。 |
| 「回合结束」/「agent end」/「消息落库」 | `safeCapture({userContent, assistantContent, sessionKey})` | 可以发后不管；只有拿得到含工具调用的完整消息列表时才传 `messages`。 |
| 模型触发的「搜记忆」工具 | `searchMemories({query, limit, type?, scene?})` | 给模型返回 `.text`；平台需要逐条分数时用 `.items`。`limit` 收敛到 1..20。 |
| 模型触发的「搜历史」工具 | `searchConversations({query, limit, sessionKey?})` | 这里的 `sessionKey` 是*过滤器*而非作用域 — 想跨会话搜索就不要传。 |
| 「会话关闭」/「session end」 | `endSession(sessionKey)` | 只冲刷单个会话的流水线缓冲。绝不能当全局关闭用。 |
| 存活探针 | `health()` | 启动时也建议调一次，尽早失败并打出清晰日志。 |
| 进程退出 | `stop()` → `client.close()` | 只有 in-process 客户端自建的内核才会被 `close()` 销毁。 |

## 第 5 步 — 设计 session key 策略

`sessionKey` 决定 L0 记录的分组和流水线状态的作用域。既有先例：

- OpenClaw：宿主稳定的会话 key。
- Claude Code 适配器：`TDAI_SESSION_KEY` 环境变量，缺省 `claude-code:<目录名>`
  （每个项目目录一条记忆线）。
- Dify 适配器：每次请求的 `session_key` 字段，缺省 `dify:default`；流程里穿一个会话变量
  即可实现按用户记忆。

准则：加平台名前缀（`myplatform:...`）；同一逻辑会话重连后保持稳定；平台多租户时允许
每次请求覆盖。

## 第 6 步 — 完整示例（约 40 行，可直接对着 SDK 编译）

一个假想的 webhook 驱动平台的最小适配器：

```ts
import {
  BasePlatformAdapter,
  createMemoryClient,
  resolveClientOptionsFromEnv,
  type MemoryClient,
} from "../../adapter-sdk/index.js";

interface TurnEvent {
  userText: string;
  assistantText: string;
  conversationId: string;
}

export class MyPlatformAdapter extends BasePlatformAdapter {
  readonly platformName = "my-platform";

  constructor(client: MemoryClient) {
    super({ client });
  }

  async start(): Promise<void> {
    const health = await this.client.health();
    this.logger.info(`memory backend: ${health.status}`);
    // ……在这里订阅你平台的事件……
  }

  /** 每个 LLM 回合前调用 — 返回待注入的上下文，永不抛错。 */
  async beforeTurn(query: string, conversationId: string): Promise<string> {
    const recall = await this.safeRecall({
      query,
      sessionKey: `my-platform:${conversationId}`,
    });
    return [recall.prependContext, recall.context].filter(Boolean).join("\n\n");
  }

  /** 每个回合结束后调用 — 发后不管。 */
  async afterTurn(event: TurnEvent): Promise<void> {
    await this.safeCapture({
      userContent: event.userText,
      assistantContent: event.assistantText,
      sessionKey: `my-platform:${event.conversationId}`,
    });
  }
}

// 组装：
const adapter = new MyPlatformAdapter(createMemoryClient(resolveClientOptionsFromEnv()));
await adapter.start();
```

## 第 7 步 — 测试（离线，无内核、无 gateway）

照抄所有内置适配器测试用的伪客户端模式
（`src/adapters/claude-code/mcp-server.test.ts`、`src/adapters/dify/server.test.ts`）：

```ts
import { describe, expect, it, vi } from "vitest";
import type { MemoryClient } from "../../adapter-sdk/index.js";

function createFakeClient(overrides: Partial<MemoryClient> = {}): MemoryClient {
  return {
    recall: vi.fn(async () => ({ context: "ctx", memoryCount: 1 })),
    capture: vi.fn(async () => ({ l0Recorded: 2, schedulerNotified: true })),
    searchMemories: vi.fn(async () => ({ text: "", total: 0, strategy: "none", items: [] })),
    searchConversations: vi.fn(async () => ({ text: "", total: 0, items: [] })),
    endSession: vi.fn(async () => {}),
    health: vi.fn(async () => ({ status: "ok" as const, vectorStore: true, embeddingService: true })),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("MyPlatformAdapter", () => {
  it("回合前注入召回的上下文", async () => {
    const client = createFakeClient();
    const adapter = new MyPlatformAdapter(client);
    const context = await adapter.beforeTurn("我喜欢什么", "c1");
    expect(client.recall).toHaveBeenCalledWith({
      query: "我喜欢什么",
      sessionKey: "my-platform:c1",
    });
    expect(context).toContain("ctx");
  });

  it("记忆故障时存活（safeRecall 降级）", async () => {
    const client = createFakeClient({
      recall: vi.fn(async () => { throw new Error("down"); }),
    });
    const adapter = new MyPlatformAdapter(client);
    await expect(adapter.beforeTurn("q", "c1")).resolves.toBe("");
  });
});
```

交付前的约定清单：

- [ ] 适配器放在 `src/adapters/<platform>/`，含 `index.ts` barrel + `main.ts` CLI 入口
      （`isMain` 模式参照 `src/gateway/server.ts`），可用 `node --import tsx` 运行。
- [ ] 只从 `src/adapter-sdk/` 和 `src/core/types.js` 导入 — 绝不 import 根 `index.ts` 或
      `src/adapters/index.ts`（它们会拖入可选的 `openclaw` peer 依赖）。
- [ ] 环境变量命名 `TDAI_<PLATFORM>_*`；传输沿用共享的 `TDAI_ADAPTER_*` 约定。
- [ ] 测试使用伪 `MemoryClient`；服务器绑定端口 `0` 并在 `afterEach` 关闭。
- [ ] 适配器目录内提供双语 `README.md` + `README_CN.md`。
- [ ] 在 `package.json` 增加 `"adapter:<platform>"` npm 脚本。
