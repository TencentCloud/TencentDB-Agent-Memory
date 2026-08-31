# 阅读报告

## 摘要

项目可以看成一条“前台读链 + 后台写链”：

```text
前台读链：
Claude 请求 → Session 身份恢复/初始化 → Agent/Task Context
→ Skill/Knowledge/L2/L3/Tools 注入 → 上游模型

后台写链：
上游响应 → L0 原始对话 → L1 原子记忆
→ L2 场景记忆 → L3 Persona → 后续 Session 再注入或按需读取
```

核心结论如下：

1. Session Init 不是模型初始化，而是 Proxy 的会话身份绑定状态机。它把客户端会话关联到 `space/user/team/agent/task`，并为后续注入、权限校验和记忆回流提供身份,Proxy 直接返回Claude Code 原生 `AskUserQuestion` 工具调用生成表单供用户选择绑定。
2. L0–L3 是异步构建链：Handler 只负责把真实主对话写成 L0；MemoryCore 再按阈值、Timer 和 Worker 调度生成 L1、L2、L3。
3. 当前记忆注入采取“稳定信息直注、动态信息按需查”：L3 Persona 和 L2 索引进入 system；L0/L1 不再每轮自动召回，而由模型通过只读工具按需查询。
4. KV/Prompt Cache 由上游推理服务维护。Proxy 不保存模型 KV，只能通过稳定 system、tools、注入块顺序和 `cache_control` 位置，为命中创造条件。
5. 当前最需要优先确认的两个实现风险是：稳定 Session 每轮可能重复 prewarm Hook Cache；Injection Pipeline 重建 Anthropic system block 时可能丢失原有 `cache_control` 元数据。

---

# Session Init 初始化链路

## 模块功能总结

Session Init 的主要职责是：

- 从请求路径、Header 和认证结果识别 `spaceId/userId/agentSource/sessionId`；
- 恢复已有 Session，或者通过交互表单让用户选择 Team、Agent、Task；
- 将最终选择保存到 SessionStore L1/L2a/L2b；
- 获取 Agent Prompt、Task Description 等详情；
- 后续每次请求都根据绑定结果附加 `<session_context>`；
- 为 Skill、Knowledge、Memory Hook 提供检索身份和权限上下文；
- 用户选择跳过时记录 terminal bypass，避免每轮重复弹窗。

它不是用来创建 Team、Agent 或 Task，而是把已有控制面资产与当前客户端 Session 建立绑定。

## 示例

以 Claude Code 为例，假设用户输入如下内容：

```text
请排查订单库最近出现的慢查询，并给出优化方案。
```

将抓包后的请求简化如下：

```json
{
  "path": "/claude-code/default/v1/messages",
  "headers": {
    "x-conversation-id": "7bcb1186-a17b-49c1-b399-40ad6b49a6xxx",
    "authorization": "Bearer <user-key>"
  },
  "body": {
    "model": "deepseek-v4-pro",
    "stream": true,
    "system": [{ "type": "text", "text": "<Claude Code system prompt>" }],
    "messages": [
      { "role": "user", "content": "请排查订单库最近出现的慢查询，并给出优化方案。" }
    ],
    "tools": ["Bash", "Read", "AskUserQuestion"]
  }
}
```

设定Team、Agent、Task信息如下：

```text
Team：数据库平台组
Agent：DBA Agent、SQL Review Agent
Task：订单库性能治理、常规巡检
```

若候选不唯一，Session Init 需要多轮交互：

```plaintext
请求 1：是否关联团队资产？
请求 2：选择 Agent
请求 3：选择 Task
请求 4：完成绑定，首次携带上下文访问真实模型
```

## 调用链展示

```text
Claude Code
  → POST /claude-code/:spaceId/v1/messages
  → server.ts 路由到 handleAnthropicMessages()
  → 读取 body、认证 key、spaceId、conversationId
  → classifyRequest(): main / fork / sidequery
  → verify user，得到 userId
  → 组装 SessionIdentity
  → SessionStore.getOrRecover()
       L1 terminal Map
       → L2a 完整 SessionInitState
       → L2b 精简 Binding + Metadata 重建
       → history scan
  → 未恢复终态时 handleSessionInit()
       → session/index.ts 按 agentSource 分派
       → claude-code/init.ts 状态机
       → MetadataClient 拉 Team/Agent/Task
       → 需要选择：返回伪造 AskUserQuestion，终止本次请求
       → 选择完成：获取 Agent/Task detail，store.set(initialized)
  → 生成 <session_context>
  → prewarmFromConfig() 生成 Session Hook Cache
  → InjectionPipeline.process()
  → AnthropicAdapter serialize
  → 转发上游 LLM
  → 流式/非流式响应返回 Claude
  → 正常 main 对话写 L0，触发后续记忆构建
```

主要入口：

- [`MemoryProxy/src/server.ts`](../MemoryProxy/src/server.ts)
- [`MemoryProxy/src/anthropicHandler.ts`](../MemoryProxy/src/anthropicHandler.ts)
- [`MemoryProxy/src/session/index.ts`](../MemoryProxy/src/session/index.ts)
- [`MemoryProxy/src/session/claude-code/init.ts`](../MemoryProxy/src/session/claude-code/init.ts)

## 核心类 Handler 关键处理步骤（以Claude code为例）

### 4.1 请求分类

Claude Code 不只发送用户主对话，还会发送标题、摘要、压缩、Fork 等辅助请求。开启 `ccRequestRouting` 后，Handler 会把请求分成：


| 类型        | 典型来源                  |         Session Init |            注入 | L0/Skill 回流 |
| ----------- | ------------------------- | -------------------: | --------------: | ------------: |
| `main`      | 用户真实对话              |             完整执行 |        完整执行 |          写入 |
| `fork`      | summary/recap 等派生请求  | 只允许恢复，不弹表单 | 只读 Hook Cache |          不写 |
| `sidequery` | title/verify 等独立短请求 |                 跳过 |            跳过 |          不写 |

这样可以避免客户端内部请求被误记成用户事实，也避免辅助请求污染主会话缓存。

### 身份构造

本例中可以得到：

```text
agentSource = claude-code
spaceId     = default
sessionId   = sess-order-001
userId      = auth 返回的用户 ID

L1 key      = claude-code:sess-order-001
L2a key     = default:<userId>:claude-code:sess-order-001
L2b key     = default:sess-order-001
```

这些 Key 的职责不同：

- L1 Key 面向当前进程快速读取；
- L2a Key 强调四段身份隔离并保存完整状态；
- L2b Key 被拍平为 `spaceId+sessionId`，方便 Memory/Skill Bridge 在只知道 Session ID 时反查身份。

### Session信息恢复

Handler 不会因为本 Pod 的 Map 没数据就立刻弹表单，而是调用：

```ts
store.getOrRecover(compositeKey, identity, {
  metadataClient,
  messages
})
```

恢复顺序为：

```text
L1 → L2a → L2b → 历史扫描
```

具体行为：

- L1 `initialized` 命中：零 IO 返回；
- L1 `pending_*` 命中：仍查 L2a，防止其他 Pod 已推进状态；
- L2a 命中：把完整状态提升回 L1；
- L2b 命中：用 Agent/Task ID 重新获取详情，再重建 L1/L2a；
- 全部 miss 且没有历史：视为新 Session；
- 有历史但无法恢复：一次性 bypass，避免老对话突然重复弹初始化表单。

实现：[`MemoryProxy/src/session/store.ts`](../MemoryProxy/src/session/store.ts)。

### 表单状态机

Claude Code 状态推进可以概括为：

