# SessionStore、Injection Hook Cache 与 KV/Prompt Cache 解析

## 1. 文档目的

本文统一说明请求链路中的三类缓存：

1. `SessionStore L1 / L2a / L2b`：保存 Session Init 状态和 Team/Agent/Task 绑定；
2. `Injection Hook Cache`：保存已经计算好的注入块 `ContextBlock[]`；
3. `KV Cache / Prompt Cache`：由上游模型推理服务保存 Prompt 前缀对应的模型中间状态。

这三类缓存处在不同层次，不能混为一谈：

```text
SessionStore
  解决“这个 Session 是谁、初始化到哪一步、绑定了哪些 Agent/Task”

Injection Hook Cache
  解决“本次应该注入哪些 Skill/Knowledge/Memory/Tools 文本块”

KV/Prompt Cache
  解决“上游模型是否需要重新计算相同 Prompt 前缀的注意力状态”
```

它们也不同于业务上的 `L0/L1/L2/L3/L4` 分层记忆。SessionStore 的 L1/L2a/L2b 是缓存与恢复层级，不是记忆等级。

---

## 2. 总体链路

```text
客户端请求
   │
   ├─ 1. Session Init / Recovery
   │      L1 → L2a → L2b → 历史消息扫描
   │      得到 SessionInfo、AgentDetail、TaskDetail、bypassed
   │
   ├─ 2. Session Context 处理
   │      strip 旧 <session_context>
   │      根据当前 SessionStore 状态重新 inject
   │
   ├─ 3. Injection Pipeline
   │      Hook Cache hit → 使用预热 ContextBlock[]
   │      Hook Cache miss → hook.execute() → 可选 self-heal 回写
   │
   ├─ 4. Adapter serialize
   │      重新生成 OpenAI / Anthropic / Codex 请求体
   │      Anthropic 尽量保留 cache_control
   │
   └─ 5. 上游模型
          根据最终 Prompt 前缀和缓存断点判断 KV/Prompt Cache 命中
```

三种缓存之间的依赖关系是：

```text
SessionStore 稳定
    ↓
Session Context 稳定
    ↓
Hook Cache 输出稳定
    ↓
最终序列化 Prompt 前缀稳定
    ↓
上游 KV/Prompt Cache 才可能命中
```

Hook Cache 命中不等于 KV Cache 命中。它只能减少注入侧查询，并提高最终 Prompt 字节稳定性。

---

# 第一部分：SessionStore L1 / L2a / L2b

## 3. 三层定位

| 层级 | 介质 | 保存内容 | 核心能力 |
|---|---|---|---|
| L1 | 当前 Node.js 进程的 `Map` | 完整 `SessionInitState` | 当前 Pod 零 IO 快速读取 |
| L2a | SQLite / Redis / ProxyStorage | 完整 `SessionInitState` | 重启恢复、跨 Pod、初始化中间态恢复 |
| L2b | Redis Hash / ProxyStorage `nottl` | 精简 `SessionBinding` | L2a 过期后的长期恢复、Bridge 身份反查 |

源码入口：[`MemoryProxy/src/session/store.ts`](../MemoryProxy/src/session/store.ts)。

## 4. L1：进程内热缓存

### 4.1 缓存介质与 Key

L1 使用两个进程内 `Map`：

```ts
private states = new Map<string, SessionInitState>();
private identities = new Map<string, SessionIdentity>();
```

`states` 的 Key 约定为：

```text
<agentSource>:<sessionId>
```

完整的 `spaceId/userId/agentSource/sessionId` 身份由 `identities` 单独保存，用于路由 L2a/L2b 写入。

### 4.2 缓存内容

L1 保存完整 `SessionInitState`：

- 状态机：`status`、`startedAt`、`attemptCount`；
- 初始化候选：`cachedTeams`；
- 用户选择：`selectedTeamId`、`selectedAgentId`；
- 分页状态：`agentPageIndex`、`codexPageIndex`；
- 注册结果：`sessionInfo`；
- 注入依据：`agentDetail`、`taskDetail`；
- 跳过标记：`bypassed`。

