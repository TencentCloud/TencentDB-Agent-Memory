# 平台适配指南

本文档说明如何把新的 Agent 平台接入 TencentDB Agent Memory。目标是把平台差异收敛到一个标准接口里，让后续新增平台只需要实现少量桥接代码，不需要理解或复制核心记忆 pipeline。

## 总体架构

多平台适配分为五层：

```text
平台运行时
  -> MemoryPlatformBridge
    -> MemoryPlatformAdapter
      -> MemoryGatewayClient
        -> TDAI Gateway
          -> TdaiCore
```

- `TdaiCore` 负责真正的记忆语义：召回、捕获、搜索、会话 flush，以及 L0 到 L3 的记忆 pipeline。
- `MemoryGatewayClient` 负责 Gateway HTTP 通信、鉴权、超时和响应字段映射。
- `MemoryPlatformAdapter` 负责通用平台 API，例如 `buildPromptContext()`、`capture()`、`searchMemories()`。
- `MemoryPlatformBridge` 是新平台唯一必须实现的接口。

OpenClaw 继续走进程内插件路径，因为它已有原生插件 API 和 embedded LLM runtime。Hermes、Codex、Dify 以及后续新平台默认走 Gateway 路径，避免把平台细节耦合进核心引擎。

## 核心引擎接口说明

`TdaiCore` 是宿主无关的核心入口，暴露以下能力：

| 方法 | 作用 | 现有平台映射 |
| --- | --- | --- |
| `handleBeforeRecall(userText, sessionKey)` | 模型调用前召回相关记忆 | OpenClaw `before_prompt_build`、Hermes `prefetch`、Gateway `POST /recall` |
| `handleTurnCommitted(turn)` | 捕获一轮完整对话，并触发 L0 到 L3 处理 | OpenClaw `agent_end`、Hermes `sync_turn`、Gateway `POST /capture` |
| `searchMemories(params)` | 搜索 L1 结构化记忆 | `tdai_memory_search`、Gateway `POST /search/memories` |
| `searchConversations(params)` | 搜索 L0 原始对话 | `tdai_conversation_search`、Gateway `POST /search/conversations` |
| `handleSessionEnd(sessionKey)` | flush 单个会话，不停止共享进程 | Gateway `POST /session/end`、Hermes session end |

核心层依赖 `HostAdapter`、`LLMRunnerFactory` 和 `RuntimeContext`。新平台通常不需要直接实现这些接口，Gateway 已经通过 `StandaloneHostAdapter` 封装好了宿主能力。

## 适配方式对比

| 平台 | 适配形态 | 召回注入点 | 捕获时机 | 会话标识 | 推荐方式 |
| --- | --- | --- | --- | --- | --- |
| OpenClaw | 进程内 `OpenClawHostAdapter` | 原生 hook 返回 `prependContext` / `appendSystemContext` | `agent_end` | `ctx.sessionKey` | 保持现有插件路径 |
| Hermes | Python provider + Node Gateway sidecar | `prefetch(query)` | `sync_turn()` 后台捕获 | Hermes `session_id` | 保持 Gateway HTTP 路径 |
| Codex | TypeScript SDK | `buildPromptContext(query)` | `recordTurn()` | `codex:<userId>:<sessionId>` | `CodexMemoryAdapter` |
| Dify | 工具 / 工作流 / 后端扩展 SDK | `buildPromptContext(query)` 填充 prompt 变量 | `recordDifyTurn()` | `dify:<appId>:<userId>:<conversationId>` | `DifyMemoryAdapter` |

## 新平台接入完整步骤

### 1. 启动或连接 Gateway

平台适配器通过 Gateway 访问核心引擎：

```bash
npx tsx src/gateway/server.ts
```

如果 Gateway 开启了 Bearer 鉴权，适配器侧需要传同一个 key：

```ts
const gateway = {
  baseUrl: "http://127.0.0.1:8420",
  apiKey: process.env.TDAI_GATEWAY_API_KEY,
};
```

### 2. 实现 `MemoryPlatformBridge`

新平台只需要实现运行时信息和可选的 turn 归一化：

```ts
import {
  createMemoryPlatformAdapter,
  type MemoryPlatformBridge,
  type MemoryTurnPayload,
} from "@tencentdb-agent-memory/memory-tencentdb";

class MyAgentBridge implements MemoryPlatformBridge {
  getRuntime() {
    return {
      platform: "my-agent",
      userId: "user-123",
      sessionId: "thread-456",
      sessionKey: "my-agent:user-123:thread-456",
      workspaceDir: process.cwd(),
    };
  }

  buildTurn(turn: MemoryTurnPayload): MemoryTurnPayload {
    return {
      ...turn,
      messages: turn.messages ?? [
        { role: "user", content: turn.userContent },
        { role: "assistant", content: turn.assistantContent },
      ],
    };
  }
}

const memory = createMemoryPlatformAdapter(new MyAgentBridge(), gateway);
```

`sessionKey` 必须稳定且带平台前缀。不要用随机值，也不要全平台共用一个 key。