```text
uninitialized
  → pending_asset_confirm
  → pending_team_select（多 Team 时）
  → pending_agent_select（多 Agent 时）
  → pending_task_select（多 Task 时）
  → initialized
```

例如本例：

1. 首轮将 `cachedTeams` 和 `pending_asset_confirm` 写入 L1/L2a；
2. 用户确认关联，因为 Team 唯一，跳过 Team 表单；
3. 用户选择 `DBA Agent`，状态进入 `pending_task_select`；
4. 用户选择“订单库性能治理”，进入 `completeRegistration()`；
5. 并行获取 Agent/Task Detail；
6. 构建 `SessionInfo` 并写入 `initialized`；
7. L1/L2a 保存完整状态，L2b 保存精简 Binding。

当前契约要求 Team、Agent、Task 三者齐全才注入；Task 缺失会进入 bypass，而不是只注入 Agent。

### 消息注入

初始化完成后，请求逻辑仍然在各协议 Handler 中执行。以 Anthropic Handler 为例：

```text
每个 main 请求
  → getOrRecover()
  → L1 terminal hit
  → 取出 sessionInfo/agentDetail/taskDetail
  → 给当前请求附加 <session_context>
  → 运行 Injection Pipeline
  → 转发模型
```

`<session_context>` 示例：

```xml
<session_context>
[Agent]
id: agent-dba
name: DBA Agent
description: 负责数据库性能诊断与变更评审
prompt:
先收集证据，再给出风险分级和可回滚方案。

[Task]
id: task-order-perf
name: 订单库性能治理
description: 定位慢 SQL、索引和容量问题
</session_context>
```

它属于 Session 身份上下文，即使通用 `injection.enabled=false`，只要 Session Context 对应开关没有关闭，仍可以独立注入。

### 三层 SessionStore 缓存


| 层级 | 保存内容               | 示例作用                                | TTL                                                       |
| ---- | ---------------------- | --------------------------------------- | --------------------------------------------------------- |
| L1   | 完整`SessionInitState` | 当前 Pod 立即知道已绑定 DBA Agent       | pending 默认 30 分钟；终态直到进程退出                    |
| L2a  | 完整`SessionInitState` | 下一轮落到 Pod B 时继续 Agent/Task 表单 | Redis 默认 30 分钟；KV 默认`ttlDays=7`；SQLite 无物理 TTL |
| L2b  | 精简`SessionBinding`   | 一个月后回来，用 Agent/Task ID 重建状态 | Redis 默认滚动 30 天；KV`nottl/` 长期保留                 |

L2a 保存表单中间态；L2b 只保存最终绑定，不能恢复 pending 阶段。

---

# 四阶段记忆构建

## 模块功能总结

四阶段记忆构建不是四套互相独立的存储，而是一条逐级压缩、逐级降低更新频率的异步流水线：

```text
L0 原始消息
  → L1 原子记忆
  → L2 场景文档与场景索引
  → L3 Persona / Core Memory
```

各层承担不同的信息损失和稳定性目标：

- L0 尽量忠实保存本轮用户与 assistant 消息，是后续重算和审计的事实源；
- L1 使用 LLM 将对话拆成最小可复用记忆单元，同时执行类型归一化和冲突处理；
- L2 将新增 L1 与已有场景联合整理，允许创建、更新、合并或删除场景文件；
- L3 只从场景层归纳长期稳定的 Persona 或团队工作准则，不直接消费每一条原始对话。

Handler 直接参与的通常只有 L0 写入。L1–L3 由 MemoryCore 的状态管理器、TimerScanner、任务队列和 PipelineWorker 异步完成，所以用户收到模型响应并不意味着高层记忆已经生成。

## 记忆整体构建链路

1. Proxy 在主请求完成后，将本轮增量消息写入 L0；只有 L0 持久化成功以后才通知 Pipeline。
2. `StatefulPipelineManager` 以 Session 为单位原子增加对话轮数，同时维护阈值触发和空闲 Timer。达到阈值时直接入队 L1，否则等待空闲、flush 或后续消息。
3. `PipelineWorker` 消费任务并获取锁。L1 使用 Session 级锁；L2/L3 使用 Agent/Profile 级锁，因为同一 Agent 的多个 Session 会写同一份场景目录和 Persona。
4. 各层设计上通过 cursor 或 checkpoint 只读取上次成功处理之后的数据，并应当只在成功后推进状态；当前 L1 和 L3 存在失败状态未被上层严格区分的例外，分别在 10.5 和 12.4 节说明。
5. L1 成功后不立即同步执行 L2，而是推进 L2 Timer；L2 成功且确实产生有效处理结果后再入队 L3。
6. Worker 对可重试异常使用指数退避；超过次数进入死信。锁丢失时停止重试，避免在无法确认互斥关系时重复写入。
7. L1/L2/L3 记录输入引用、输出引用、Prompt 版本、模型和耗时等 generation provenance，用于追踪某份高层记忆来自哪些低层记录。

这里有两类“增量”需要区分：L0 解决同一客户端历史不能重复归档的问题；L1/L2 的 cursor 解决已经持久化的低层记录不能被重复消费的问题。二者任一失效都可能产生重复记忆，但它们发生在不同位置。

## L0：原始对话层

### 输入与触发

Proxy 主链在正常业务轮次结束后调用 `recordTdaiTurn()`，将本轮用户消息和已经解析完成的 assistant 文本组装成增量消息数组，再由 `TdaiClient.addConversation()` 发送到 `/v3/conversation/add`。

写入前存在以下门控：

- 请求必须属于 `main`，`fork/sidequery` 默认不归档，避免标题生成、摘要生成等派生调用污染用户记忆；
- `extraction.enabled`、`tdai-memory` 等功能 Gate 必须允许；
- 必须能够解析出 Session、Team、User、Agent 等隔离身份；v3 数据面缺少严格隔离字段时直接拒绝；
- 流式请求必须等 SSE 结束并取得完整 assistant 文本后再归档；该分支通过 pending write 和 retry 管理后台写入；
- 被 Proxy 拦截的 `mem:*` 命令虽然不访问业务模型，也会显式写入一轮 L0，以保持操作时间线完整。

### Proxy 写入算法

1. 从当前请求中提取最新的真实用户输入，同时从模型响应中提取最终 assistant 文本。无法取得有效用户消息时不创建空轮次。
2. 将 `team_id/user_id/agent_id/session_id/task_id` 与消息一起发送给 MemoryCore。身份字段不仅用于查询权限，也会固化到每条 L0 记录中，成为后续 L1 分组和跨租户去重的边界。
3. MemoryCore 对请求体执行 Schema 和隔离校验，并在首次出现某个 Team+Agent 组合时尽力登记 `chat_memory` 资产。资产登记失败只记录告警，不阻塞 L0，因为原始数据可用性优先。
4. 对每条消息生成内部 `msg-*` ID。`recorded_at` 存在时使用调用方时间，否则使用接收时间；同一批多条消息以 `ingestBaseMs + index` 排开，保证基于写入时间的 L1 cursor 可以单调前进。业务消息的 `timestamp` 与入库时间分别保存，不能混作同一个字段。
5. 若 Embedding 服务可用，为消息生成向量；Embedding 失败只降级为无向量 L0，不阻止正文写入。
6. 调用 Store 的 `upsertL0()` 写入权威数据存储。Service 模式以数据库/远端 Store 为准；Standalone 模式还会按日期追加 JSONL，作为可 grep 的审计镜像。
7. 全批写完后才调用 `notifyPipeline()`。通知失败不回滚已经落库的 L0，后续 Pipeline 可以通过 cursor 补处理积压。
8. 通知时只统计 `role=user` 的消息数作为 conversation rounds，assistant 消息会保存，但不会单独推动 L1 阈值。