类型定义：[`MemoryProxy/src/session/types.ts`](../MemoryProxy/src/session/types.ts)。

### 4.3 命中行为

`initialized` 是终态，L1 命中后直接返回，后续读取为纯内存、零外部 IO。

`pending_*` 不是跨 Pod 场景下的权威状态。即使本 Pod 的 L1 命中，也会继续查询 L2a，因为其他 Pod 可能已经推进了初始化状态机。

```text
L1 initialized hit → 直接使用
L1 pending hit     → 查询 L2a
L2a hit            → 用 L2a 覆盖旧 L1
L2a miss/error     → 回退使用尚未过期的 pending L1
```

### 4.4 TTL 与边界

- 默认 pending TTL：30 分钟；
- 只有非 `initialized` 状态会按 `startedAt` 过期；
- `initialized` 和 `initialized+bypassed` 不受 L1 TTL 限制；
- 进程重启后全部 L1 消失；
- 不同 Pod 的 L1 不共享；
- 终态没有容量/时间淘汰，长时间运行可能造成 Map 持续增长；
- L1 中的 Agent/Task Detail 不会自动感知控制面更新，需要刷新机制。

## 5. L2a：完整 SessionInitState 持久层

### 5.1 Key 与内容

L2a 通过 `SessionRepo` 保存完整 `SessionInitState`，身份 Key 为：

```text
<spaceId>:<userId>:<agentSource>:<sessionId>
```

它不仅保存最终绑定，还保存 `pending_*`、候选 Team、分页位置等初始化中间态。因此 L2a 可以让初始化表单从另一个 Pod 继续执行。

接口定义：[`MemoryProxy/src/db/sessionRepo.ts`](../MemoryProxy/src/db/sessionRepo.ts)。

### 5.2 写入语义

每次 `await store.set(keyId, state)`：

1. 立即更新 L1；
2. `await repo.upsert(...)` 写 L2a；
3. 若已进入 `initialized`，继续写 L2b。

L2a 使用 awaited write-through。其目的不是单纯持久化，而是保证 Pod A 返回表单前，共享状态已经可被 Pod B 读取。

底层错误通常被捕获并降级，不阻断主请求。因此 L2a 故障时单 Pod 仍可能依赖 L1 工作，但跨 Pod 连续性不再有保证。

### 5.3 SQLiteSessionRepo

SQLite 表保存：

- `status`、`agent_id`、`task_id`、`user_id`；
- `agent_detail_json`、`task_detail_json`、`session_info_json`；
- 完整 `state_json`；
- `created_at`、`updated_at`。

特点：

- 适合单机进程重启恢复；
- 没有数据库级 TTL；
- stale pending 在读取时由 SessionStore 判断并删除；
- 各 Pod 使用本地 SQLite 时不能提供共享状态。

### 5.4 RedisSessionRepo

Redis Key：

```text
inj:sess:<spaceId>:<userId>:<agentSource>:<sessionId>
```

Value 是完整 `SessionInitState` JSON，使用 `SETEX` 写入。

- 默认 TTL：1800 秒；
- 可由 `redis.injectionTtlSeconds` 覆盖；
- 每次写入重新设置 TTL；
- pending 和 initialized 都受 Redis TTL 影响；
- 到期后需要 L2b 承担长期恢复。

实现：[`MemoryProxy/src/db/redis-session-repo.ts`](../MemoryProxy/src/db/redis-session-repo.ts)。

### 5.5 KvSessionRepo / ProxyStorage

对象 Key：

```text
ttl/<spaceId>/<userId>/<agentSource>/<sessionId>/inj-sess.json
```

ProxyStorage 可以使用 COS、SQLiteStorage、FsStorage 或 MemoryStorage。

