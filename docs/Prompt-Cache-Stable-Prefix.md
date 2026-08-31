# Prompt Cache 断点与稳定前缀实现分析

## 1. 总结

`"cache_control": { "type": "ephemeral" }` 表示在对应的 Anthropic Content Block 位置声明一个临时 Prompt Cache 断点。上游推理服务可以缓存从逻辑 Prompt 起点到该断点的 Token/KV 计算结果；后续请求的前缀一致时，可以直接复用这段计算。

MemoryProxy 不维护模型的 KV Cache。当前项目通过以下机制为上游缓存命中创造条件：

```text
保留客户端 cache_control
+ 固定 Session 的 Agent/Task 绑定
+ Session Init 时预热记忆和资产
+ Hook Cache 复用相同 ContextBlock
+ 固定 Injection Point 和 Hook priority
+ L0/L1 改为按需读取
+ 使用统一外部 Gateway URL
+ mem:sync 形成显式刷新边界
```

当前实现已经能够稳定大部分注入内容和顺序，但语义 Anchor 命中后会把 System 重建成单一文本块，可能丢失原有 `cache_control` metadata。这是目前最明确的 Prompt Cache 实现缺口。

## 2. `cache_control: ephemeral` 的含义

### 2.1 它声明的是缓存断点

简化请求如下：

```json
{
  "system": [
    { "type": "text", "text": "S0" },
    {
      "type": "text",
      "text": "S1",
      "cache_control": { "type": "ephemeral" }
    },
    {
      "type": "text",
      "text": "S2",
      "cache_control": { "type": "ephemeral" }
    }
  ],
  "tools": ["T0", "T1", "T2"],
  "messages": [
    { "role": "user", "content": "U0" },
    { "role": "assistant", "content": "A0" },
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "U1",
          "cache_control": { "type": "ephemeral" }
        }
      ]
    },
    { "role": "system", "content": "本轮动态信息" }
  ]
}
```

可以把它理解为存在三个候选断点：

```text
断点 1：System 到 S1
断点 2：完整 System 到 S2
断点 3：System + Tools + 历史消息 + U1
```

第一次请求可能产生 `cacheCreate`；后续请求如果断点之前的逻辑 Token 前缀一致，则可能产生 `cacheRead`。

### 2.2 `ephemeral` 不表示什么

它不表示：

- MemoryProxy 自己保存模型 KV；
- 缓存永久有效；
- 设置 marker 后一定命中；
- 只缓存当前这个 Content Block；
- 当前消息或响应会在使用后删除；
- 缓存 Token 不占用模型上下文窗口。

`ephemeral` 强调缓存由上游临时维护。缓存 TTL、淘汰、隔离范围、最低长度和计费规则由上游服务决定。如果第三方上游不支持 Anthropic Prompt Cache，该字段也可能被忽略或转换。

### 2.3 Cache Hit 的必要条件

即使存在 marker，以下变化仍可能导致 miss：

- System 文本或 Content Block 顺序变化；
- Tool 名称、description、Schema 或顺序变化；
- Session Context 或记忆注入内容变化；
- 历史消息被压缩、删除、插入或重排；
- `cache_control` 位置发生变化或丢失；
- 模型、上游路由、租户或鉴权缓存隔离域变化；
- 缓存已经过期或被淘汰。

匹配对象是上游模型看到的逻辑 Prompt/Token 前缀，不应简单理解为 HTTP JSON 文件从第一个字节开始的全部文本。

## 3. 当前项目的请求处理链路

一次 Anthropic 主请求的稳定前缀处理链路为：

```text
Claude Code 请求
  → 根据 message cache_control 位置分类 main/fork/sidequery
  → SessionStore 恢复或完成 Session Init
  → 向 body.system 追加 Session Context
  → Session Init 时 prewarm Injection Hooks
  → HookCacheRepo 保存 ContextBlock 快照
  → InjectionPipeline parse
  → 按固定顺序读取缓存并注入
  → AnthropicAdapter serialize
  → 恢复 cache_control
  → 构造 upstreamBody
  → 上游决定 cacheCreate/cacheRead
```

## 4. 保留客户端原有 `cache_control`

### 4.1 解析阶段

`AnthropicAdapter` 解析 Content Block 时，把 marker 暂存在内部 `ContextBlock.metadata`：

```ts
if (block.cache_control !== undefined && parsed.type !== "custom") {
  parsed.metadata = {
    ...parsed.metadata,
    cache_control: block.cache_control,
  };
}
```