当前 `/conversation/add` 在服务端生成新消息 ID，调用方没有传入稳定的幂等键；因此“响应未收到后重试”可能形成语义重复记录。后续如果要强化 exactly-once，应引入由 Session ID、turn ID、role 和内容摘要构成的幂等键，而不是只依赖下游 L1 去重。

### 宿主 Hook 捕获路径的增量算法

MemoryCore 还保留 `l0-recorder.ts` 的宿主 Hook 捕获路径。该路径接收的往往是完整会话历史，因此额外执行两层去重：

1. 优先使用 `before_prompt_build` 时缓存的消息数量做位置切片，只保留本轮新增区间；
2. 位置缓存不存在时，使用 `afterTimestamp` 过滤，只保留时间戳严格大于 cursor 的消息；
3. 用缓存的原始用户 Prompt 替换被 `prependContext` 污染的用户消息；若定位失败，则依赖后续清洗兜底；
4. 只抽取 user/assistant，清理注入文本和噪声；assistant 回复还会移除 fenced code block，以降低后续 Embedding 噪声；
5. `shouldCaptureL0()` 过滤无意义内容，最后按日期追加一行一条消息的 JSONL。

这套位置切片算法属于 Hook 捕获路径，不应误写成 Proxy `/v3/conversation/add` 的必经步骤。

### 输出与失败语义

L0 的输出是一组带隔离身份、角色、正文、业务时间和入库时间的消息记录。它不进行事实归纳，也不判断长期价值；严格的质量过滤发生在 L1。

流式归档使用后台 pending write，正常退出时会尝试 flush；进程崩溃仍可能丢失尚未完成的写入。非流式路径也存在异步 `.catch()` 分支，因此“模型响应成功”与“L0 一定持久化成功”不是同一个原子事务。

相关实现：

- [`MemoryProxy/src/tdai/recorder.ts`](../MemoryProxy/src/tdai/recorder.ts)
- [`MemoryProxy/src/tdai/client.ts`](../MemoryProxy/src/tdai/client.ts)
- [`MemoryCore/src/gateway/v2-router.ts`](../MemoryCore/src/gateway/v2-router.ts)
- [`MemoryCore/src/core/conversation/l0-recorder.ts`](../MemoryCore/src/core/conversation/l0-recorder.ts)

## L1：原子记忆层

### 触发算法

`StatefulPipelineManager.notifyConversation()` 不直接运行 Extractor，而是通过 StateBackend 的 `captureAtomic()` 在一个原子操作中完成计数、阈值判断、任务入队或 Timer 设置，避免多个 Pod 同时收到消息时丢计数或重复触发。

默认配置下，稳态阈值为每 5 轮一次，空闲超时为 600 秒。启用 warm-up 后，新 Session 的有效阈值从 1 开始，每次成功触发后倍增为 2、4，随后毕业到稳态阈值 5。这样可以较快形成首批记忆，同时避免长会话每轮调用抽取模型。

L1 Task 可能由以下路径产生：

- conversation count 达到当前阈值；
- Session 空闲 Timer 到期；
- Session End 或显式 flush；
- 上一批只消费了部分 L0，检测到大积压后立即排下一批；
- 小尾部积压重新挂到 idle Timer；
- Worker 对失败任务执行指数退避重试。

Timer 触发的任务执行前还会检查 `conversation_count`。如果同一批数据已经被另一个任务处理并把计数清零，则直接跳过，避免阈值任务和空闲任务双重消费。

### 增量读取与批处理边界

L1 Runner 首先读取该 Session 的 checkpoint，其中 `last_l1_cursor` 表示上次成功消费的最大 `recorded_at_ms`。构建批次的算法如下：

1. 优先从 VectorStore 查询 cursor 之后最旧的 L0；只有 Store 不可用时才退化到 JSONL。
2. 查询量为处理上限 `N` 的两倍 `2N`。前 `N` 条用于本轮抽取，剩余部分只用于判断是否存在 backlog。
3. 所有记录按 `recordedAtMs`、消息时间升序排列，保证 cursor 从旧到新推进。
4. 如果第 `N` 条与后续记录拥有相同的 `recordedAtMs`，批次边界会向后扩展，直到遇到更大的毫秒值，防止下一轮使用 `>` cursor 时跳过同毫秒兄弟记录。
5. 当前 cursor 仍只有毫秒时间，没有 record ID。若至少 `2N` 条记录共享同一毫秒，LIMIT 之外的同毫秒记录仍存在理论漏数风险；稳妥方案是升级为 `(recorded_at, record_id)` 复合 cursor。
6. 处理切片按 `userId + agentId + sessionId` 重新分组，并保持组内时间顺序。这样同一个逻辑 Session Key 下的不同隔离实体不会进入同一次 LLM 抽取。

### 质量过滤、场景切分与原子记忆抽取

每个隔离分组依次执行以下算法：

1. `shouldExtractL1()` 先过滤过短、符号噪声、Prompt Injection 特征或不值得长期保留的消息。L0 刻意宽收，L1 才负责严格筛选。
2. 合格消息被拆为“新消息”和“背景消息”：默认最多 10 条新消息、5 条较旧背景消息。背景只帮助理解指代和连续性，不应被重复视为本轮新事实。
3. Runner 把上一批最后一个 `scene_name` 传给下一批，帮助 LLM 判断当前内容是延续旧场景还是切换到新场景。
4. 单次 LLM 调用同时完成场景切分和记忆抽取，返回 `scene_name`、关联消息 ID、记忆正文、类型、优先级、来源消息 ID 和 metadata。
5. 返回文本经过 JSON 清洗和结构解析。无法解析或 LLM 调用失败时，Extractor 返回 `success=false` 和空结果；但当前上层 Runner 没有据此中止批次，存在继续推进 cursor 的问题，详见 10.5 节。
6. 类型必须归一化到受支持集合：`persona`、`episodic`、`instruction`、`work_fact`、`work_task`、`work_method`、`work_artifact`；非法类型被丢弃。缺失优先级默认取 50。
7. 所有场景的记忆被扁平化，并受 `maxMemoriesPerSession` 限制，默认最多保留 10 条，防止单次异常输出无限膨胀。

这一阶段的“场景切分”只给 L1 打上 `scene_name`，并不会直接写 L2 Markdown。真正的场景文件合并发生在后续 L2。

### 冲突检测与写入决策

L1 对每条新记忆先分配临时 ID，再执行两阶段去重：

1. 候选召回优先使用 Embedding + 向量相似度，每条新记忆默认取 Top 5；向量不可用时退化到 FTS5/BM25 关键词召回；两者都不可用时不扫描全部 JSONL，而是跳过去重并全部按 `store` 处理。
2. 如果至少一条新记忆召回到候选，系统把所有新记忆及各自候选放进一次批量 LLM 判定，输出一一对应的 `store/update/merge/skip` 决策。

四种动作含义如下：

- `store`：没有等价或冲突记录，写成新的 L1；
- `skip`：内容已被现有记录覆盖，不写新记录；
- `update`：用新内容替换指定目标的当前表达；
- `merge`：将多个目标与新信息合并为一条新的综合记录。

`update/merge` 会先读取目标记录，以便继承或合并来源、时间、优先级等字段；随后从 VectorStore 删除旧目标，再写入新记录。JSONL 是 append-only，旧行不会原地删除，后续由 cleaner 以 VectorStore 为事实源做整理。新记录同时写 JSONL 和 VectorStore，并尽力生成 Embedding；双写任何一侧失败都会记录降级信息。