- 默认 `storage.ttlDays=7`；
- `ttl/` 对象允许生命周期清理；
- 更新对象会刷新修改时间；
- COS 不在进程启动时全量扫描 Session，而是按请求懒加载；
- COS/共享后端可以支撑多 Pod；
- 本地 FS、SQLite、Memory 后端不能天然支撑跨 Pod。

实现：[`MemoryProxy/src/db/kv-session-repo.ts`](../MemoryProxy/src/db/kv-session-repo.ts)。

### 5.6 L2a 的主要功能

- 恢复完整初始化状态机；
- 支持多 Pod 间继续多轮表单；
- 进程重启后恢复已初始化会话；
- 命中后直接获得 `agentDetail/taskDetail`，避免 Metadata API 查询；
- 将状态提升回 L1，为后续请求建立零 IO 快路径。

## 6. L2b：长期精简 Binding

### 6.1 保存内容

L2b 对应 `SessionBinding`：

```ts
interface SessionBinding {
  outcome: "initialized" | "bypassed";
  userId?: string;
  teamId?: string;
  agentId?: string;
  taskId?: string;
  agentSource?: string;
  userKey?: string;
}
```

它不保存：

- pending 状态；
- `cachedTeams`；
- 分页位置；
- 完整 `AgentDetail/TaskDetail`。

定义：[`MemoryProxy/src/db/binding-repo.ts`](../MemoryProxy/src/db/binding-repo.ts)。

### 6.2 Key 设计

L2b 使用拍平 Key：

```text
<spaceId> + <sessionId>
```

Memory/Skill Bridge 通常只能拿到 `spaceId/sessionId`，无法提前得到 `userId/agentSource`，所以后两者被放进 Value 中。

### 6.3 RedisBindingRepo

Key：

```text
inj:binding:<spaceId>:<sessionId>
```

使用 Redis Hash 保存绑定字段及 `created_at/last_seen`。

- 默认 TTL：30 天；
- L2b 命中后异步 `touchLastSeen` 并刷新 TTL；
- 属于滚动 30 天缓存，不是永久存储。

### 6.4 KvBindingRepo

Key：

```text
nottl/<spaceId>/<sessionId>/binding.json
```

`nottl/` 不受 ProxyStorage TTL 生命周期清理。对于持久化 COS/SQLite/FS，绑定会保留到显式删除；若底层是 MemoryStorage，进程退出后仍会丢失。

实现：[`MemoryProxy/src/db/kv-binding-repo.ts`](../MemoryProxy/src/db/kv-binding-repo.ts)。

### 6.5 恢复行为

L2b 命中 `bypassed` 时，直接构造 `initialized+bypassed`，避免老会话重新弹表单。

L2b 命中 `initialized` 时：

1. 根据 `agentId/taskId` 查询 Metadata API；
2. 获得较新的 Agent/Task Detail；
3. 重建完整 `SessionInitState`；
4. 回填 L1 和 L2a。

因此 L2b 是“可重建终态的最小索引”，而不是完整 Session 快照。

### 6.6 L2b 的边界

- 无法恢复初始化进行到哪一步；
- 命中后需要 Metadata API，延迟高于 L1/L2a；
- Metadata API 不可用时可能无法重建；
- `userKey` 会进入长期 Binding，需要访问控制、加密和日志脱敏；
- Key 设计依赖同一 `spaceId` 内 `sessionId` 唯一。

## 7. SessionStore 后端启用顺序

```text
storage.enabled=true
  → KvSessionRepo + KvBindingRepo

否则 redis.enabled=true
  → RedisSessionRepo + RedisBindingRepo

否则
  → 默认 SqliteSessionRepo
  → 通常没有 L2b，miss 后转历史扫描
```

装配代码：[`MemoryProxy/src/injection/index.ts`](../MemoryProxy/src/injection/index.ts)。

---

# 第二部分：Injection Hook Cache

## 8. Hook Cache 是什么

Injection Hook Cache 是 Proxy 应用层缓存，保存某个注入 Hook 已经生成好的协议无关内容块：

