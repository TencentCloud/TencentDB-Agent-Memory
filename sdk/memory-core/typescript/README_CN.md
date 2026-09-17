# @tencentdb-agent-memory/memory-sdk-ts

**TencentDB Agent Memory** 的 TypeScript SDK，同时支持 v2 兼容 API 和 v3 严格 isolation API。

- 默认导出 `MemoryClient` 保持 v2 兼容，老代码无需修改。
- 新增 `@tencentdb-agent-memory/memory-sdk-ts/v3` 子路径，推荐新接入使用 v3。
- 根入口也导出 `V3MemoryClient`，方便在不使用子路径的场景下接入。

## 安装

```bash
# 从 npm 安装（发布后）
npm install @tencentdb-agent-memory/memory-sdk-ts

# 从本地 .tgz 安装
npm install ./tencentdb-agent-memory-memory-sdk-1.0.0.tgz
```

## 快速开始

### v3（推荐）

v3 与 v2 的主要差异：

- 请求路径从 `/v2/*` 升级为 `/v3/*`。
- 构造时要求 `teamId` / `agentId` / `userId` 三元组，避免写入或查询串到其它团队/Agent/用户。
- `sessionId` 可选：
  - 传入时，L0/L1 按单会话收敛；
  - 不传或 `withIsolation({ sessionId: null })` 时，L0/L1 按 `(team, agent, user)` 跨 session 聚合；
  - L2/L3 是 team+agent 级 profile，不消费 `sessionId`。
- Offload / COS 文件读取等非 L0-L3 能力仍使用 v2 客户端。

```typescript
import { MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts/v3";

const client = new MemoryClient({
  endpoint: "http://127.0.0.1:8420",
  apiKey: "your-gateway-api-key",
  serviceId: "your-memory-instance-id",
  teamId: "team-xxx",
  agentId: "agt-xxx",
  userId: "usr-xxx",
  sessionId: "sess-1",
});

// L0: 添加对话
const added = await client.addConversation({
  messages: [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi!" },
  ],
});
console.log(added.accepted_ids);

// L0: 查询当前 session 的原始对话
const l0 = await client.queryConversation({ limit: 20, offset: 0 });
console.log(l0.messages, l0.total);

// L0: 跨 session 聚合查询当前 agent/user 的全部对话
const allL0 = await client.withIsolation({ sessionId: null }).queryConversation({ limit: 20 });
console.log(allL0.total);

// L1: 搜索结构化记忆
const hits = await client.searchAtomic({ query: "user preferences", limit: 5 });
console.log(hits.items);

// L2: 读取场景文件
const scene = await client.readScenario({ path: "工作.md" });
console.log(scene.content);

// L3: 读取核心记忆
const core = await client.readCore();
console.log(core.content);
```

如果不能使用子路径，也可以从根入口导入：

```typescript
import { V3MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts";
```

### v2（兼容）

```typescript
import { MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts";

const client = new MemoryClient({
  endpoint: "http://127.0.0.1:8420",
  apiKey: "your-gateway-api-key",
  serviceId: "your-memory-instance-id",
});

await client.addConversation({
  session_id: "sess-1",
  messages: [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi!" },
  ],
});
```

## API 方法

### v3 数据面

| 层级 | 方法 | 接口 |
|------|------|------|
| L0 | `addConversation()` | `POST /v3/conversation/add` |
| L0 | `queryConversation()` | `POST /v3/conversation/query` |
| L0 | `searchConversation()` | `POST /v3/conversation/search` |
| L0 | `deleteConversation()` | `POST /v3/conversation/delete` |
| L0 | `countConversation()` | `POST /v3/conversation/count` |
| L1 | `updateAtomic()` | `POST /v3/atomic/update` |
| L1 | `queryAtomic()` | `POST /v3/atomic/query` |
| L1 | `searchAtomic()` | `POST /v3/atomic/search` |
| L1 | `deleteAtomic()` | `POST /v3/atomic/delete` |
| L1 | `countAtomic()` | `POST /v3/atomic/count` |
| L2 | `listScenarios()` | `POST /v3/scenario/ls` |
| L2 | `readScenario()` | `POST /v3/scenario/read` |
| L2 | `writeScenario()` | `POST /v3/scenario/write` |
| L2 | `rmScenario()` | `POST /v3/scenario/rm` |
| L2 | `countScenario()` | `POST /v3/scenario/count` |
| L3 | `readCore()` | `POST /v3/core/read` |
| L3 | `writeCore()` | `POST /v3/core/write` |
| L3 | `countCore()` | `POST /v3/core/count` |
| 资产 | `clearChatMemory()` | `POST /v3/chat-memory/clear` |