当前错误策略偏向可用性：批量去重失败时，系统会把全部新记忆直接存为 `store`。它避免抽取结果丢失，但会把短时依赖故障转化为长期重复记忆，因此需要通过 dedup failure 指标和后处理清理约束风险。

### Checkpoint、积压处理与输出

Runner 在分组循环结束后调用 `markL1ExtractionComplete()`，把 cursor 推进到本批已处理记录的最大 `recordedAtMs`，同时保存最后一个场景名。输出包括实际处理消息数、抽取数、去重后存储数、是否还有积压，以及产生新 L1 的 Profile Scope。

需要特别注意：`extractL1Memories()` 会把 LLM 调用或解析失败转换为 `success=false` 的普通返回值，但 `createL1Runner()` 当前只累计 `extractedCount/storedCount`，没有检查 `success`，仍可能在循环结束后推进 `last_l1_cursor`。结果是失败批次的 L0 被标成已消费，却没有产生 L1，也不会自然进入任务重试。这里应当在任一分组 `success=false` 时抛错或保留 cursor，并为已成功分组建立可重入边界。

如果查询得到完整 `2N` 且仍有未处理记录，`hasFullBacklog=true`，Worker 立即入队下一轮 L1；如果只是小尾部，`hasMore=true`，系统重新设置 idle Timer。这样持续积压可以快速排空，小尾部则等待合并以降低 LLM 调用次数。

每次成功构建还会写 generation log：输入引用指向 L0 message ID，输出引用指向 L1 memory ID，并附带 Prompt 版本、模型、模式和延迟。

相关实现：

- [`MemoryCore/src/utils/pipeline-factory.ts`](../MemoryCore/src/utils/pipeline-factory.ts)
- [`MemoryCore/src/core/record/l1-extractor.ts`](../MemoryCore/src/core/record/l1-extractor.ts)
- [`MemoryCore/src/core/record/l1-dedup.ts`](../MemoryCore/src/core/record/l1-dedup.ts)
- [`MemoryCore/src/core/record/l1-writer.ts`](../MemoryCore/src/core/record/l1-writer.ts)

## L2：场景记忆层

### 触发与节流算法

L2 不随每条 L1 立即运行。L1 完成后，Worker 先把产生新记忆的隔离范围编码成 Profile L2 Key，再推进 `L2_schedule` Timer。该 Key 保留来源 Session，用于限制本次输入范围；最终场景目录则按 Team+Agent/Profile 共享。

默认调度参数为：L1 完成后延迟 10 秒、同一 Profile 两次 L2 至少间隔 900 秒、完成后再设置 3600 秒的最大兜底 Timer。下一次计划时间按下面的约束计算：

```text
desiredTime = max(now + delayAfterL1, lastL2 + minInterval)
```

`setTimerIfEarlier()` 只在新计划更早时推进 Timer，连续多次 L1 因而会被合并，而不是不断把执行时间向后拖延。L2 Task 使用 Agent/Profile 级分布式锁，确保同一 Agent 的多个 Session 不会并发修改共享 `scene_blocks` 和 `scene_index.json`。

### 增量输入选择

Worker 执行 L2 前从 Session State 读取 `l2_last_extraction_time`，作为 L1 的 `updatedAfter` cursor。随后按以下顺序选取输入：

1. 使用 Profile L2 Key 还原 Team、User、Agent、来源 Session 等过滤条件；
2. 只查询 `updatedAt > cursor` 的 L1，避免每次把所有原子记忆重新送入模型；
3. VectorStore 不可用时当前实现直接失败，不再使用 JSONL 作为 L2 输入源；
4. 查询为空时返回 `skipped=true`，不调用 LLM、不推进到 L3；
5. 将记录按隔离 Scope 分组。每组使用自己的 Storage、数据目录、Memory Prompt 和 Trace 身份；
6. 在支持 Profile Sync 时，先把远端 Scene/Persona 拉到本地或当前 Storage，形成包含版本号和内容 MD5 的写前基线。

这里的输入和输出边界并不完全相同：输入必须限定到触发 L1 的来源 Session，避免把其他 Session 尚未调度的数据提前消费；输出则汇总到同一 Team+Agent 的共享场景画像。

### SceneExtractor 构建算法

对每个隔离分组，`SceneExtractor.extract()` 执行以下阶段：

1. **准备目录与快照。** 创建 `scene_blocks` 和 metadata 目录。Local FS 模式先备份整个场景目录；Service/COS 模式不做本地备份，快照与恢复能力由 Storage Backend 承担。
2. **读取索引。** 加载 `scene_index.json`，提取每个现有场景的文件名、summary、heat 和更新时间；同时读取场景正文，形成变更前快照，供执行后判断 created/updated/deleted。
3. **执行容量约束。** 根据 `maxScenes` 生成分级提示：接近上限时优先 UPDATE/MERGE；只差一个时禁止 CREATE；达到上限时必须先合并相似场景。容量控制在 Prompt 中约束模型，后处理再以索引结果观测实际变化。
4. **构造增量 Prompt。** 输入只包含本批 L1 的正文、创建时间和 ID，同时附上已有 Scene 摘要、合法文件名、当前时间、容量告警和自定义 Memory Prompt。
5. **受限 LLM Agent 编辑。** LLM 开启文件工具，但工作区被限制在 `scene_blocks/`，无法直接访问 checkpoint、Persona 或其他系统文件。它依据语义选择创建场景、更新现有场景、合并多个场景，或用 `[DELETED]` 标记软删除文件。
6. **失败恢复。** LLM 超时或报错时，Local FS 模式恢复调用前的场景目录，避免部分写入泄漏到下一轮；Service 模式依赖 Storage 自身的一致性能力。恢复失败只记录附加告警，原始 LLM 错误仍作为主错误返回。
7. **清理输出。** 删除空文件、`[DELETED]` 文件，以及只有 META 头却没有正文的文件，防止已经合并或删除的场景重新进入索引。
8. **规范化文件名。** 在重建索引前统一处理空格、标点等非法或不稳定文件名，使 URL、Shell、导航解析和后续 Prompt 都使用同一规范名称。
9. **重建索引。** 从清理后的场景文件重新生成 `scene_index.json`，而不是信任 LLM 直接维护系统索引。
10. **更新导航。** 如果 `persona.md` 已有有效正文，则替换其中的 Scene Navigation；若 Persona 尚不存在或只有导航，不创建“只有索引没有 Persona”的文件。
11. **解析升级信号。** LLM 输出可以携带 Persona 更新请求；Extractor 将原因写入 checkpoint，由 L3 Trigger 在后续任务中优先处理。

### 同步、Checkpoint 与级联

Extractor 成功后，Runner 将变更后的 Profile 与写前基线比较，只同步内容 MD5 发生变化或新出现的场景，并通过版本基线执行远端乐观并发控制。随后写 L2 generation provenance，其中输入引用指向本批 L1 ID，输出引用指向发生变化的 Scene Profile。

只有成功处理且不是 empty extraction 时才增加 `scenes_processed`。Checkpoint 更新使用受分布式锁保护的单调计数修复，避免长时间 LLM 调用后用旧快照覆盖其他节点已经推进的 L1 cursor。

Runner 以本批 L1 最大 `updatedAt` 作为最新 cursor 返回。Service Worker 当前把执行时间写入 `l2_last_extraction_time`，因此需要持续验证“返回的记录 cursor”和“State 中保存的时间”具有一致语义，避免时钟或延迟导致漏读。