```ts
interface HookCacheEntry {
  hookId: string;
  blocks: ContextBlock[];
}
```

`ContextBlock` 包含：

```ts
{
  type: "text" | "custom" | "tool_use" | ...,
  content: string,
  metadata?: Record<string, unknown>
}
```

它缓存的是“准备注入 Prompt/Tools 的内容”，不是模型 attention KV，也不是 Session 初始化状态。

接口：[`MemoryProxy/src/db/hookCacheRepo.ts`](../MemoryProxy/src/db/hookCacheRepo.ts)。

## 9. Hook Cache 的 Key 与隔离

逻辑 Key 是：

```text
spaceId + userId + agentSource + sessionId + hookId
```

作用分别是：

- `spaceId`：内存实例/租户隔离；
- `userId`：用户权限隔离；
- `agentSource`：Claude Code、CodeBuddy、Codex 等客户端隔离；
- `sessionId`：对话隔离；
- `hookId`：不同注入器隔离。

## 10. 缓存哪些 Hook 内容

当前声明 `cacheStrategy="session_init"` 的典型 Hook 包括：

- `skill-injector`：Skill catalog/内容；
- `skill-tools-injector`：Skill 工具定义；
- `knowledge-tools-injector`：Knowledge/CodeGraph 等工具和目录；
- `tdai-tools-injector`：记忆按需检索工具；
- `tdai-profile-memory-injector`：Session 稳定的 Profile、L2/L3 等长期记忆快照。

`asset-reflection-injector` 使用 `cacheStrategy="none"`，因为它依赖当前请求 URL marker，不能只在初始化时计算一次。

具体启用哪些 Hook 仍取决于配置中的 `injection.injectors` 和各能力开关。

## 11. 三种 Hook 缓存策略

定义见 [`MemoryProxy/src/injection/types.ts`](../MemoryProxy/src/injection/types.ts)。

### 11.1 `none`

```text
每个请求 → hook.execute(ctx) → 直接注入
```

- 不读取 Hook Cache；
- 不预热；
- 适合强依赖当前请求的动态内容；
- 每轮结果可能变化，可能降低上游 Prompt Cache 命中。

### 11.2 `session_init`

```text
Session Init 完成 → hook.prewarm() → HookCacheRepo
后续请求       → HookCacheRepo.get() → 跳过 execute()
```

Cache miss 时存在安全兜底：

```text
miss → hook.execute(ctx) → 返回 fresh blocks
                       └→ 非 readOnly 请求 self-heal put
```

FORK/只读请求在 miss 时不会 self-heal，避免 Fork 计算出的内容覆盖 Main 对话的稳定缓存。

### 11.3 `hybrid`

```text
cached blocks + 每轮 execute() fresh blocks
             ↓
按 metadata.cacheKey 或 type+content 去重合并
```

顺序是 cached 在前、fresh 在后。

适合“稳定资产 + 每轮动态结果”组合，但动态部分仍会改变最终 Prompt，因此不天然保证 KV Cache 命中。

路由实现：[`MemoryProxy/src/injection/pipeline.ts`](../MemoryProxy/src/injection/pipeline.ts)。

## 12. Hook Cache 的创建与刷新时机

### 12.1 Session Init 完成后预热

当 Session 刚注册完成或从 L2b 重建，并满足以下条件时执行预热：

- 没有 bypass；
- 有 `sessionInfo`；
- `injection.enabled=true`；
- 至少启用一个 injector。

`prewarmAll` 并行运行所有 `session_init/hybrid` Hook，默认总超时 20 秒。单 Hook 失败或超时只跳过对应缓存，不阻断整个业务链路。

实现：[`MemoryProxy/src/injection/prewarm.ts`](../MemoryProxy/src/injection/prewarm.ts)。

### 12.2 `mem:sync` 主动刷新

`mem:sync` 会：

