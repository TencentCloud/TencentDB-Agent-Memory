# TDAI Adapter SDK

零依赖 Node.js（纯 ESM）适配器 SDK，用于将任意 AI 平台（Agent 宿主）接入
TencentDB Agent Memory（TDAI）。SDK 通过 TdaiGateway HTTP API 工作，
只使用 `node:` 内建模块，无需安装依赖、无需编译。

已基于本 SDK 实现的适配器：`whale-memory-tdai/`、`codex-memory-tdai/`。

## 架构

```
宿主平台 (hook / MCP)          TDAI Adapter SDK                  TdaiGateway
┌──────────────────┐   stdin   ┌───────────────────┐   HTTP    ┌────────────┐
│ SessionStart      ├──────────► runHealthHook      ├──────────► GET  /health│
│ UserPromptSubmit  ├──────────► runRecallHook      ├──────────► POST /recall│
│ Stop              ├──────────► runCaptureHook     ├──────────► POST /capture
│ SessionEnd        ├──────────► runSessionEndHook  ├──────────► POST /session/end
│ MCP (stdio)       ├──────────► createMcpBridge    ├──────────► POST /search/*
└──────────────────┘           └────────┬──────────┘           └────────────┘
                                        │
                              PlatformAdapter（descriptor）
                              平台差异只在这里：payload 解析 + 输出格式
```

SDK 统一处理：HTTP 调用、超时、Bearer 认证、静默失败（绝不阻塞宿主回合）、
结构化日志、MCP stdio JSON-RPC。平台适配器只描述"差异点"。

## 模块

| 模块 | 导出 | 职责 |
| --- | --- | --- |
| `config.js` | `resolveConfig` | 解析 `TDAI_GATEWAY_URL` / `TDAI_GATEWAY_API_KEY` / `TDAI_GATEWAY_TIMEOUT_MS` |
| `logger.js` | `silentLogger` / `createLogger` | 默认全静默；`TDAI_SDK_DEBUG=1` 时输出到 stderr |
| `gateway-client.js` | `TdaiGatewayClient` | 覆盖 Gateway 全部 7 端点；apiKey 存在时自动附加 `Authorization: Bearer` |
| `platform-adapter.js` | `BasePlatformAdapter` / `defineAdapter` | 标准接口 + 默认实现 |
| `hook-runner.js` | `runHealthHook` / `runRecallHook` / `runCaptureHook` / `runSessionEndHook` | 通用 hook 流程：stdin → 解析 → Gateway → 输出 |
| `mcp-bridge.js` | `createMcpBridge` | stdio JSON-RPC 2.0 MCP server（`search_memories` / `search_conversations`） |
| `index.js` | 以上全部 | barrel 导出 |

## 标准接口（PlatformDescriptor）

新平台只需提供一个 descriptor 对象，**所有方法均可选**——省略时回退到
`BasePlatformAdapter` 的默认实现（Whale 形态：`prompt` / `last_assistant_text` /
`session_id` / `decision+additional_context` 输出）：

```ts
interface PlatformDescriptor {
  name: string;                                    // 平台名（必填）
  parseRecallPayload?(payload): RecallInput | null;    // 提取 recall 查询
  parseCapturePayload?(payload): CaptureInput | null   // 提取完成回合（可 async，
    | Promise<CaptureInput | null>;                     //   如需读 transcript 文件）
  formatRecallOutput?(context, payload): string;       // 输出宿主注入格式
  sessionKeyFrom?(payload): string;                    // 提取会话键
}
```

约定：

- `parse*` 返回 `null` 表示"本次无事可做"，runner 静默退出（exit 0，无输出）。
- `formatRecallOutput` 返回宿主期望的 **stdout JSON 字符串**。
- 所有 runner 全程 try/catch，Gateway 不可达/超时时绝不抛错、绝不阻塞回合。

## 最小接入示例（"新平台三步接入"）

假设新平台叫 `acme`，其 hook 以 stdin JSON 传 payload、以 stdout JSON 注入上下文。

### 第 1 步：定义 adapter（`adapter.js`）

```js
import { defineAdapter } from "./vendor/tdai-sdk/index.js";

export const adapter = defineAdapter({
  name: "acme",
  // payload: { user_input, reply, conversation_id }
  parseRecallPayload: (p) =>
    p?.user_input ? { query: p.user_input, sessionKey: p.conversation_id ?? "" } : null,
  parseCapturePayload: (p) =>
    p?.user_input || p?.reply
      ? { userContent: p.user_input ?? "", assistantContent: p.reply ?? "", sessionKey: p.conversation_id ?? "" }
      : null,
  formatRecallOutput: (context) =>
    JSON.stringify({ inject: `## Memory Context\n${context}` }),
  sessionKeyFrom: (p) => p?.conversation_id ?? "",
});
```

### 第 2 步：编写三个 hook shim（`scripts/*.js`）

```js
// scripts/health.js
import { TdaiGatewayClient, runHealthHook } from "../vendor/tdai-sdk/index.js";
await runHealthHook(new TdaiGatewayClient());

// scripts/recall.js
import { TdaiGatewayClient, runRecallHook } from "../vendor/tdai-sdk/index.js";
import { adapter } from "../adapter.js";
await runRecallHook(adapter, new TdaiGatewayClient());

// scripts/capture.js
import { TdaiGatewayClient, runCaptureHook } from "../vendor/tdai-sdk/index.js";
import { adapter } from "../adapter.js";
await runCaptureHook(adapter, new TdaiGatewayClient());
```

可选：`scripts/session-end.js` 调 `runSessionEndHook` 补齐 `/session/end`；
`mcp-bridge.js` 调 `createMcpBridge({ client }).start()` 暴露 MCP 搜索工具。

### 第 3 步：在宿主的 hook 配置中挂载

```jsonc
// 以 hooks.json 形态为例（各宿主格式不同，命令一致）
{
  "SessionStart":     "node ${PLUGIN_ROOT}/scripts/health.js",
  "UserPromptSubmit": "node ${PLUGIN_ROOT}/scripts/recall.js",
  "Stop":             "node ${PLUGIN_ROOT}/scripts/capture.js",
  "SessionEnd":       "node ${PLUGIN_ROOT}/scripts/session-end.js"
}
```

完成。数据处理、超时、认证、错误处理、日志全部由 SDK 承担。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TDAI_GATEWAY_URL` | `http://127.0.0.1:8420` | Gateway 地址 |
| `TDAI_GATEWAY_API_KEY` | （空 = 不认证） | 设置后所有请求附加 `Authorization: Bearer <key>` |
| `TDAI_GATEWAY_TIMEOUT_MS` | `12000` | 默认单请求超时 |
| `TDAI_SDK_DEBUG` | （关） | `1/true/yes/on` 时向 stderr 输出调试日志 |

也可在构造 `TdaiGatewayClient({ baseUrl, apiKey, timeoutMs, logger })` 时显式覆盖。

## 分发（vendor 拷贝）

插件目录独立分发且零依赖，因此 SDK 以 vendor 副本形式随插件提交：

```bash
npm run build:adapters   # 将 sdk/tdai-adapter-sdk/ 同步到各插件 vendor/tdai-sdk/
```

修改 SDK 源码后必须重新运行该命令，保持副本一致。

## 向后兼容

- Gateway wire format（snake_case）、hook 事件名、MCP 工具名与输出格式全部不变。
- `TDAI_GATEWAY_URL` 沿用；认证默认关闭（未设 apiKey 时不加认证头），与现有开放 Gateway 完全兼容。