### 4.2 序列化阶段

Injection Pipeline 执行结束后，Adapter 把 metadata 恢复成 Anthropic 字段：

```ts
if (block.type !== "custom" && block.metadata?.cache_control !== undefined) {
  out.cache_control = block.metadata.cache_control;
}
```

Tool 上的 `cache_control` 也通过 `AgentTool.cacheControl` 保存和恢复。

因此普通的 parse → inject → serialize 往返不会天然丢失缓存断点。

代码入口：

- [`MemoryProxy/src/injection/adapters/anthropic.ts`](../MemoryProxy/src/injection/adapters/anthropic.ts)

## 5. Session Context 如何处理缓存断点

Session 初始化完成后，Handler 将以下内容追加到 Anthropic 顶层 `body.system`：

```xml
<session_context>
  ...
</session_context>
```

假设原始 system 是：

```json
[
  {
    "type": "text",
    "text": "Claude Code System",
    "cache_control": { "type": "ephemeral" }
  }
]
```

追加后变成：

```json
[
  {
    "type": "text",
    "text": "Claude Code System",
    "cache_control": { "type": "ephemeral" }
  },
  {
    "type": "text",
    "text": "<session_context>...</session_context>"
  }
]
```

项目刻意执行以下策略：

- 保留原 Content Block 数组结构；
- 不移动客户端原有 marker；
- 新增的 Session Context Block 不携带 `cache_control`；
- 不擅自增加额外 breakpoint。

因此，原 system breakpoint 仍然只覆盖客户端原始 System，Session Context 位于该断点之后。如果 messages 中还有更靠后的 marker，更大的 message breakpoint仍可能覆盖 System、Session Context、其他记忆注入、Tools 和历史消息。

代码入口：

- [`MemoryProxy/src/session/context-injector.ts`](../MemoryProxy/src/session/context-injector.ts)
- [`MemoryProxy/src/anthropicHandler.ts`](../MemoryProxy/src/anthropicHandler.ts)

## 6. Hook Cache 如何稳定注入内容

### 6.1 Session 初始化时预热

Session 首次进入 `initialized` 后，Anthropic Handler 会等待 `prewarmFromConfig()`：

```text
Session initialized
  → 筛选 cacheStrategy=session_init/hybrid 的 Hook
  → 并行执行 hook.prewarm()
  → 得到 ContextBlock[]
  → 写入 HookCacheRepo
  → 第一轮 Injection Pipeline 读取缓存
```

当前默认总预热预算为 20 秒。单个 Hook 失败或超时只跳过该 Hook，不会让整个 Session Init 失败。Pipeline 在 Cache miss 时还有 execute + self-heal 兜底。

当前主要使用 `cacheStrategy="session_init"` 的 Injector 包括：

- Skill 列表；
- Skill Tools 使用说明；
- Knowledge Tools；
- TDAI L3 Persona + L2 Scene Index；
- TDAI Memory Tools。

### 6.2 缓存隔离键

Hook Cache 使用以下复合身份：

```text
spaceId
+ userId
+ agentSource
+ sessionId
+ hookId
```

这意味着不同租户、用户、客户端类型、Session 和 Injector 不会直接复用同一个缓存条目。

当前支持的存储后端包括：

| 后端 | 保存形式 | 生命周期特点 |
| --- | --- | --- |
| Redis | Session Hash，field 为 hookId | 默认 TTL 30 分钟 |
| ProxyStorage/KV | `ttl/.../inj-hook/<hookId>.json` | 生命周期由 TTL 存储策略管理 |
| SQLite | `hook_cache` 表 | 当前读取路径没有代码级 TTL 判断 |
| NullRepo | 不保存 | 每轮退化为执行 Hook |

### 6.3 后续请求的读取算法

对于 `cacheStrategy="session_init"`：

```text
Hook Cache hit
  → 返回缓存 ContextBlock[]
  → 跳过 hook.execute()

MAIN 请求 Cache miss
  → 执行 hook.execute()
  → 将结果 self-heal 写回缓存

FORK 请求 Cache miss
  → 执行 hook.execute()
  → readOnly=true，不回写缓存
```

FORK 不 self-heal，是为了避免派生请求生成不同内容并反向覆盖主会话的稳定快照。

代码入口：