L2 返回 `skipped` 时不入队 L3；有效完成时清零 `l2_pending_l1_count`、记录上次 L2 时间、重新设置最大间隔 Timer，并立即入队一个 L3 Task。L3 Task 入队不表示 Persona 一定重建，还要经过 L3 Trigger。

相关实现：

- [`MemoryCore/src/utils/pipeline-factory.ts`](../MemoryCore/src/utils/pipeline-factory.ts)
- [`MemoryCore/src/core/scene/scene-extractor.ts`](../MemoryCore/src/core/scene/scene-extractor.ts)
- [`MemoryCore/src/core/scene/scene-index.ts`](../MemoryCore/src/core/scene/scene-index.ts)

## L3：Persona/Core Memory 层

### Profile 发现与触发判定

L3 Runner 首先扫描现有 Profile Scope；如果没有发现隔离目录，则退化到默认 Scope。每个 Scope 独立读取 checkpoint、Scene Index 和 Persona，防止一个 Agent 的画像变化影响另一个 Agent。

`PersonaTrigger.shouldGenerate()` 按优先级判断：

1. checkpoint 中存在 Agent 或 L2 显式写入的 `request_persona_update`；
2. 已经完成至少一次 Scene 提取、存在 Scene 文件，但从未生成过 Persona；
3. checkpoint 表示以前生成过 Persona，但当前 `persona.md` 丢失、为空或只有 Scene Navigation，需要恢复；
4. `scenes_processed === 1` 且存在尚未进入 Persona 的记忆，即首次 Scene Block 构建完成；
5. `memories_since_last_persona` 达到配置阈值，默认 `persona.triggerEveryN = 50`。

条件均不满足时，L3 Task 正常结束而不调用模型。即使 Trigger 命中，Runner 还会检查 Scene Index；没有场景文件时保持 checkpoint 不变，使冷启动条件可在下一次任务继续尝试。

### 增量输入选择

触发通过后，Runner 先拉取远端 Profile，记录版本与 MD5 基线，再由 `PersonaGenerator` 计算本次输入：

1. 读取已有 `persona.md`，剥离自动生成的 Scene Navigation，只把 Persona 正文作为旧版本；
2. 读取 Scene Index，以 `entry.updated > checkpoint.last_persona_time` 选择上次 Persona 更新后发生变化的场景；任一时间无法解析时按“已变化”处理，宁可多算而不漏算；
3. 读取变化场景的完整正文和 META。首次构建时所有场景都视为变化；
4. 如果没有变化场景且已有有效 Persona，Generator 直接返回不更新；
5. 根据是否存在旧 Persona 选择 `first` 或 `incremental` 模式。增量模式把旧 Persona 与变化场景同时交给模型，要求保留仍然成立的长期信息，并吸收新证据。

L3 的信息选择原则是跨场景稳定性：短期任务状态、一次性故障细节和具体 Tool 输出应停留在 L0/L1/L2；只有反复出现或明确声明为长期有效的偏好、约束、能力和工作方式才应上升到 L3。

### Persona 生成与后处理算法

Persona 构建按以下阶段执行：

1. 根据 Prompt Mode 选择“个人 Persona”或“团队操作准则”目标，并组合当前时间、已处理记忆数、场景总数、变化场景数、旧 Persona、触发原因和自定义 Memory Prompt。
2. Local FS 模式在调用 LLM 前备份 `persona.md`；Service/COS 模式当前不使用本地 BackupManager。
3. 运行启用文件工具的 LLM Agent，由模型直接写目标 L3 文件。调用设置独立 task ID、180 秒超时和完整 Trace 身份。
4. Runner 返回后重新读取目标文件。文件不存在、正文为空或 LLM 异常都视为生成失败。
5. 移除模型可能自行写入的旧 Scene Navigation，并对正文执行 XML tag escaping，避免 L3 在后续注入 system 时破坏外层记忆标签结构。
6. 根据当前 Scene Index 重新生成确定性的 Navigation，追加到 Persona 正文后再写回。导航由程序维护，模型只负责语义正文。
7. 将新 Profile 与远端基线比较；有变化时同步到 Profile Store，并写 generation provenance。L3 的输入引用指向 Scene 文件，输出引用指向 Persona Profile。
8. 最后调用 `markPersonaGenerated(total_processed)`：更新生成时间、已处理位置，清零或推进与 Persona 相关的累计状态，使下一轮只关注后续变化。

### 当前失败语义与风险

`generateLocalPersona()` 当前使用布尔值同时表达“没有场景变化”和“LLM/文件写入失败”。上层 `createL3Runner()` 对所有 `false` 都按 `skipped (no changes)` 处理，并执行 `markPersonaGenerated()`。这意味着真实生成失败也可能推进 Persona checkpoint，导致本应重试的变化被暂时视为已经处理。

更稳妥的返回类型应改为结构化状态：

```text
updated  → Persona 已成功变化，推进 checkpoint
noop     → 确认没有变化，允许推进 checkpoint
failed   → 生成或写入失败，不推进 checkpoint，交给任务重试/死信
```

此外，L3 依赖 LLM 维护长期一致性，单纯依靠 Prompt 很难阻止短期信息上浮或旧结论长期残留。后续应增加稳定性证据计数、冲突标记、来源覆盖率和最大正文预算，而不能只以“生成成功”作为质量标准。

相关实现：

- [`MemoryCore/src/core/persona/persona-trigger.ts`](../MemoryCore/src/core/persona/persona-trigger.ts)
- [`MemoryCore/src/core/persona/persona-generator.ts`](../MemoryCore/src/core/persona/persona-generator.ts)
- [`MemoryCore/src/utils/pipeline-factory.ts`](../MemoryCore/src/utils/pipeline-factory.ts)

## Service 模式下的调度角色


| 组件                      | 职责                                                            |
| ------------------------- | --------------------------------------------------------------- |
| `StatefulPipelineManager` | 维护对话计数、warm-up 阈值、L1/L2 Timer                         |
| `TimerScanner`            | 扫描到期的`L1_idle/L2_schedule` Timer 并入队                    |
| `PipelineWorker`          | 消费 L1/L2/L3 Task、抢分布式锁、重试、级联调度                  |
| `TaskExecutor`            | 调用真正的 L1 Extractor、L2 SceneExtractor、L3 PersonaGenerator |

锁粒度当前大致为：

- L1：Session 级；
- L2/L3：Agent/Profile 级，保护共享场景目录和 Persona；
- 不同 Agent 可并发。

## TIPS

记忆创建与更新不代表立即会注入当前session对话中：

```text
后台：L0 → L1 → L2 → L3 已更新 Store/COS

不代表

当前 Session 的 system prompt 已立即刷新
```

当前 Session 可能仍在使用初始化时预热的 Hook Cache 快照。要让新 L2/L3 明确进入上下文，通常需要：

- 新建 Session；
- `mem:sync` 清理并重新预热；
- Hook Cache 过期或缺失后的 self-heal；
- L2b 重建后重新 prewarm；
- 后续实现资产版本事件驱动刷新。

---

# 记忆注入与 KV Cache

## 模块功能总结

记忆注入的目标不是把所有历史都塞进 Prompt，而是在上下文预算、相关性和缓存稳定性之间分层处理：