1. 重新拉取 Agent/Task Detail；
2. 覆写 SessionStore；
3. 清除当前 Session 的旧 Hook Cache；
4. 重新运行所有可预热 Hook；
5. 将新块写入 HookCacheRepo。

刷新时使用 `clearBefore=true`，避免已解绑资产对应的旧缓存无限残留。

实现：[`MemoryProxy/src/mem-command/commands/sync.ts`](../MemoryProxy/src/mem-command/commands/sync.ts)。

## 13. Hook Cache 后端

### 13.1 SQLiteHookCacheRepo

表主键：

```text
(session_id, hook_id)
```

其中 `session_id` 是四段复合身份，Value 为 `blocks_json`。

- 适合单机；
- 没有显式 TTL；
- Session 清理时可以按 Session 删除；
- 多 Pod 本地 SQLite 不共享。

### 13.2 RedisHookCacheRepo

Redis Key：

```text
inj:hook:<spaceId>:<userId>:<agentSource>:<sessionId>
```

Redis Hash：

```text
field = hookId
value = ContextBlock[] JSON
```

- 默认 TTL 30 分钟；
- 使用与 injection/session 相同的 `injectionTtlSeconds` 配置；
- `put/putMany` 后刷新整个 Hash 的 TTL；
- 适合多 Pod 共享。

实现：[`MemoryProxy/src/db/redis-hook-cache-repo.ts`](../MemoryProxy/src/db/redis-hook-cache-repo.ts)。

### 13.3 KvHookCacheRepo

对象 Key：

```text
ttl/<spaceId>/<userId>/<agentSource>/<sessionId>/inj-hook/<hookId>.json
```

- 使用 ProxyStorage；
- 受 `storage.ttlDays` 生命周期控制；
- 一个 Hook 对应一个 JSON 对象；
- `putMany` 会产生 N 个并发 PUT；
- `getAllForSession` 是一次 LIST 加 N 次 GET；
- Hook 数量通常为 3～5 个，规模较小时可接受；
- Hook 数量扩大后可能出现 COS QPS/延迟放大。

实现：[`MemoryProxy/src/db/kv-hook-cache-repo.ts`](../MemoryProxy/src/db/kv-hook-cache-repo.ts)。

## 14. Hook Cache 的收益与边界

收益：

- 避免每轮调用 Core、Metadata、COS、Knowledge/Memory 服务；
- 降低注入阶段延迟；
- 降低外部服务 QPS；
- 同一 Session 使用相同缓存块，提升 Prompt 字节稳定性；
- 为上游 KV/Prompt Cache 创造更好的命中条件。

边界：

- 缓存命中不表示上游模型缓存命中；
- Session 级快照会降低资产和记忆新鲜度；
- `session_init` 内容不会自动刷新，主要依赖 `mem:sync`、TTL 或重新建 Session；
- 写入是 best-effort，部分 Repo 方法是 fire-and-forget；
- Cache miss 会增加一次 Repo GET 后再执行 Hook；
- KV/COS 后端按 Hook 分对象会放大请求数；
- `hybrid` 的动态块可能导致最终 Prompt 每轮变化。

---

# 第三部分：KV Cache / Prompt Cache

## 15. KV Cache 与 Prompt Cache 的含义

模型推理时，每个 Prompt Token 都会产生 Transformer Attention 的 Key/Value 中间状态。相同 Prompt 前缀再次出现时，上游推理服务可以复用这些状态，避免重新执行完整 prefill。

工程上常见两种名称：

- `KV Cache`：强调模型运行时保存的 Attention K/V 张量；
- `Prompt Cache`：强调 API/服务根据 Prompt 前缀提供的缓存能力和计费指标。

在本项目中，它们不由 `SessionStore`、`HookCacheRepo` 或 ProxyStorage 保存。本项目只负责尽量生成稳定的请求前缀并保留缓存标记，真正的模型 KV 状态由上游服务维护。

## 16. Prompt Cache 的命中条件

可概括为：