- [`MemoryProxy/src/injection/prewarm.ts`](../MemoryProxy/src/injection/prewarm.ts)
- [`MemoryProxy/src/injection/pipeline.ts`](../MemoryProxy/src/injection/pipeline.ts)
- [`MemoryProxy/src/db/hookCacheRepo.ts`](../MemoryProxy/src/db/hookCacheRepo.ts)
- [`MemoryProxy/src/db/redis-hook-cache-repo.ts`](../MemoryProxy/src/db/redis-hook-cache-repo.ts)
- [`MemoryProxy/src/db/kv-hook-cache-repo.ts`](../MemoryProxy/src/db/kv-hook-cache-repo.ts)

## 7. 固定注入顺序

相同内容如果排列顺序不同，最终 Token 前缀仍然不同。项目规定了固定 Injection Point 顺序：

```text
system.prefix
→ system.before_tools
→ system.after_tools
→ system.suffix
→ user.first_turn
→ user.before
→ user.after
→ tools.append
```

同一个 Injection Point 内按 priority 从小到大执行：

```text
SYSTEM = 0
MEMORY = 100
SKILL  = 200
WIKI   = 300
CUSTOM = 1000
```

只要注册的 Injector 集合不变，相同 Hook 的注入顺序就是确定的。

代码入口：

- [`MemoryProxy/src/injection/pipeline.ts`](../MemoryProxy/src/injection/pipeline.ts)
- [`MemoryProxy/src/injection/registry.ts`](../MemoryProxy/src/injection/registry.ts)
- [`MemoryProxy/src/injection/types.ts`](../MemoryProxy/src/injection/types.ts)

## 8. 控制动态记忆进入稳定前缀

项目不再每轮自动检索 L0/L1 并注入当前 Prompt，而是采用：

```text
Session 稳定注入：
  L3 Persona
  L2 Scene Index
  Memory Tools 使用说明

按需动态查询：
  L0 原始对话
  L1 原子记忆
  L2 Scene 正文
```

L2 只注入路径与 summary，不在 Session 初始化时读取所有场景正文。模型需要细节时通过 Tool 查询，查询结果进入当前消息尾部，而不是长期 System 前缀。

这样做可以避免每轮 Top-K、相关度和索引变化导致 System Prompt 漂移。

代码入口：

- [`MemoryProxy/src/injection/index.ts`](../MemoryProxy/src/injection/index.ts)
- [`MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts`](../MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts)
- [`MemoryProxy/src/injection/injectors/tdai-tools-injector.ts`](../MemoryProxy/src/injection/injectors/tdai-tools-injector.ts)

## 9. 多节点文本一致性

Skill Tools 和 Memory Tools 的注入文本中会包含 Gateway URL。如果不同 Pod 使用自己的 IP：

```text
Pod A → http://10.0.1.10:8096
Pod B → http://10.0.2.11:8096
```

那么即使功能相同，System 文本和 Token 前缀也不同。项目支持配置统一地址：

```yaml
injection:
  externalGatewayUrl: https://gateway.example.com
```

所有 Pod 使用相同外部 Gateway URL，可以避免 Hook Cache 互相覆盖和上游 KV Cache miss。

代码入口：

- [`MemoryProxy/src/injection/index.ts`](../MemoryProxy/src/injection/index.ts)

## 10. `mem:sync` 形成显式刷新边界

稳定前缀不代表记忆永远不更新。执行 `mem:sync` 时，刷新流程使用：

```text
clearBySession()
  → 删除当前 Session 的旧 Hook Cache
  → 重新 prewarm
  → 新快照成为唯一权威
```

它把记忆变化划分为两个可解释的缓存周期：

```text
mem:sync 之前 → 使用旧稳定前缀
mem:sync 之后 → 建立新稳定前缀
```

如果刷新时某个 Hook 返回空、超时或失败，旧缓存已经被清理，下一轮请求会进入 execute + self-heal，而不会让已经失效的旧资产无限续命。

代码入口：

- [`MemoryProxy/src/injection/prewarm.ts`](../MemoryProxy/src/injection/prewarm.ts)

## 11. `cache_control` 在项目中的第二个用途

除了传递给上游，Claude Code 请求中的 message marker 还被用于请求分类：

```text
marker 位于 messages[n-1] → MAIN
marker 位于 messages[n-2] → FORK
无 marker + tools=[] + thinking.disabled → SIDEQUERY
```

不同类型对应不同注入行为：