- Agent/Task：作为 Session Context 每轮附加；
- L3 Persona：完整或截断后直接注入 system；
- L2：只注入路径和 summary 索引，正文按需读取；
- L0/L1：不再每轮自动召回，模型需要时通过只读工具检索；
- Hook Cache：缓存已经生成的注入块，减少 Core/COS 查询并稳定文本；
- KV/Prompt Cache：由上游模型服务维护，Proxy 只负责尽量保持前缀稳定。

## 记忆注入时机

### Session 初始化完成时

当状态首次进入 `initialized` 且没有 bypass：

1. Session 模块生成 `<session_context>`；
2. Handler 调用 `prewarmFromConfig()`；
3. `session_init/hybrid` Hook 并行读取 Skill、Knowledge、L2/L3 等；
4. 生成的 `ContextBlock[]` 写入 HookCacheRepo；
5. 同一请求随后进入 Injection Pipeline 并读取这些块。

### init后每个正常请求

```text
SessionStore.getOrRecover()
  → L1 terminal hit，直接取得 Agent/Task detail
  → 不访问 L2a/L2b，不重新进入初始化表单
  → 对当前原始请求附加 Session Context
  → InjectionPipeline 按 Hook 顺序执行
  → session_init Hook 优先读 Hook Cache
  → serialize 成 Anthropic 请求
```

### 模型主动查询时

当用户询问“xxx”时，system 中的 `<tdai_memory_tools>` 会指导模型调用：

```bash
curl .../memory-bridge/v3/conversation/search \
  -d '{"query"xxx"}'
```

Proxy Bridge 根据 `spaceId+sessionId` 从 L1/L2b 恢复身份，自动补充 Team/User/Agent 权限，再把 L0 查询结果作为当前轮 Tool Result 返回模型。

## 注入形式

### Session Context

```xml
<session_context>
[Agent]
...
[Task]
...
</session_context>
```

它决定模型当前扮演的 Agent 和执行的 Task。

### L3 与 L2 索引

`tdai-profile-memory-injector` 输出格式如下：

```xml
<tdai_profile_memory>
  <agent name="DBA Agent" role="self" agent_id="agent-dba">
    <l3_core_memory>
      用户偏好先验证、再灰度、必须有回滚方案。
    </l3_core_memory>
    <l2_scene_index>
      - `scene_blocks/database-performance.md` — 订单库慢查询和索引治理经验
      - `scene_blocks/release-safety.md` — 生产变更、灰度和回滚规范
    </l2_scene_index>
  </agent>
</tdai_profile_memory>
```

当前实现对单份 L3 最多截断到 6000 字符；L2 summary 最多约 200 字符，只给索引，不在预热时读取全文。

### L0/L1/L2 读取工具

`tdai-tools-injector` 注入 `<tdai_memory_tools>`，主要能力包括：


| 工具语义                          | 数据层 | 用途                             |
| --------------------------------- | ------ | -------------------------------- |
| `tdai_conversation_search/query`  | L0     | 找原始对话、引用和时间线         |
| `tdai_memory_search/atomic_query` | L1     | 找偏好、事实、规则和原子工作记忆 |
| `tdai_scenario_ls`                | L2     | 刷新或过滤场景索引               |
| `tdai_read_scene`                 | L2     | 按已知 path 读取场景正文         |

L3 已直接注入，因此没有每轮读取 L3 的必要。

### 协议中的落位


| 协议               | Session/记忆注入位置                                 | 注意点                                   |
| ------------------ | ---------------------------------------------------- | ---------------------------------------- |
| Anthropic Messages | 顶层`body.system` 的 text blocks                     | 要保留 block 结构和`cache_control`       |
| OpenAI Chat        | `messages` 中的 system message                       | 依赖上游隐式 Prefix Cache 规则           |
| Codex Responses    | 合成 OpenAI body 跑 Pipeline，再写回 developer/input | input item 顺序和 tool 语义必须保持      |
| WorkBuddy/DSH      | 根据各自协议适配器和表单重渲染                       | 不能只验证中间格式，必须看最终 wire body |

## 记忆注入调用链

```text
handleAnthropicMessages()
  → SessionStore.getOrRecover()
  → injectSessionContextIntoAnthropicSystem()
  → prewarmFromConfig()（首次/恢复/当前实现中的 terminal 信号）
       → prewarmAll()
       → hook.prewarm()
       → HookCacheRepo.putMany()
  → InjectionPipeline.process()
       → AnthropicAdapter.parse()
       → resolveHookBlocks()
            none         → execute()
            session_init → cache get；miss 后 execute + self-heal
            hybrid       → cached + fresh 去重合并
       → applyInjection()
       → AnthropicAdapter.serialize()
  → forwardWithRetry()
```

主要代码：

- [`MemoryProxy/src/injection/prewarm.ts`](../MemoryProxy/src/injection/prewarm.ts)
- [`MemoryProxy/src/injection/pipeline.ts`](../MemoryProxy/src/injection/pipeline.ts)
- [`MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts`](../MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts)
- [`MemoryProxy/src/injection/injectors/tdai-tools-injector.ts`](../MemoryProxy/src/injection/injectors/tdai-tools-injector.ts)

## Injection Hook Cache

Hook Cache 保存的是协议无关 `ContextBlock[]`，不是模型 KV。目的是减少Core/COS读取；固定注入文本。

逻辑 Key：

```text
spaceId + userId + agentSource + sessionId + hookId
```

缓存策略：


| 策略           | 行为                                        | 适用场景                    |
| -------------- | ------------------------------------------- | --------------------------- |
| `none`         | 每轮执行`hook.execute()`                    | 强依赖当前请求的动态内容    |
| `session_init` | 初始化预热，后续只读缓存；miss 时 self-heal | Skill、工具说明、L2/L3 快照 |
| `hybrid`       | 缓存块和当前轮 fresh block 合并去重         | 稳定资产 + 动态结果         |

后端可以是 SQLite、Redis 或 ProxyStorage/COS。其收益有两层：

1. 少访问 Metadata、Knowledge、Memory、COS，降低注入阶段延迟和 QPS；
2. 同一 Session 反复使用相同字节，为上游 Prompt Cache 命中创造条件。

## KV Cache 与 Prompt Cache

KV Cache 是 Transformer 推理过程中 Prompt Token 对应的 Attention Key/Value 中间状态；Prompt Cache 是上游 API 对这类前缀复用能力的产品化管理，包括匹配、TTL、淘汰、隔离和计费。

本项目不保存模型 KV，也不能强制上游命中。我们能控制的是：

```text
system/developer 文本稳定
+ messages 前缀 append-only
+ tools 顺序、描述和 JSON Schema 稳定
+ 注入块文本与顺序稳定
+ model/upstream/租户隔离域不变
+ cache_control 位置和结构稳定
= 具备命中条件
```

项目中的稳定前缀构建如下所示：
```text
客户端原始 cache_control
+ Anthropic Adapter 保留 marker
+ SessionStore 固定 Agent/Task 绑定
+ Hook Cache 固定注入内容
+ 固定 Injection Point 与 priority
+ L2/L3 Session 快照
+ L0/L1 改为按需读取
+ 多 Pod 使用统一 Gateway URL
+ mem:sync 形成显式刷新边界
```

“语义相同”不等于“可缓存前缀相同”。空格、换行、block 拆分、Tool 顺序或 Schema 字段变化都可能使 token 序列变化。

## KV Cache 在不同阶段的行为