### 3. 模型调用前注入召回上下文

```ts
const ctx = await memory.buildPromptContext(userQuery);

const systemPrompt = [
  baseSystemPrompt,
  ctx.appendSystemContext,
].filter(Boolean).join("\n\n");

const userPrompt = [
  ctx.prependUserContext,
  userQuery,
].filter(Boolean).join("\n\n");
```

`prependUserContext` 是每轮动态变化的 L1 召回片段，适合放在当前问题前。`appendSystemContext` 是相对稳定的 persona、scene navigation 和工具说明，适合放到 system 或 developer context。

### 4. 模型回答完成后捕获 turn

```ts
await memory.capture({
  userContent: userQuery,
  assistantContent: assistantAnswer,
  messages: transcriptMessages,
});
```

捕获时机应是 assistant 完整回答之后。不要把流式输出的中间 chunk 当成多轮对话分别写入，否则会污染 L0 和 L1。

### 5. 暴露可选搜索工具

```ts
const memories = await memory.searchMemories("用户部署偏好", 5);
const conversations = await memory.searchConversations("上周说过的原话", 5);
```

这些能力可以接到平台工具、工作流节点、后端调试接口或模型可调用工具上。

### 6. 会话结束时 flush

```ts
await memory.endSession();
```

`endSession()` 只 flush 当前会话，不会停止 Gateway。不要因为单个会话结束就关闭 Gateway，因为 Gateway 可能同时服务其他会话。

## 已新增平台示例

### Codex

```ts
import { createCodexMemoryAdapter } from "@tencentdb-agent-memory/memory-tencentdb";

const memory = createCodexMemoryAdapter({
  userId,
  sessionId,
  workspaceDir,
});

const ctx = await memory.buildPromptContext(query);

await memory.recordTurn({
  userContent: query,
  assistantContent: answer,
  messages,
});
```

Codex 默认 session key：

```text
codex:<userId>:<sessionId>
```

### Dify

```ts
import { createDifyMemoryAdapter } from "@tencentdb-agent-memory/memory-tencentdb";

const memory = createDifyMemoryAdapter({
  appId,
  userId,
  conversationId,
  query,
});

const ctx = await memory.buildPromptContext();

await memory.recordDifyTurn({
  query,
  answer,
  inputs,
});
```

Dify 默认 session key：

```text
dify:<appId>:<userId>:<conversationId>
```

Dify 的部署形态可能是工具、工作流节点或后端扩展。适配器不绑定某个 Dify runtime 包，只要求调用方提供 `appId`、`userId`、`conversationId`、`query`、`answer` 等上下文。优先使用稳定的 `conversationId`；没有时再退到 `workflowRunId` 或 `messageId`。

## 最佳实践

- `sessionKey` 必须带平台前缀，避免跨平台冲突。
- `userId` 必须能稳定代表同一个最终用户，避免长期画像漂移。
- `sessionId` 应代表一段完整对话，不应每条消息变化。
- `prependUserContext` 和 `appendSystemContext` 保持拆分，最后一步再按平台 prompt 槽位组装。
- 捕获完整 assistant 输出，不捕获流式中间片段。
- 尽量保留平台原始 metadata 到 `messages[].metadata`，便于后续排查。
- Gateway 如果绑定非 loopback 地址，应开启 `TDAI_GATEWAY_API_KEY`。
- recall 失败不应阻塞平台主流程；Gateway 短暂不可用时，平台可以无记忆继续回答。

## 常见踩坑点

| 问题 | 后果 | 处理方式 |
| --- | --- | --- |
| 每次请求随机生成 `sessionKey` | 同一会话的记忆无法累积 | 用 platform、user、conversation 派生稳定 key |
| 所有用户共用一个 `sessionKey` | 不同用户记忆串号 | `sessionKey` 必须包含 `userId` |
| 在 SDK 内提前合并召回上下文 | 影响 prompt cache，也削弱平台组装自由度 | 保持 `prependUserContext` / `appendSystemContext` 拆分 |
| 捕获流式 chunk | L0 片段化，L1 提取噪声变多 | 等完整回答结束后捕获一次 |
| 会话结束时停止 Gateway | 影响其他并发会话 | 调 `endSession()`，不要停进程 |
| 平台适配器直接调用 pipeline 内部模块 | 后续升级容易破坏 | 通过 `MemoryPlatformAdapter` 或 Gateway API |
| 没有配置 Gateway 鉴权就暴露到网络 | 记忆接口可被未授权访问 | 使用 loopback 绑定或配置 Bearer key |

## 验收清单

- 已说明 `TdaiCore` 的核心能力边界。
- 已对比 OpenClaw、Hermes、Codex、Dify 的适配方式。
- 新平台接入只需要实现 `MemoryPlatformBridge`。
- 文档包含 recall、capture、search、session flush 的完整代码示例。
- `sessionKey` 命名规则能避免跨平台和跨用户冲突。
- 已列出最佳实践和常见踩坑点。
- Codex / Dify 适配器有测试覆盖运行时推导和 Gateway payload 映射。