- MAIN：完整执行 Pipeline，Cache miss 时允许 self-heal；
- FORK：执行 Pipeline，但 `readOnly=true`，Cache miss 不回写；
- SIDEQUERY：完全跳过 Injection Pipeline。

因此，`cache_control` 在当前项目中既是上游 Prompt Cache marker，也是 Claude Code 请求路由信号。协议转换时如果丢失 marker，可能同时影响缓存和请求分类。

代码入口：

- [`MemoryProxy/src/common/cc-request-classifier.ts`](../MemoryProxy/src/common/cc-request-classifier.ts)
- [`MemoryProxy/src/anthropicHandler.ts`](../MemoryProxy/src/anthropicHandler.ts)

## 12. 当前实现的主要缺口：Anchor 重建丢失 marker

普通 Adapter 往返能够保留 `cache_control`。但 Injection Pipeline 的语义 Anchor 命中后，会将 System 多个 Block 重建成单一文本块：

```ts
sysMsg.blocks = [
  {
    type: "text",
    content: profile.rebuild(newSegments),
  },
];
```

这个新 Block 没有迁移旧 Block 的 `metadata.cache_control`。

请求可能从：

```json
[
  {
    "type": "text",
    "text": "S1",
    "cache_control": { "type": "ephemeral" }
  },
  {
    "type": "text",
    "text": "S2",
    "cache_control": { "type": "ephemeral" }
  }
]
```

变成：

```json
{
  "system": "重建后的完整 System 文本"
}
```

其影响是：

- System 文本仍可能因为 Hook Cache 而保持稳定；
- 原有 System breakpoint 可能丢失；
- messages 中的 `cache_control` 通常仍能保留；
- 上游可能只能依赖更靠后的 message breakpoint；
- System 局部缓存能力和缓存可观测性下降。

对应代码：

- [`MemoryProxy/src/injection/pipeline.ts`](../MemoryProxy/src/injection/pipeline.ts)

建议修复方式：

```text
解析原 System Content Blocks
  → 保存 block 边界和 cache_control metadata
  → Anchor 只修改目标语义段
  → 重建时恢复原 block 边界
  → 将 metadata 放回对应断点
  → 对最终 outbound body 做 golden test
```

不能简单地把所有 marker 放到 System 最后，因为这会改变客户端原本设计的缓存断点和可能的缓存写入成本。

## 13. 前缀稳定性的观测方法

项目提供了可选的最终出站 MD5 观测：

```text
PROXY_DEBUG_DUMP_OUTBOUND_MD5=1
```

开启后会记录：

- `sysFullMd5`：完整 `body.system` 序列化摘要；
- `sysTextMd5`：System 纯文本摘要；
- `msgsPrefixMd5`：最后一个 message cache marker 之前的消息前缀摘要；
- `msgsAnchorIdx`：最后一个 message marker 所在位置。

连续请求只有摘要稳定，才具备缓存命中的必要条件。摘要稳定仍不等于实际命中，最终还要关联上游返回的：

```text
cacheRead
cacheCreate
input tokens
TTFT
```

代码入口：

- [`MemoryProxy/src/anthropicHandler.ts`](../MemoryProxy/src/anthropicHandler.ts)

## 14. 最终结论

当前项目对稳定前缀的实现可以概括为：

```text
客户端提供 cache_control 断点
  → Adapter 尽量保留 marker
  → SessionStore 固定 Agent/Task 身份
  → Hook Cache 固定记忆和资产文本
  → Registry 固定注入顺序
  → 动态记忆改为 Tool 按需读取
  → 统一 Gateway URL 保证跨 Pod 文本一致
  → mem:sync 显式切换快照版本
  → 上游维护真正的 KV/Prompt Cache
```

需要准确区分三种缓存：

| 缓存 | 维护方 | 缓存内容 | 主要作用 |
| --- | --- | --- | --- |
| SessionStore | MemoryProxy | Session Init 状态和 Agent/Task 绑定 | 稳定身份上下文 |
| Injection Hook Cache | MemoryProxy | 已生成的 `ContextBlock[]` | 稳定注入文本、减少远端查询 |
| KV/Prompt Cache | 上游推理服务 | Prompt Token 对应的推理中间状态 | 减少重复 Prefill |

因此，Hook Cache hit 不等于 KV Cache hit；`cache_control` 存在也不等于 KV Cache hit。当前项目能够控制的是输入内容、顺序、marker 和刷新边界，最终是否命中仍由上游服务决定。
