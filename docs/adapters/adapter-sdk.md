# 统一适配器 SDK 指南（拓展）

> 目标：**新平台接入只需实现一个接口**。SDK 把 HTTP 传输、会话解析、错误吞没、工具编排全部封装好了。

## 1. 设计理念

走 HTTP Gateway 路线的所有平台，本质都在做同一件事：

```
平台原生事件 ──parse──▶ 归一化输入 ──▶ Gateway REST 调用
Gateway 结果 ──format──▶ 平台原生输出
```

SDK 把「归一化输入/输出、HTTP、错误处理、工具」抽成可复用部分，只把 **parse/format** 这段平台专属逻辑留给你实现——这就是唯一的接口 `PlatformBinding`。

```
adapter-sdk/
├── src/
│   ├── types.ts          # PlatformBinding（唯一要实现的接口）+ 归一化类型
│   ├── gateway-client.ts # GatewayClient：Gateway REST 的 TS 客户端（内置 fetch，零依赖）
│   ├── adapter-core.ts   # MemoryAdapter：通用编排（handleRecall/Capture/SessionEnd/ToolCall）
│   ├── config.ts         # 从 env 解析 Gateway 地址/密钥/用户
│   └── index.ts          # barrel + createAdapterFromEnv()
└── bindings/
    ├── claude-code/      # 完整示例：hooks + MCP server
    └── codex/            # 极简示例：证明「一个接口即可接入」
```

## 2. 唯一接口：`PlatformBinding`

```ts
export interface PlatformBinding<RawRecall, RawCapture, RawSessionEnd, ...> {
  readonly platform: string;
  readonly toolNames?: Partial<Record<ToolName, string>>; // 可选：工具重命名

  parseRecall(raw: RawRecall): RecallInput | null;                 // null = 跳过
  formatRecall(result: RecallOutput, raw: RawRecall): unknown;     // 平台原生输出

  parseCapture(raw: RawCapture): CaptureInput | null;
  formatCapture?(result: CaptureOutput, raw: RawCapture): unknown; // 可选

  parseSessionEnd(raw: RawSessionEnd): SessionEndInput | null;
}
```

- 任何 `parse*` 返回 `null` 表示「跳过本次事件」（如空 prompt）。
- 归一化类型（`RecallInput`/`CaptureInput`/…）与 Gateway REST 字段一一对应。

## 3. 三步接入一个新平台

### Step 1 — 实现 `PlatformBinding`

以最简的 Codex 为例（完整代码见 `bindings/codex/binding.ts`）：

```ts
export class CodexBinding implements PlatformBinding<..., CodexTurnCompletePayload, ...> {
  readonly platform = "codex";

  parseRecall(raw) { return raw.query ? { query: raw.query, sessionKey: raw.sessionKey } : null; }
  formatRecall(result) { return result.context; }

  parseCapture(raw) {
    if (raw.type !== "agent-turn-complete") return null;
    return {
      userContent: (raw["input-messages"] ?? []).join("\n"),
      assistantContent: raw["last-assistant-message"] ?? "",
      sessionKey: this.sessionKey,
    };
  }

  parseSessionEnd() { return null; } // 该平台没有会话结束事件
}
```

### Step 2 — 构造 `MemoryAdapter`（一行）

```ts
import { createAdapterFromEnv } from "adapter-sdk/src/index.js";
const adapter = createAdapterFromEnv(new CodexBinding());
```

### Step 3 — 在平台的事件入口调用 `handle*`

```ts
// 平台的「turn 前」事件
const injected = await adapter.handleRecall(rawRecallEvent);   // 平台原生输出或 null

// 平台的「turn 后」事件
await adapter.handleCapture(rawTurnEndEvent);

// 平台的「会话结束」事件
await adapter.handleSessionEnd(rawSessionEndEvent);

// 平台的工具调用
const result = await adapter.handleToolCall("memory_search", { query: "..." });

// 需要工具 schema 时
const tools = adapter.listTools();
```

`MemoryAdapter` 负责：跳过 `null` 事件、调用 Gateway、**吞掉所有错误返回 null**（记忆失败绝不打断宿主）、按平台命名暴露工具。

## 4. SDK 提供的能力清单

| 能力 | API | 说明 |
| :-- | :-- | :-- |
| 召回 | `adapter.handleRecall(raw)` | parse→`POST /recall`→format |
| 捕获 | `adapter.handleCapture(raw)` | parse→`POST /capture`→format |
| 会话 flush | `adapter.handleSessionEnd(raw)` | parse→`POST /session/end` |
| 工具列表 | `adapter.listTools()` | 两个记忆工具的 schema |
| 工具执行 | `adapter.handleToolCall(name, args)` | 路由到 `/search/memories` 或 `/search/conversations` |
| 底层客户端 | `new GatewayClient({...})` | 直接用 REST（health/recall/capture/search/endSession） |

## 5. 配置（环境变量）

所有绑定共享同一套 env（与 Hermes 对齐，可共用同一个 Gateway）：

| env | 默认 | 说明 |
| :-- | :-- | :-- |
| `MEMORY_TENCENTDB_GATEWAY_HOST` | `127.0.0.1` | Gateway 主机 |
| `MEMORY_TENCENTDB_GATEWAY_PORT` | `8420` | Gateway 端口 |
| `MEMORY_TENCENTDB_GATEWAY_URL` | —（覆盖 host/port） | 完整 URL |
| `MEMORY_TENCENTDB_GATEWAY_API_KEY` | —（回退 `TDAI_GATEWAY_API_KEY`） | Bearer 鉴权 |
| `MEMORY_TENCENTDB_USER_ID` | `default_user` | 用户标识 |
| `MEMORY_TENCENTDB_DEBUG` | — | 置 1 打开 stderr 日志 |

## 6. 为什么这样就够了

- **传输已标准化**：Gateway REST 契约稳定，`GatewayClient` 一次实现处处复用。
- **编排已通用**：跳过/错误/工具都是平台无关逻辑，收敛在 `MemoryAdapter`。
- **只剩翻译**：平台之间真正不同的只有「事件长啥样、输出要什么形状」，正好就是 `PlatformBinding` 的 parse/format。

因此对比 `bindings/claude-code/binding.ts`（含 transcript 解析）与 `bindings/codex/binding.ts`（几十行），可见新平台的边际成本被压到最低。

## 7. 运行与验证

```bash
# 单元测试（mock fetch，无需真实 Gateway）
npx vitest run adapter-sdk/src/adapter-sdk.test.ts

# 类型检查
npx tsc -p adapter-sdk/tsconfig.json
```