```text
模型与关键推理参数兼容
+ 缓存断点之前的 Prompt 内容相同
+ system/messages/tools 顺序相同
+ 结构化字段和 cache_control 位置稳定
+ 上游缓存尚未过期或被淘汰
= 可能命中
```

以下变化通常会导致某个断点之后重新计算：

- Agent Prompt 或 Task Goal 改变；
- 注入块文本、空格、顺序改变；
- Tool 描述或 JSON Schema 改变；
- Hook 执行顺序改变；
- system block 被合并、拆分或重排；
- `cache_control` marker 被删除或移动；
- 动态记忆被插入缓存前缀内部；
- 模型或影响缓存隔离的参数改变。

注意：语义相同但字节/结构不同，也可能无法命中。

## 17. Anthropic 显式 Prompt Cache

Anthropic 请求可以在 content block 或 tool 上携带 `cache_control`。

项目中的 `AnthropicAdapter` 会在 parse/serialize 往返中保存：

- content block 的 `cache_control`；
- tool 的 `cache_control`。

实现：[`MemoryProxy/src/injection/adapters/anthropic.ts`](../MemoryProxy/src/injection/adapters/anthropic.ts)。

Session Context 注入对 Anthropic system 数组的策略是：

- 保留原有 block 结构及已有 `cache_control`；
- 在已有缓存断点之后追加普通 Session Context block；
- 不擅自给新增 block 添加第二个断点。

这样原客户端前缀仍有机会复用，但新增 Agent/Task Session Context 通常位于原断点之外，需要正常计算。

实现：[`MemoryProxy/src/session/context-injector.ts`](../MemoryProxy/src/session/context-injector.ts)。

## 18. OpenAI/Codex 兼容请求

OpenAI 协议路径没有在本项目中显式管理 `cache_control`。是否启用 Prompt Cache、如何匹配和计费由具体上游服务决定。

Proxy 能控制的是：

- system/developer 内容是否稳定；
- messages 顺序是否稳定；
- tools 数组和 Schema 是否稳定；
- 每轮注入是否放在适当位置；
- 是否避免把实时记忆放到稳定长前缀中。

因此即使没有显式断点，稳定前缀仍可能让支持隐式 Prompt Cache 的上游获益，但不能由 Proxy 保证。

## 19. 不同阶段的 KV/Prompt Cache 行为

| 阶段 | 是否调用上游模型 | Session/Hook 行为 | KV/Prompt Cache 行为 |
|---|---:|---|---|
| 初始化表单阶段 | 通常否 | 写 L1/L2a，不写终态 L2b；可能返回伪造工具表单 | 没有上游推理，因此无 KV Cache 读写收益 |
| 初始化完成的首个模型请求 | 是 | 写 L1/L2a/L2b，预热 Hook Cache，首次注入 Session Context | Prompt 前缀发生结构性变化，通常需要建立新的缓存前缀 |
| 同 Session 稳态请求 | 是 | L1 终态命中；Hook Cache 命中 | 稳定 system/tools/注入块有利于命中，新增对话尾部执行增量计算 |
| L1 miss、L2a hit | 是 | L2a 提升 L1，完整详情不变 | 若最终序列化结果相同，缓存仍可能命中 |
| L2b 重建 | 是 | 重新拉 Agent/Task，重建 L1/L2a并预热 Hook | 详情或注入块可能变化，常导致新前缀或部分 miss |
| `mem:sync` 后首轮 | 视命令拦截而定 | 刷新 Session Detail 和 Hook Cache | 后续首次模型请求通常建立新缓存版本 |
| 每轮动态注入 | 是 | `none/hybrid` Hook 输出可能变化 | 变化点及其后的前缀通常无法复用 |
| Fork/Side Query | 是 | Hook Cache 只读，miss 不 self-heal | 目标是尽量复用 Main 已建立的稳定前缀 |

## 20. 为什么不再每轮自动注入 L0/L1

当前注入设计倾向于：

