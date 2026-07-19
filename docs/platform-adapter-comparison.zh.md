# 平台适配器对比与接入规范

这份文档定义 TencentDB Agent Memory 的多平台接入边界。
新平台不应直接调用 `TdaiCore` 或 pipeline 内部实现，而应通过统一的适配器 SDK 接入。

完整适配指南见：[docs/platform-adapter-guide.zh.md](./platform-adapter-guide.zh.md)

## 统一边界

新平台只需要实现一个接口：

```ts
interface MemoryPlatformBridge {
  getRuntime(): {
    platform: string;
    userId: string;
    sessionId: string;
    sessionKey: string;
    workspaceDir: string;
  };

  buildTurn?(turn: {
    userContent: string;
    assistantContent: string;
    messages?: unknown[];
  }): {
    userContent: string;
    assistantContent: string;
    messages?: unknown[];
  };
}
```

SDK 负责其余部分：

- `MemoryGatewayClient`：统一 HTTP 传输层
- `MemoryPlatformAdapter`：召回、捕获、搜索、会话结束、种子导入
- 各平台适配器：只保留平台语义映射，不重复实现通用逻辑

目标分层如下：

```text
平台事件模型
  -> MemoryPlatformBridge
    -> MemoryPlatformAdapter
      -> MemoryGatewayClient
        -> TDAI Gateway
          -> TdaiCore
```

## 平台差异

| 平台 | 接入形态 | 召回注入点 | 捕获时机 | 会话标识 | 推荐路径 |
| --- | --- | --- | --- | --- | --- |
| OpenClaw | 进程内插件 | `before_prompt_build` 返回 `prependContext` / `appendSystemContext` | `agent_end` | 原生 `ctx.sessionKey` | 保持现有 `OpenClawHostAdapter` |
| Hermes | Python provider + Node Gateway sidecar | `prefetch(query)` 返回 memory context | `sync_turn()` 后台捕获 | Hermes `session_id` | 保持 Gateway HTTP 路径 |
| Codex | TypeScript SDK | `buildPromptContext(query)` 返回用户/系统上下文 | `recordTurn()` | `codex:<userId>:<sessionId>` | `CodexMemoryAdapter` |
| Dify | 工具 / 工作流 / 后端扩展 | `buildPromptContext(query)` 填充提示词变量 | `recordDifyTurn()` | `dify:<appId>:<userId>:<conversationId>` | `DifyMemoryAdapter` |

## 新平台需要提供什么

新增平台只需要回答四个问题：

1. 当前用户是谁
2. 当前会话是谁
3. 召回内容要注入到哪里
4. 完成的一轮对话何时可用于捕获

其余能力全部复用：

- HTTP 鉴权与超时
- Gateway 请求和响应映射
- 召回内容的动态/稳定分拆
- 捕获 payload 归一化
- 记忆搜索和对话搜索
- 会话 flush

## 运行时字段规范

| 字段 | 含义 | 约束 |
| --- | --- | --- |
| `platform` | 平台标识，如 `codex`、`dify` | 每个适配器固定 |
| `userId` | 最终用户标识 | 同一用户保持稳定 |
| `sessionId` | 平台会话 / 对话 / 运行标识 | 单次会话内稳定 |
| `sessionKey` | 记忆隔离 key | 必须带平台前缀，避免冲突 |
| `workspaceDir` | 本地工作区或数据上下文 | 无法获取时可退回 `process.cwd()` |

推荐的 sessionKey 形式：

```text
codex:<userId>:<sessionId>
dify:<appId>:<userId>:<conversationId>
claude-code:<userId>:<projectId>:<sessionId>
opencode:<userId>:<workspaceId>:<sessionId>
```

## 召回契约

Gateway 的 recall 响应同时返回旧字段和拆分字段：

```json
{
  "context": "...",
  "prepend_context": "...",
  "append_system_context": "..."
}
```

适配器应映射为：

- `prependUserContext`：动态 L1 记忆，放到当前问题前
- `appendSystemContext`：稳定 persona / scene / tool guide，放到 system 或 developer context

不要在 SDK 内提前合并这两个部分。不同平台的 prompt 槽位不同，保留拆分更利于 prompt cache 和后续扩展。

## Dify 接入说明

Dify 部署形态差异很大，可能是工具、工作流节点或后端扩展，因此适配器不绑定单一 Dify 运行时包。

推荐使用方式：

```ts
const memory = createDifyMemoryAdapter({
  appId,
  userId,
  conversationId,
  query,
});

const ctx = await memory.buildPromptContext();
// 将 ctx.prependUserContext / ctx.appendSystemContext 注入到 Dify 提示词变量中

await memory.recordDifyTurn({
  query,
  answer,
  inputs,
});
```

如果没有 `conversationId`，可以降级使用 `workflowRunId` 或 `messageId`。但如果要保证长期记忆质量，最好还是使用稳定的 conversation id。
