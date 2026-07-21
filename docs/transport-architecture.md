# Transport Layer Architecture | 传输层架构

> 将"如何调用 Gateway"从"适配器如何映射平台事件"中解耦。

## Design | 设计

```
Platform Adapter (Claude Code / Codex / MCP / Dify / REST / OpenCode)
        |
        v
  MemoryClient 接口 (transport independent)
        |
        ├── HttpMemoryClient ─── Gateway REST API ─── TdaiCore
        |
        └── InProcessMemoryClient ─── TdaiCore (direct)
```

## MemoryClient Interface | MemoryClient 接口

所有 transport 实现相同的合约：

| Method | Parameters | Returns | Description |
|:---|:---|:---|:---|
| `health()` | — | `HealthResponse` | 健康检查 |
| `recall()` | `RecallParams` | `RecallResponse` | 记忆召回 |
| `capture()` | `CaptureParams` | `CaptureResponse` | 对话捕获 |
| `searchMemories()` | `SearchMemoriesParams` | `SearchResponse` | 搜索 L1 记忆 |
| `searchConversations()` | `SearchConversationsParams` | `SearchResponse` | 搜索 L0 对话 |
| `endSession()` | `EndSessionParams` | `SessionEndResponse` | 刷新会话 |
| `getStatus()` | — | `MemoryClientStatus` | 传输层状态 |
| `close()` | — | `void \| Promise<void>` | 释放资源 |

## Transport Options | Transport 选择

### HTTP Transport（默认）

```ts
import { createMemoryClient } from "@tencentdb-agent-memory/memory-tencentdb";

const client = createMemoryClient({
  type: "http",
  options: { baseUrl: "http://127.0.0.1:8420" },
});
```

特性：重试 + 熔断器 + jitter，所有竞品均无。

### InProcess Transport

```ts
// 测试用途（注入 fake core）
const client = createMemoryClient({
  type: "in-process",
  options: { core: fakeCore },
});
```

## Error Model | 错误模型

统一 `MemoryClientError` 带稳定 `code` 字段：

| Code | HTTP 状态码 | 含义 |
|:---|:---|:---|
| `transport` | — | 网络/传输层错误 |
| `auth` | 401, 403 | 认证失败 |
| `bad_request` | 400-499 | 请求参数非法 |
| `unavailable` | — | 服务不可达或已关闭 |
| `timeout` | — | 请求超时 |

## Adapter Factory | 适配器工厂

通过环境变量切换 transport：

```bash
export TDAI_ADAPTER_TRANSPORT=http           # 默认
export TDAI_GATEWAY_URL=http://127.0.0.1:8420
export TDAI_GATEWAY_API_KEY=your-key
```

```ts
import { createMemoryClientFromEnv } from "@tencentdb-agent-memory/memory-tencentdb";

const client = createMemoryClientFromEnv();
// 自动选择 transport 类型，从环境变量读配置
```