- 将 Session 稳定的 Profile、L2/L3 和记忆能力描述放入预热 Hook；
- L0/L1 等高频变化内容不再每轮自动塞入 user/system Prompt；
- 通过稳定的 Memory Tools 让模型按需查询动态记忆。

主要原因：

```text
每轮自动召回 L0/L1
  → 检索结果与排序持续变化
  → system/user 前缀持续变化
  → Prompt Cache miss
  → TTFT 和输入计算成本上升
```

工具按需检索的代价是模型需要发起额外工具调用，但能保持主 Prompt 前缀稳定，并避免把不相关记忆永久塞入上下文。

## 21. Hook Cache 如何间接提升 KV Cache

没有 Hook Cache：

```text
每轮执行 Hook
  → 外部返回顺序/时间戳/描述可能变化
  → 最终 Prompt 发生细微变化
  → 上游缓存前缀不稳定
```

有 Hook Cache：

```text
Session Init 固化 ContextBlock[]
  → 每轮读取同一 JSON 内容
  → 注入顺序和文本更稳定
  → 最终 Prompt 更稳定
  → 上游 KV/Prompt Cache 更容易命中
```

但是，只要 Session Context、messages、tools 或 adapter 序列化结果发生变化，KV Cache 仍然可能 miss。

## 22. KV/Prompt Cache 不解决的问题

KV Cache 不负责：

- 保存 Session 初始化进度；
- 保存 Team/Agent/Task 绑定；
- 持久化业务记忆；
- 决定应该召回哪些记忆；
- 防止注入重复；
- 在进程重启后恢复 SessionStore；
- 保证不同模型、不同租户之间共享缓存；
- 保证缓存一定存在或一定命中。

---

# 第四部分：三类缓存的协作与风险

## 23. 缓存内容对照

| 缓存 | 保存的对象 | 是否保存 Prompt 文本 | 是否保存模型 KV | 是否支持 pending 恢复 |
|---|---|---:|---:|---:|
| SessionStore L1 | `SessionInitState` | 只保存 Agent/Task 等注入依据 | 否 | 是，但仅当前进程 |
| SessionStore L2a | `SessionInitState` | 只保存 Agent/Task 等注入依据 | 否 | 是 |
| SessionStore L2b | `SessionBinding` | 否 | 否 | 否 |
| Injection Hook Cache | `ContextBlock[]` | 是，保存待注入块 | 否 | 不适用 |
| KV/Prompt Cache | Token 前缀的模型中间状态 | 上游用 Prompt 作为匹配依据 | 是 | 不适用 |

## 24. 写入与刷新对照

| 缓存 | 主要写入时机 | 主要刷新方式 |
|---|---|---|
| L1 | 每次 Session 状态变化 | `store.set`、L2a/L2b recovery |
| L2a | 每次 `store.set` | 状态机推进、L2b 重建、`mem:sync` |
| L2b | Session 进入 `initialized` | 重新初始化、重建或同步后终态写入 |
| Hook Cache | Session Init 后 prewarm、miss self-heal | `mem:sync`、TTL 后重新执行 |
| KV/Prompt Cache | 上游处理带缓存能力的 Prompt | 由上游 TTL/淘汰策略管理；Prompt 版本变化后重建 |

## 25. 关键风险

### 25.1 缓存新鲜度与命中率冲突

Session/Hook 内容固定越久，KV Cache 越稳定，但 Agent、Task、Knowledge 和 Memory 越可能陈旧。

建议引入显式版本：

```text
agent_version
task_version
asset_version
memory_epoch
hook_bundle_version
```

版本不变时复用；版本变化时定向刷新相关 Hook，而不是整套内容隐式漂移。

### 25.2 多 Pod 后端选择

- L1 永远是 Pod 本地；
- 本地 SQLite/FS/Memory 不能提供跨 Pod 共享；
- pending 状态跨 Pod 强依赖共享 L2a；
- 长会话恢复和 Bridge 反查强依赖共享 L2b；
- Hook Cache 不共享会导致不同 Pod 重复执行 Hook，并可能产生不同 Prompt 字节。