| 阶段                       | 是否请求上游 | Hook Cache              | KV/Prompt Cache 行为                        | 主要收益与边界                     |
| -------------------------- | -----------: | ----------------------- | ------------------------------------------- | ---------------------------------- |
| 首次弹资产确认表单         |           否 | 尚未预热                | 无读写                                      | 只推进 SessionStore                |
| Team/Agent/Task 选择       |           否 | 通常无                  | 无读写                                      | 表单快，但历史会留在客户端消息中   |
| 初始化完成后的首个业务请求 |           是 | 预热并读取              | 新增 Session/Memory 前缀，通常 create/miss  | 为后续稳态建立新前缀，首轮成本最高 |
| 同一轮 Tool Loop           |           是 | 命中                    | 稳定前缀 + 新 Tool Result，复用价值通常最高 | 新后缀仍需计算                     |
| 后续 main turn             |           是 | 设计上命中              | 历史 append-only 时可以复用已有长前缀       | 新 user/assistant 内容仍计入推理   |
| Fork/summary               |           是 | 只读；miss 不 self-heal | 尽量复用 Main 前缀                          | fresh Hook 输出不同仍会 miss       |
| sidequery/title            | 是或独立处理 | 跳过                    | 独立短 Prompt                               | 不与主会话共享记忆语义             |
| L2b 长睡恢复               |           是 | 重新预热                | Agent/Task/Memory 可能更新，常建立新前缀    | 获得新鲜内容但牺牲旧缓存           |
| `mem:sync` 后              |   命令本身否 | 清理并重建              | 下一业务请求建立新版本                      | 显式刷新边界可解释                 |
| Compaction                 |           是 | Hook Cache 不一定变     | messages 历史被重写，消息侧前缀大概率失效   | 稳定 system breakpoint 仍可能复用  |
| 上游 KV TTL 到期           |           是 | Hook Cache 仍可能命中   | 上游重新 create                             | 两类缓存生命周期互相独立           |

## KV Cache 抓包观测

### usage：已有缓存读取命中

发送一次 Claude code的派生请求前缀缓存命中：

```text
source=away_summary
input=124
output=47
cacheRead=29184
cacheCreate=0
```
相关log如下：
```plaintext
解释：
2026-08-25T07:28:01.274Z [DEBUG] [API REQUEST] /claude-code/default/v1/messages source=away_summary
2026-08-25T07:28:03.602Z [DEBUG] Stream started - received first chunk
2026-08-25T07:28:03.602Z [DEBUG] [API:timing] first byte after 2330ms
2026-08-25T07:28:03.604Z [DEBUG] Forked agent [away_summary] received message: type=assistant
2026-08-25T07:28:03.607Z [DEBUG] Forked agent [away_summary] finished: 1 messages, types=[assistant], totalUsage: input=124 output=47 cacheRead=29184 cacheCreate=0

```

- 上游返回了 Prompt Cache 读指标；
- 本次只新增了 124 个 input token，却复用了约 29184 个缓存 token；
- `cacheCreate=0` 表示这次没有建立新的缓存前缀；
- 这类“长稳定前缀 + 短增量请求”正是 KV Cache 收益最明显的场景。

但它不能单独证明所有 main turn 都能命中，也不能证明命中来自哪一个具体 breakpoint。需要把上游 usage 与最终请求 prefix hash、marker 位置关联起来。

## KV Cache 的收益

- 降低长 system、tools 和历史前缀的重复 prefill；
- 降低 TTFT；
- 对支持缓存计价的上游降低重复输入费用；
- Tool Loop 中通常能复用绝大部分上文；
- Hook Cache 让注入内容更稳定，减少无意义的模型 cache miss；
- 稳定 Session 快照让同一会话中的行为更一致。

## KV Cache 的边界

- 缓存 Token 通常仍占模型上下文窗口；
- Cache hit 不保证记忆正确、相关或新鲜；
- 新 user、Tool Result 和 assistant 输出仍需计算；
- Prefix Cache 只复用连续前缀，中间插入会使后续失效；
- 不同模型、端点、租户、鉴权隔离域通常不能共享；
- 上游 TTL、最低缓存长度、淘汰和计费规则不由 Proxy 控制；
- system 很长时，即使全部命中，也可能挤占对话和 Tool Result 的可用窗口。

---

# 思考

## OpenClaw / DSH 插件接入

### 难点

- OpenClaw 是 Hook/Plugin 模型，DSH 当前走 OpenAI Chat Handler 和 `ask_user_question` 表单，两者的生命周期不同；
- OpenClaw 版本对 `allowPromptInjection/allowConversationAccess` 等配置字段有严格兼容边界；
- DSH headless 模式没有交互 Tool，当前会 bypass Session Init；
- compaction/title 等辅助请求必须从 L0 和 Skill 归档中排除；
- 待调研的 OV 需要先确认协议、Session ID、Tool 模型、stream usage 和插件生命周期。

### 当前基础

仓库已经存在：

- `MemoryCore/openclaw-plugin` 客户端插件；
- `MemoryCore/hermes-plugin` Provider；
- `MemoryProxy/src/agent-adapters/dsh.ts`；
- DSH 路由、headless bypass 和表单重渲染逻辑。

因此后续重点不是从零开发，而是形成兼容矩阵和真实端到端验收。

### 方案方向

1. 定义统一 Plugin Capability：

```text
supportsInteractiveForm
supportsPromptInjection
supportsConversationCapture
supportsNativeTools
supportsStreamingUsage
supportsCompactionSignal
```

2. 各客户端只负责上报能力，Session/Memory 主链不再依赖大量 `agentSource===...` 分支；
3. 为 OpenClaw、DSH、OV 各保留一份真实抓包 fixture；
4. 测试初始化、正常对话、Tool Loop、compaction、长睡恢复和无 UI/headless 六类场景。

### 验收建议

- 插件安装/卸载和版本兼容说明完整；
- main 对话只写一次 L0；
- auxiliary 请求不写记忆；
- Session ID 在重启、Fork 和 compaction 后保持一致；
- 有 UI 时可完成 Team/Agent/Task 绑定，无 UI 时有可解释的 preset/bypass 路径。

## Hermes 交互式 Tools 接入

### 难点

- Hermes 的 Tool Call 事件、参数校验、Tool Result 回填和多轮 agent loop 需要与现有 curl guide 模式对齐；
- Tool 是原生 schema 还是 Prompt 中的使用说明，会直接影响模型选择、权限和 KV Cache；
- 流式响应中的 Tool Call 增量、并行 Tool、超时和重试容易出现状态不一致；
- 记忆 Tool 必须由服务端恢复身份，不能让模型伪造 `team_id/user_id/agent_id`。

### 方案方向

优先做“原生只读 Tools”，将以下能力注册为 Hermes Tool：

```text
memory_search
conversation_search
scenario_ls
read_scene
```

Tool 输入只暴露业务字段，身份从可信 Session Context 获取。执行链统一复用 Memory Bridge/SDK，而不是在 Hermes 插件里重新实现权限逻辑。

需要验证：

- Tool schema 是否稳定，是否进入 Prompt Cache 前缀；
- Tool Result 如何进入下一轮上下文；
- 并行 Tool Call 是否需要 per-session 顺序约束；
- Tool 失败时模型看到的是结构化错误还是网络异常；
- 一轮最多检索次数如何从 Prompt 约束升级为服务端策略。

## Session 隔离：新方案设计

### 当前问题

- L1 Key 只有 `agentSource:sessionId`，没有直接包含 `spaceId/userId`；
- L2a 使用四段身份，L2b 又拍平为两段；
- Main/Fork/Sidequery 是否属于同一 Session 缺少统一的 parent/branch 模型；
- Session 生命周期、Task 生命周期和记忆归属边界没有完全解耦；
- 跨客户端迁移时同一个对话是否应共享记忆，目前难以解释。