#### 批量删除与清空

`deleteConversation()`（L0）与`deleteAtomic()`（L1）支持批量：

```ts
// L0：按消息 id 批量删除（≤5000）
await client.deleteConversation({ message_ids: ["m1", "m2"] });

// L0：按会话批量清空（≤100），两者可同时给
await client.deleteConversation({ session_ids: ["s1", "s2"] });

// L1：按笔记 id 批量删除（≤5000）
await client.deleteAtomic({ ids: ["a1", "a2"] });
```

> **注意**：删除路径**不会**回退到构造函数里的 `session_id`。
> 只想按`message_ids` 删几条消息时，不会意外把整个会话删掉；
> 要清空会话必须显式传 `session_ids`。

`clearChatMemory()` 是**资产级**操作，一键清空 memory 全部内容但保留资产：

```ts
const res = await client.clearChatMemory({ memory_ids: ["chat_memory-t1-agt1"] });
if (!res.all_cleared) {
  // 失败项带 retryable 标志；true 表示服务端已自动重试仍失败，稍后可再试
  const retryable = res.items.filter((i) => !i.cleared && i.retryable);
}
```

- 清空 L0/L1/L2/L3 + 向量 + 文件；保留 `memory_id`、Agent 绑定、ACL、Owner、可见性
- 清空后 Agent 继续用原 `memory_id` 写入，无需重建
- 任一 `memory_id` 不存在或不是 chat_memory 时**整批拒绝**；重复调用幂等
- 权限：与其它删除接口一致，内核不做用户级鉴权。需要「仅 Owner 可清空」请走面板后端 `/api/v1/chat-memory/clear`

### v2 兼容数据面

| 层级 | 方法 | 接口 |
|------|------|------|
| L0 | `addConversation()` | `POST /v2/conversation/add` |
| L0 | `queryConversation()` | `POST /v2/conversation/query` |
| L0 | `searchConversation()` | `POST /v2/conversation/search` |
| L0 | `deleteConversation()` | `POST /v2/conversation/delete` |
| L0 | `countConversation()` | `POST /v2/conversation/count` |
| L1 | `updateAtomic()` | `POST /v2/atomic/update` |
| L1 | `queryAtomic()` | `POST /v2/atomic/query` |
| L1 | `searchAtomic()` | `POST /v2/atomic/search` |
| L1 | `deleteAtomic()` | `POST /v2/atomic/delete` |
| L1 | `countAtomic()` | `POST /v2/atomic/count` |
| L2 | `listScenarios()` | `POST /v2/scenario/ls` |
| L2 | `readScenario()` | `POST /v2/scenario/read` |
| L2 | `writeScenario()` | `POST /v2/scenario/write` |
| L2 | `rmScenario()` | `POST /v2/scenario/rm` |
| L2 | `countScenario()` | `POST /v2/scenario/count` |
| L3 | `readCore()` | `POST /v2/core/read` |
| L3 | `writeCore()` | `POST /v2/core/write` |
| L3 | `countCore()` | `POST /v3/core/count` |
| Offload | `offloadIngest()` | `POST /v2/offload/ingest` |
| Offload | `offloadCompact()` | `POST /v2/offload/compact` |
| Offload | `offloadQueryMmd()` | `POST /v2/offload/query-mmd` |

## 自定义 Prompt 与生成溯源

```typescript
import { MemoryGenerationLogClient, MemoryPromptClient } from "@tencentdb-agent-memory/memory-sdk-ts";

const config = { endpoint: "https://memory.example.com", apiKey: "<token>", serviceId: "instance-1" };
const prompts = new MemoryPromptClient({ ...config, teamId: "team-1", agentId: "agent-1" });
const created = await prompts.create({ name: "决策抽取", layer: "l1", prompt: "重点提取明确决策。" });
await prompts.apply({ memory_prompt_id: created.memory_prompt_id, layer: "l1", agent_ids: ["agent-1"] });
const effective = await prompts.getEffective({ layer: "l1" });
const settings = await prompts.listSettings({ memory_prompt_id: created.memory_prompt_id, layer: "l1" });

const logs = new MemoryGenerationLogClient(config);
const provenance = await logs.getByMemoryId("memory-id", "l1");
```

