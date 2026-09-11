# 使用 Adapter SDK 接入新平台

当平台需要通过原生 Hook 或 Plugin 自动执行 recall、capture 或 session flush 时，使用 Adapter SDK。平台只需实现一个 `PlatformAdapter` 接口；SDK 提供 `AdapterRuntime`，统一处理 Gateway 调用、fail-open、操作去重、按会话串行和关闭等待。

MCP 与 Adapter SDK 解决不同问题。MCP 向兼容客户端暴露记忆工具；Adapter SDK 将确定性的平台生命周期事件映射到记忆能力。

## 区分四个边界

| 边界 | 职责 |
| --- | --- |
| `HostAdapter` | 为 `TdaiCore` 提供运行上下文、日志和 LLM 调用能力 |
| `MemoryClient` | 通过 Gateway 调用 recall、capture、search 和 session-end |
| `PlatformAdapter` | 将一个平台的原生生命周期映射到共享 runtime |
| MCP server | 将记忆能力暴露为模型可调用的协议工具 |

新平台通常只需实现 `PlatformAdapter`。只有当平台还要在自己的进程内运行 `TdaiCore` 时，才需要实现 `HostAdapter`。

## 实现一个平台接口

```ts
import {
  createAdapterRuntime,
  createGatewayMemoryClient,
  type AdapterRuntime,
  type PlatformAdapter,
} from "@tencentdb-agent-memory/memory-tencentdb/adapter-sdk";

interface ExampleHooks {
  beforePrompt(sessionId: string, prompt: string): Promise<string>;
  afterTurn(sessionId: string, turnId: string, user: string, assistant: string): Promise<void>;
  sessionEnd(sessionId: string): Promise<void>;
}

class ExampleAdapter implements PlatformAdapter<ExampleHooks> {
  readonly platform = "example";

  create(runtime: AdapterRuntime): ExampleHooks {
    return {
      beforePrompt: async (sessionId, prompt) => {
        const memory = await runtime.recall({ query: prompt, sessionKey: `example:${sessionId}` });
        return memory ? `<relevant-memories>\n${memory.context}\n</relevant-memories>\n${prompt}` : prompt;
      },
      afterTurn: async (sessionId, turnId, user, assistant) => {
        await runtime.capture({
          operationId: turnId,
          sessionKey: `example:${sessionId}`,
          sessionId,
          userContent: user,
          assistantContent: assistant,
        });
      },
      sessionEnd: async (sessionId) => {
        await runtime.endSession({ operationId: sessionId, sessionKey: `example:${sessionId}` });
      },
    };
  }
}

const adapter = new ExampleAdapter();
const hooks = adapter.create(createAdapterRuntime({
  platform: adapter.platform,
  client: createGatewayMemoryClient(),
}));
```

将 `hooks` 绑定到平台原生 Hook 或 Plugin API。SDK 不规定 Hook 名称和上下文注入格式，因为它们属于平台展示层职责。

## 使用稳定标识

- session key 使用平台名作为 namespace，例如 `example:<session-id>`。
- capture 的 `operationId` 使用稳定的 turn ID 或 message ID。
- session-end 的 `operationId` 使用稳定 session ID。
- 重试时保持相同 operation ID。

默认文件型 operation store 会阻止并发或已完成操作重复执行，并在失败后释放 claim 供后续重试。它写入 `~/.memory-tencentdb/adapter-sdk/<platform>`，使用受限文件权限，并自动恢复 stale claim。

## 将平台差异留在 Adapter 内

平台 Adapter 继续负责判断完整对话轮次、选择 recall 注入位置、提取可见文本，以及将 handlers 绑定到平台 SDK。

共享 runtime 负责记忆服务失败时 fail-open、忽略空 recall、capture 和 session-end 去重、串行执行传给 `runExclusive` 的任务，以及在 `dispose` 时等待队列中的任务。

已有 Adapter 如果已经管理跨进程 claim，可以注入 `ExternalAdapterOperationStore`，继续让原状态层作为唯一去重 owner。新 Adapter 应使用默认文件型 operation store。

Codex、Claude Code 和 OpenCode 的生命周期映射请查看[平台对比](platform-comparison_CN.md)。