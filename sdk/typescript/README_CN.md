# @tencentdb-agent-memory/memory-sdk-ts

**TencentDB Agent Memory v2 API** 的 TypeScript SDK。

## 安装

```bash
# 从 npm 安装（发布后）
npm install @tencentdb-agent-memory/memory-sdk-ts

# 从本地 .tgz 安装
npm install ./tencentdb-agent-memory-memory-sdk-0.1.0.tgz
```

## 快速开始

```typescript
import { MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts";

const client = new MemoryClient({
  endpoint: "http://127.0.0.1:8420",
  apiKey: "your-api-key",
  serviceId: "your-memory-space-id",
});

// L0: 添加对话
const result = await client.addConversation({
  session_id: "sess-1",
  messages: [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi!" },
  ],
});
console.log(result.accepted_ids);

// L1: 搜索结构化记忆
const hits = await client.searchAtomic({ query: "user preferences", limit: 5 });
console.log(hits.items);

// L1: 更新一条记忆
await client.updateAtomic({ id: "note-xxx", content: "updated content", background: "context" });

// L2: 列出场景文件
const scenarios = await client.listScenarios({ path_prefix: "" });
console.log(scenarios.entries);

// L2: 读取场景文件
const file = await client.readScenario({ path: "工作.md" });
console.log(file.content);

// L2: 更新场景文件（文件必须已存在）
await client.writeScenario({ path: "工作.md", content: "# Updated", summary: "new summary" });

// L3: 读取核心记忆（用户画像）
const core = await client.readCore();
console.log(core.content);

// L3: 写入核心记忆
await client.writeCore({ content: "# User Profile\n..." });

// Offload v2: 上报工具调用对，触发服务端 L1 异步处理（fire-and-forget）
await client.offloadIngest({
  session_id: "agent_sess_123",
  tool_pairs: [
    { tool_name: "search", tool_call_id: "call_1", params: { q: "..." }, result: "...", timestamp: "..." },
  ],
});

// Offload v2: 服务端上下文压缩（同步等待结果）
const compacted = await client.offloadCompact({
  session_id: "agent_sess_123",
  messages: [...],
  ratio: 0.7,
  context_window: 128000,
  total_tokens: 160000,
});
console.log(compacted.messages, compacted.report);

// 按压缩消息中的 result_ref 恢复归档工具结果
const ref = await client.offloadReadRef({
  session_id: "agent_sess_123",
  result_ref: "offload/agent_sess_123/refs/call_1.md",
  query: "相关片段",
  max_tokens: 800,
});
console.log(ref.content, ref.truncated);

// Offload v2: 查询任务流程图（MMD）
const mmd = await client.offloadQueryMmd({ session_id: "agent_sess_123", limit: 1 });
console.log(mmd.current_mmd, mmd.mmds);

// 读取记忆 pipeline 产物（如 persona.md、scene_blocks/*.md）
const raw = await client.readFile("scene_blocks/工作.md");
```

## API 方法

| 层级 | 方法 | 接口 |
|------|------|------|
| L0 | `addConversation()` | `POST /v2/conversation/add` |
| L0 | `queryConversation()` | `POST /v2/conversation/query` |
| L0 | `searchConversation()` | `POST /v2/conversation/search` |
| L0 | `deleteConversation()` | `POST /v2/conversation/delete` |
| L1 | `updateAtomic()` | `POST /v2/atomic/update` |
| L1 | `queryAtomic()` | `POST /v2/atomic/query` |
| L1 | `searchAtomic()` | `POST /v2/atomic/search` |
| L1 | `deleteAtomic()` | `POST /v2/atomic/delete` |
| L2 | `listScenarios()` | `POST /v2/scenario/ls` |
| L2 | `readScenario()` | `POST /v2/scenario/read` |
| L2 | `writeScenario()` | `POST /v2/scenario/write` |
| L2 | `rmScenario()` | `POST /v2/scenario/rm` |
| L3 | `readCore()` | `POST /v2/core/read` |
| L3 | `writeCore()` | `POST /v2/core/write` |
| Offload | `offloadIngest()` | `POST /v2/offload/ingest` |
| Offload | `offloadCompact()` | `POST /v2/offload/compact` |
| Offload | `offloadReadRef()` | `POST /v2/offload/read-ref` |
| Offload | `offloadQueryMmd()` | `POST /v2/offload/query-mmd` |

## 错误处理

所有非零 `code` 的响应会抛出 `TDAMError`：

```typescript
import { TDAMError } from "@tencentdb-agent-memory/memory-sdk-ts";

try {
  await client.readCore();
} catch (e) {
  if (e instanceof TDAMError) {
    console.error(`code=${e.code} message=${e.message} request_id=${e.requestId}`);
  }
}
```

## 构建与打包

```bash
# 构建
npm run build

# 打包为 .tgz 用于分发
npm pack
# → tencentdb-agent-memory-memory-sdk-0.1.0.tgz
```

## 许可证

MIT