| SDK 方法 | 接口 | 说明 |
|----------|------|------|
| `create()` | `POST /v3/memory-prompt/create` | 创建 Prompt |
| `get()` / `list()` / `getEffective()` | `GET /v3/memory-prompt/get` | 查详情、列表或最终生效 Prompt |
| `update()` | `POST /v3/memory-prompt/update` | 更新名称/内容；相同值为幂等 no-op |
| `delete()` | `POST /v3/memory-prompt/delete` | 批量删除 Prompt 并清理其绑定 |
| `apply()` / `clear()` | `POST /v3/memory-prompt/set` | 应用、替换或清除目标绑定 |
| `listSettings()` | `GET /v3/memory-prompt/setting/list` | 按 Prompt、目标或 Layer 查询当前绑定 |
| `listSettingLogs()` | `GET /v3/memory-prompt/log` | 查询不可变的绑定变更日志 |
| `MemoryGenerationLogClient.list()` | `GET /v3/memory-generation-log/list` | 按 Layer/时间分页查询生成日志 |
| `get()` / `getByMemoryId()` | `GET /v3/memory-generation-log/get` | 按日志 ID 或 Memory ID + Layer 查询溯源 |

`listSettings()` 不传筛选条件时列出当前 Instance 的全部绑定；传 `memory_prompt_id` 可反向查询该 Prompt 绑定到哪些目标。传 `agent_id` 时必须同时传 `team_id`。

## MetadataClient（v3 管理面）

`MetadataClient` 封装内核网关的 v3 元数据管理面接口（`/v3/meta/*` 54 条，与 Panel `META_ACTIONS` 对齐，含 `user-key/*`），以及 `/v3/knowledge/*` Knowledge CRUD（5 条）。鉴权用 Bearer + `x-tdai-service-id`，可选 `x-tdai-user-key`。

```typescript
import { MetadataClient } from "@tencentdb-agent-memory/memory-sdk-ts";

const meta = new MetadataClient({
  endpoint: "http://127.0.0.1:8420",
  apiKey: process.env.KERNEL_AUTH_TOKEN!,  // 网关 Bearer，勿硬编码
  serviceId: "knowledge-debug",  // x-tdai-service-id
  // userKey: "...",             // 可选；user/create、user/delete 等 system_admin 接口需要
});
```

### Knowledge 管理（/v3/knowledge/*）

管理 Knowledge 实体元数据（`wiki` / `code-graph` 两种类型）。注意：这组接口是**管理面 CRUD**，只管元数据；真正去 wiki/code-graph 里搜内容、读页面、同步仓库是 Knowledge Service 数据面的活，不在这个 client 里。

| 方法 | 接口 | 说明 |
|------|------|------|
| `createKnowledge()` | `POST /v3/knowledge/create` | upsert 元数据（幂等，重复 post 即覆盖） |
| `getKnowledge(id, teamId?)` | `POST /v3/knowledge/get` | 单条查询 |
| `updateKnowledge()` | `POST /v3/knowledge/update` | 部分更新（name/summary/service_url/repo_url/branch） |
| `deleteKnowledge(ids, teamId?)` | `POST /v3/knowledge/delete` | 批量删除（≤100） |
| `listKnowledge()` | `POST /v3/knowledge/list` | 按 team_id 列出，可选 type 过滤 / 按 id 批查明细 |

```typescript
// 登记一个 wiki 知识源
const k = await meta.createKnowledge({
  knowledge_id: "wiki-docs",
  type: "wiki",
  service_url: "http://127.0.0.1:8421/v3",  // Knowledge Service 数据面地址
  name: "团队文档 Wiki",
  summary: "内部技术文档",
  team_id: "team-1",
  user_id: "usr-1",
});
console.log(k.knowledge_id, k.type, k.created_at);

// 列出某团队下的全部 code-graph
const list = await meta.listKnowledge({ team_id: "team-1", type: "code-graph" });
console.log(list.items, list.total);

// 改名 / 换 service_url
await meta.updateKnowledge({ knowledge_id: "wiki-docs", name: "改名后的 Wiki" });

// 批量删除
await meta.deleteKnowledge(["wiki-docs", "cg-repo-1"], "team-1");
```

返回类型：`KnowledgeEntity` / `KnowledgeListResult { items, total }` / `BatchDeleteResult { deleted_ids, failed }`。

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
npm run build
npm test
npm pack
```

## 许可证

MIT