生产多 Pod 场景应优先使用共享 Redis 或共享 COS/ProxyStorage。

### 25.3 写失败被静默降级

SessionRepo/HookCacheRepo 多数实现以业务可用性优先，失败时不抛出到主流程。

风险是：

- 请求表面成功，但下一 Pod 无法恢复；
- prewarm 表面完成但缓存实际未持久化；
- 上游 Prompt Cache 命中率下降却不易关联到本地缓存故障。

建议增加分层指标：

- `session_l1_hit/miss`；
- `session_l2a_hit/miss/error`；
- `session_l2b_hit/miss/error`；
- `hook_cache_hit/miss/self_heal/error`；
- `prompt_cache_read/write/miss_tokens`；
- 最终 system/messages/tools 前缀 Hash。

### 25.4 Anthropic `cache_control` 结构稳定性

Adapter 已尝试保留 `cache_control`，但任何后续逻辑若把多个 system block 合成新的单 block，都可能丢失原 block metadata 或移动断点。

需要使用最终发送给上游的 body 做字节级/golden 测试，而不能只测试 parse 后的语义文本相同。

### 25.5 敏感信息持久化

L2a `sessionInfo` 和 L2b Binding 可能含 `user_key`。应确认：

- COS/Redis/SQLite 的访问权限；
- 静态加密和传输加密；
- 日志不输出完整对象；
- 删除 Session/实例时清理关联 Key；
- Binding 的长期保留是否符合安全与合规要求。

## 26. 建议的后续方案方向

### P0：建立可观测性

- 记录三层 Session 命中路径；
- 记录每个 Hook 的 cacheStrategy、hit/miss、块数和耗时；
- 记录最终 Prompt 分段 Hash，而不是日志输出完整敏感 Prompt；
- 对接上游 usage 中的 prompt-cache read/write/miss tokens。

### P0：保护 Prompt Cache 断点

- 为 Anthropic system/messages/tools 的 `cache_control` 做最终 body 回归测试；
- 检查 anchor 重建、block 合并是否保留 marker；
- 确保稳定块位于缓存断点之前，强动态内容位于断点之后或改为工具查询。

### P1：显式版本化和定向失效

- Hook Cache Key 或 metadata 中加入资产版本；
- Agent/Task 更新时只失效对应 Session/Hook；
- Memory 更新时推进 `memory_epoch`；
- 避免完全依靠手工 `mem:sync`。

### P1：统一缓存写入契约

明确各 Repo 方法是：

- awaited durable write；
- fire-and-forget best-effort；
- 写失败是否允许继续；
- 多 Pod 下哪一层是权威来源。

同时清理源码中与实际 `await` 行为不一致的历史注释，避免维护者错误理解一致性边界。

### P2：控制 Hook Cache 对象数量

当 Hook 数量或 Session 数量上升时，可评估将 KV Hook Cache 从“每 Hook 一个对象”改为“每 Session 一个 bundle”，减少 COS LIST/GET/PUT 放大，但需要处理并发覆盖和局部更新问题。

---

## 27. 最终总结

```text
SessionStore L1
  = 当前 Pod 的完整 Session 热状态

SessionStore L2a
  = 可恢复初始化过程的完整持久化快照

SessionStore L2b
  = 可在 L2a 消失后重建终态的长期最小绑定

Injection Hook Cache
  = 每个 Session、每个 Hook 已生成的注入内容块

KV/Prompt Cache
  = 上游模型对稳定 Prompt 前缀保存的推理中间状态
```

请求性能的最优路径是：

```text
Session L1 terminal hit
  + Hook Cache hit
  + Session Context/Tools/Prompt 前缀字节稳定
  + 上游 KV/Prompt Cache hit
```

其中任一层 miss 都不会必然导致请求失败，但会分别表现为 Session 恢复、Hook 重算、Metadata/Core/COS 访问或模型 prefill 成本增加。