### 建议的新模型

定义三个 ID，而不是让一个 `sessionId` 承担全部语义：

```text
conversation_id：用户可理解的长期对话
execution_id：一次客户端运行/连接，可重启
branch_id：Main/Fork/Subagent/Compaction 分支
```

权威隔离键建议为：

```text
tenant(spaceId)
+ principal(userId)
+ asset_scope(teamId, agentId, taskId)
+ conversation_id
+ branch_policy
```

并明确记忆归属：

- L0 默认记录 Main conversation；
- Fork 是否合并回 Main 必须有显式策略；
- L1 可以保留 source conversation/branch；
- L2/L3 按 Agent/Profile 聚合，但必须保留 provenance；
- Binding 只能帮助恢复，不能取代权限校验。

### 落地路径

1. 先引入新版 `SessionIdentityV2`，保持旧 Key 双读；
2. 新写只写 V2，同时保留回滚开关；
3. 增加跨租户碰撞、Session ID 重用、Fork、重启、多 Pod 测试；
4. 迁移稳定后再清理旧 L1/L2a/L2b Key。

## OpenAI Chat ↔ Anthropic 双向转换

### 主要难点

- Anthropic 的 `system` 是顶层字段，OpenAI 的 system/developer 在 messages 中；
- `tool_use/tool_result` 与 `tool_calls/tool` 的 ID 和配对规则不同；
- Anthropic content block 可混合 text/image/thinking，OpenAI Chat 表达能力不同；
- `cache_control` 没有直接的 OpenAI Chat 等价物；
- stop reason、stream event、usage 和错误码需要转换；
- 记忆注入应发生在转换前还是转换后，影响落位和字节稳定性。

### 方案方向

不要写两套互相调用的临时转换函数，应该建立协议无关 IR：

```text
CanonicalRequest
  systemBlocks[]
  messages[].blocks[]
  tools[]
  toolCalls/toolResults
  cacheHints[]
  reasoningBlocks[]
  usage
```

推荐顺序：

```text
源协议 parse → Canonical IR → Session/Memory Injection
→ 目标协议 serialize → 最终 body/token 计算
```

Token 不能在 IR 阶段用字符数简单估算。至少应区分：

- 源协议看到的 Token；
- 注入后 Canonical 内容估算；
- 目标模型 tokenizer 的最终 Input Token；
- 上游返回的 cache read/write tokens。

## OpenAI Responses ↔ Anthropic 双向转换

### 为什么更难

Responses API 的 `input[]/output[]` 不只是 Chat Messages：

- developer/user message；
- `function_call/function_call_output`；
- reasoning item；
- item ID 和 previous response 关系；
- 可能存在 built-in tool、computer use 和异步语义。

如果简单转成 Chat 再转回，会丢失 item 边界、reasoning、Tool ID 或输出语义。

### 方案方向

在同一 Canonical IR 中保留：

```text
sourceItemId
itemType
callId
parent/previousResponseId
visibility（模型可见/仅客户端可见）
reasoning metadata
```

记忆注入应成为独立的 `developer/system injection segment`，带来源和版本，而不是直接拼到任意 `input[0].content`。这样才能：

- 在 Responses 与 Anthropic 间稳定落位；
- 单独计算注入 Token；
- 避免重复注入；
- 保留 cache breakpoint/hint；
- 在调试时知道哪段是客户端原文、哪段是 Proxy 注入。

## 其他探索：Opik 可观测接入

### 当前问题

项目已经有 Opik Trace/LLM Span 接入，但要支撑主线课题，还缺少“Session—注入—缓存—记忆构建”的统一关联。

### 建议观测模型

一个用户 Turn 下至少关联：

```text
Session Init Span
  → Session cache path: L1/L2a/L2b/history
Injection Span
  → 每个 Hook 的 hit/miss、hash、版本、耗时、token
LLM Span
  → model、TTFT、input/output、cache read/write tokens
Tool Spans
  → tool name、call id、memory layer、结果数、耗时
Archive Span
  → L0 write id
Async Pipeline Trace
  → L1/L2/L3 task id、触发原因、输入输出 provenance
```

不要直接记录完整敏感 Prompt 作为默认方案，建议记录：

- `session_identity_hash`；
- `asset_epoch/template_version`；
- `system_hash/tools_hash/message_prefix_hash`；
- `hook_id/content_hash/cache_status`；
- `cache_control` marker 位置；
- 各注入段 Token 数；
- L0/L1/L2/L3 generation ID 和 source message IDs。

这样一次 KV miss 才能回答：是模型变了、compaction 了、某个 Hook 漂移、Pod 配置不同，还是上游 TTL 到期。

## 参考代码入口

- Anthropic 主链：[`MemoryProxy/src/anthropicHandler.ts`](../MemoryProxy/src/anthropicHandler.ts)
- Session 分派：[`MemoryProxy/src/session/index.ts`](../MemoryProxy/src/session/index.ts)
- Claude Code Session 状态机：[`MemoryProxy/src/session/claude-code/init.ts`](../MemoryProxy/src/session/claude-code/init.ts)
- SessionStore：[`MemoryProxy/src/session/store.ts`](../MemoryProxy/src/session/store.ts)
- Session ID 解析：[`MemoryProxy/src/session/session-key.ts`](../MemoryProxy/src/session/session-key.ts)
- Session Context：[`MemoryProxy/src/session/context-injector.ts`](../MemoryProxy/src/session/context-injector.ts)
- Injection Pipeline：[`MemoryProxy/src/injection/pipeline.ts`](../MemoryProxy/src/injection/pipeline.ts)
- Hook Prewarm：[`MemoryProxy/src/injection/prewarm.ts`](../MemoryProxy/src/injection/prewarm.ts)
- L2/L3 注入：[`MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts`](../MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts)
- L0 Recorder：[`MemoryProxy/src/tdai/recorder.ts`](../MemoryProxy/src/tdai/recorder.ts)
- L0 Gateway 写入：[`MemoryCore/src/gateway/v2-router.ts`](../MemoryCore/src/gateway/v2-router.ts)
- L0 Hook 捕获：[`MemoryCore/src/core/conversation/l0-recorder.ts`](../MemoryCore/src/core/conversation/l0-recorder.ts)
- Memory Pipeline 调度：[`MemoryCore/src/utils/stateful-pipeline-manager.ts`](../MemoryCore/src/utils/stateful-pipeline-manager.ts)
- L1/L2/L3 Runner：[`MemoryCore/src/utils/pipeline-factory.ts`](../MemoryCore/src/utils/pipeline-factory.ts)
- Pipeline Worker：[`MemoryCore/src/services/pipeline-worker.ts`](../MemoryCore/src/services/pipeline-worker.ts)
- L1 Extractor：[`MemoryCore/src/core/record/l1-extractor.ts`](../MemoryCore/src/core/record/l1-extractor.ts)
- L1 冲突检测：[`MemoryCore/src/core/record/l1-dedup.ts`](../MemoryCore/src/core/record/l1-dedup.ts)
- L2 Scene Extractor：[`MemoryCore/src/core/scene/scene-extractor.ts`](../MemoryCore/src/core/scene/scene-extractor.ts)
- L3 Persona Trigger：[`MemoryCore/src/core/persona/persona-trigger.ts`](../MemoryCore/src/core/persona/persona-trigger.ts)
- L3 Persona Generator：[`MemoryCore/src/core/persona/persona-generator.ts`](../MemoryCore/src/core/persona/persona-generator.ts)
- 真实 Claude 日志：[`captures/claude-client.log`](../captures/claude-client.log)
