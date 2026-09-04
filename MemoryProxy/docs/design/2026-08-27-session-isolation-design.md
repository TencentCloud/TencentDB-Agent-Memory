# Session 隔离新方案设计（TRACK 04）

## 1. 目标与非目标

**目标**

1. 回答「会话的边界到底是什么、记忆归谁」：任何两个请求都可判定
   「是否同属一个逻辑会话」；
2. 覆盖跨客户端续接、重启恢复、无会话 ID 客户端（Hermes / OpenClaw /
   DSH / Codex / WorkBuddy）、跳过（bypass）状态自愈、多实例部署五类真实场景；
3. 隔离是**纵深防御**而不是单点检查：解析层、会话恢复层、记忆写侧
   各有一道可观测的防线；
4. 提供可验证的落地路径与命令行验证方法。

**非目标**

- 不改变现有 Session Init 表单交互；
- 不重复实现控制面的授权管理：grant 的权威来源仍在 Memory Hub / 控制面，
  Proxy 消费「可访问命名空间集」；
- 不把 Redis 共享会话表设为硬依赖：单机/多副本先用「确定性派生 + 共享签名
  密钥」逼近跨实例收敛，Redis 共享表作为独立后续课题（见 §7.3），
  避免把隔离正确性押在存储中间件上。

## 2. 会话键与归属模型（v3 现状）

### 2.1 复合键单点约定（已实现）

会话状态的 store 键统一由 `session/store.ts::buildStoreSessionKey` 生成，
改约定只动这一处：

```
storeSessionKey = agentSource : sessionKey [ : threadId ]

agentSource : 客户端族前缀（workbuddy 状态机历史复用 codex → 自动别名 codex）
sessionKey   : 显式会话 ID / auto- 生成 ID / 无 ID 时的稳定兜底键
threadId     : 仅 threadIsolation.enabled=true 且带 x-thread-id 时追加
```

调用点已全部收敛（handler 与 fence 不再各自拼键）：

- 4 个 handler：`anthropicHandler.ts` / `handler.ts` / `codexHandler.ts` /
  `workbuddyHandler.ts`；
- 3 个路由：`session-force-archive.ts` / `session-refresh.ts` /
  `session-task.ts`（workbuddy 会话因此也能被 force-archive / refresh 命中）；
- 遥测：model-intent 埋点与 session-init 日志的 composite 键对齐（threadIsolation
  开启时均带 `:threadId` 后缀）；
- 归档写侧 fence：`stages/archive.ts::writeL0` 用同一函数构造候选键。

### 2.2 隔离判定维度（已实现）

| 维度 | 键 / 输入 | 作用 | 权威来源 |
|---|---|---|---|
| 身份锁 | `user_id` | 防跨用户串号 | auth/verify；store L1 归属校验 |
| 归属锁 | `space_id + team_id + agent_id + task_id` | 决定记忆/技能可访问范围 | 控制面注册结果（SessionInit） |
| 会话锁 | `agentSource:sessionKey` | 对话历史连续性与注入目标 | 客户端上报（仅检索键）+ 签名校验 |
| 线程 scope | `x-thread-id` | auto ID 签名绑定 + 进程内 L1/状态机键分组与遥测（默认关） | 客户端显式上报 |
| 首问指纹 | 首条用户消息指纹 | per-key-msg 窗口隔离；auto ID 签名绑定 | Proxy 派生 |
| 存储层 | `spaceId` 命名空间（缺省 `_default`） | 恢复/绑定的物理命名空间兜底 | 部署声明 |

判定规则：身份锁不一致、或归属锁中的 space 不一致 → 一律视为**新会话**
（store 恢复层直接拦截，见 §4.1）；会话锁的变化在身份/归属一致时允许
「续接」而非「新建」。

线程维度当前定位：`threadIsolation` 默认关；开启后 `x-thread-id` 进入
L1/状态机 store 键与遥测/审计分组（auto ID 签名 scope 也绑定 thread），
但**持久层（L2a/L2b）键不含 thread**——重启或换副本后按
(space, user, agent, sessionId) 收敛，不承诺跨实例的 thread 级隔离（见 §7.4）。

### 2.3 信任边界（已实现）

- 客户端上报的 `x-conversation-id` / `session-id` / `client_metadata.session_id`
  只是**检索键**，会话注册后的权威身份来自 auth/verify + 控制面；
- Proxy 自签的 `auto-` ID 带 HMAC 签名，无法伪造、无法跨线程/跨窗口/换 key
  复用（§3.3）；
- 兜底键（无任何会话 ID）由 Proxy 按 keyId + 首问指纹派生，客户端不可控。

## 3. 会话解析：统一入口（阶段化，已实现）

### 3.1 sessionStage + SessionAdapter

`stages/session.ts::sessionStage` 是 4 个 handler 的会话解析唯一入口，
客户端差异收敛到 `SessionAdapter`（`stages/types.ts`）：

```ts
interface SessionAdapter {
  extractRawSessionId(c, lcHeaders, body): string | null;  // 显式 ID
  userMessages(body): unknown;            // chat 取 body.messages，responses 取 body.input
  fallbackSessionKey(ctx, keyId, lcHeaders): string | null; // 无 ID 兜底
  resolveThreadId(c): string | null;
  autoGenerate?: boolean;                 // workbuddy = false（原行为不生成）
  resolveIdentity(ctx, keyId): { keyId, userId, callerUserKey };
}
```

接入差异：

- **chat / anthropic**（`handler.ts` / `anthropicHandler.ts`）：
  `DEFAULT_SESSION_ADAPTER`，`resolveEffectiveConversationId` 统一显式 ID 优先、
  缺失按 `autoConversationId` 生成；
- **codex / workbuddy**（`codexHandler.ts` / `workbuddyHandler.ts`）：共用
  Responses wire 的通用适配器（`createResponsesSessionAdapter` /
  `RESPONSES_SESSION_ADAPTER`）——显式会话 ID 从 `session-id` header /
  `client_metadata.session_id` 提取；codex 走 auto 分支（实际生成仍受
  `autoConversationId.enabled` 门控），workbuddy 用 `autoGenerate: false`
  实例（与 workbuddy 原行为一致，不主动生成 auto ID）；
- `handler.ts` 的 `debugForceUserId` 由 `resolveIdentity` 处理，身份改写策略
  不再散落在各 handler。

### 3.2 显式会话 ID 优先（已实现）

任何客户端带了非空显式会话 ID 时，该 ID 直接作为会话锁（不回退、不覆盖），
保证与客户端本地会话状态一致；`auto-` 前缀的 ID 仍需通过签名校验（§3.3）。
即使 `autoGenerate:false` 的客户端（workbuddy）回传 `auto-*` ID，也会先做
签名校验：拒绝后置空并回退兜底键，防止绕过签名把幽灵会话键塞进 store。

### 3.3 auto 会话 ID：签名绑定 + 确定性派生（已实现）

`session/auto-session.ts` 为无显式会话 ID 的客户端生成会话锁，格式：

```
auto-<hmac16>-<uuid>
```

**签名绑定**：HMAC 输入为 `keyId \0 scope \0 首问指纹 \0 uuid`，即 ID 只能由
「同一 key + 同一 scope（thread）+ 同一首问指纹」校验通过。跨线程、跨窗口、
换 key、伪造一律拒绝：

- 拒绝发生在带 scope/指纹的绑定上下文 → 计 `scopeRejected`；
- 默认上下文（无 scope/fp，纯签名失败/换 key/伪造）→ 计 `ghostRejected`；
- **ghost 回退修复**：`auto-` 未开启（配置关闭）时签名不符的 auto ID 置
  `rejected: true`，调用方**不得回退到 raw**——避免「幽灵会话」把历史记忆
  错绑到新身份。

**策略**（`strategy`）：

- `per-key`（默认）：一个 key（有 scope 时按 `keyId\0scope`）一个活跃会话；
- `per-key-msg`：同一 key 按「首问指纹 + scope」分多个窗口（每 key 上限 8、
  全局上限 4096），指纹相同的跨请求续接同一会话；

TTL 默认 30 分钟（`ttlMinutes` 可调），进程内 Map 有界（`maxEntries=2048`）。

**确定性派生**（`deterministic: true`）：

```
uuid = HMAC(keyId, scope, 首问指纹|"", epoch)[:36]
epoch = floor(now / max(ttlMs, deterministicBucketMinutes * 60_000))
```

- 同一 (keyId, scope, fp, epoch) 在任意实例 / 重启后收敛到同一 sid——
  多副本无共享状态下的最优近似；
- 活跃会话仍由进程内 Map 续接；空闲跨桶的会话随 epoch 滚动自然轮换；
- `deterministicBucketMinutes`（可选）把桶宽钉在 ≥ ttlMinutes 的值，
  只调 ttl 不触发全量轮换；配置校验：`deterministicBucketMinutes ≥ ttlMinutes`
  （见 `config.ts`，防空闲跨桶未过期时确定性碰撞）；
- 默认 `deterministic: false` = 随机 uuid（向后兼容）。

### 3.4 无 ID 兜底键：从 traceId 改为稳定键（已实现）

codex / workbuddy 无显式会话、且 auto 未生成时：

```
fallback = keyId : msg-<首问指纹sha256-16> : <UTC 日桶>
```

- 同首问跨请求稳定（不再是逐请求 `keyId:traceId`，消除孤儿记忆）；
- 跨天自动轮换（`day = floor(now/86400s)`），避免不同日期的请求被合并成
  永续会话；
- 提取不到首问指纹时退回 `keyId:traceId` 临时键，并对每个 keyId 只 warn 一次。

## 4. 归属 fencing：两道防线（已实现）

### 4.1 store 恢复层（第一道）

`session/store.ts`：

- `bind(keyId, identity)`：keyId → (userId, agentSource, sessionId, spaceId)
  一次性绑定；检测到同 keyId 被另一 userId / space 接管时输出
  `ownership takeover` 告警日志；
- `getOrRecover` 的 L1 命中与 L2a-miss 的 L1 兜底都过 `l1OwnedBy(state, identity)`：
  校验 state 自带 `userId` / `sessionInfo.user_id` 与
  `sessionInfo.space_id`——跨用户、跨 space 同 keyId → 视为新会话
  （记 `L1 owner mismatch → treat as new session`），**不短路**正常会话；
- 持久化（L2a SessionRepo / L2b BindingRepo）本身按
  `(spaceId, userId, agentSource, sessionId)` 命名空间化（缺省 space = `_default`），
  应用层键漂移不会跨租户命中。

### 4.2 archive 写侧（第二道）

`stages/archive.ts::writeL0` 在真正写 TDAI L0 之前做一次归属 fence：

1. 候选键用 `buildStoreSessionKey` 生成：有 threadId 时先查 `:thread` 后缀键，
   再查基础键；workbuddy 额外兼容历史 `workbuddy:` 前缀绑定；
2. 命中候选键后读绑定身份（`getBoundIdentity`）或 L1 态的
   `sessionInfo.space_id`；
3. 写入会话的 space 与已绑定 space **不一致** → 跳过 L0 +
   `[archive-fence] L0 skipped: session ownership drift` + 计 `fenceBlocked`；
4. 命中且一致 → 正常写入并计 `fenceAllowed`（放行计数是衡量防线有效性的分母）；
5. L1（进程内）未命中时，用 **binding repo** 按 `(spaceId, sessionKey)` 补查
   （多节点共享层）；命中视为与写侧 space 同域 → 放行；
6. 仍查不到绑定信息 → 计 `fenceMiss`（不拦截，fail-open on unknown），
   并进入 `fenceCoverage` 的分母（§6.2）。

设计取舍（代码注释已写明）：

- fence **只比 space**，不比 userId / agentSource——auth userId 与 kernel
  user_id 语义不同；workbuddy 会话的 store agent 标签是 codex，比 agent 会误杀；
- 无绑定但 L1 有态时用 state 自带 space 兜底（不依赖 bind 时序）；
- 它拦的是「store 已绑定/有态，但归档写入上下文归属漂移」的纵深场景；
  store 恢复层拦截跨用户会话态恢复是主要隔离面。

### 4.3 已知边界（如实记录）

- store 绑定发生在 session-init / getOrRecover；codex / workbuddy 若走共享
  init 路径则两道 fence 都生效（有 `session-store-fence` / `stages-archive`
  单测覆盖）；
- fence 目前只做「拦截 + 计数」，不做自动重绑定——漂移时宁可丢一次 L0 写，
  也不写错归属（fail-closed 取向）。
- binding 补查只按**写侧 space** 查询命名空间；若绑定落在其它 space 且 L1 为空，
  跨 space 漂移仍可能被计为 fenceMiss 而非 fenceBlocked（纵深防御的已知边界）。

## 5. 生命周期

### 5.1 SessionInit 状态机与持久化（已实现，语义不变）

```
uninitialized → pending_asset_confirm → pending_team_select
             → pending_agent_select / pending_task_select → initialized
             → bypassed（用户选"否" / 无可用资产 / gate 截断等）
```

- 状态持久化到存储层（SessionRepo L2a，按 space/user 命名空间）；
- `headerAutoSelect`：带 `x-team-id / x-agent-id / x-task-id` 且命中用户自己
  的 team 列表 → 直接注册（preset hit）；伪造他人 team → mismatch → form/bypass；
- **跳过状态自愈**（已实现）：`bypassed` 会话若新一轮请求带完整
  team/agent header 且 `headerAutoSelect.enabled` → 清掉 bypass 状态重新走
  preset 注册（`session/codebuddy/init.ts` 的 bypass self-heal 段），
  避免「被动跳过」长期锁死记忆能力；
- `auth.failPolicy` 默认 fail-closed：auth 服务不可达时拒绝，不放行。

### 5.2 auto 会话 TTL / 淘汰 / 有界台账（已实现）

`index.ts` 定时 `pruneExpiredSessions(ttl)`，会话结束统一进
**有界台账**（上限 512，最早的被挤出）：

```
ExpiredSessionEntry { sid, keyId, scope, reason, lastSeen, expiredAt }
reason ∈ expired | pruned | evicted
```

- `pruned`：定时器清理（per-key 表 / per-key-msg 窗口）；
- `expired`：续接时发现同 key 旧会话已过 TTL；
- `evicted`：per-key 容量超限 / per-key-msg 窗口超限（`windowEvicted`）/
  全局上限触发 LRU 式淘汰（`capEvicted`）。

SessionStore L1 另有**有界 LRU**（默认 10k）：`set()` 刷新最近使用序，超限淘汰最旧
（只清内存，L2a/L2b 可恢复）；`index.ts` 每 5 分钟调用 `cleanup()` 清理过期
pending 的内存与存储行。

台账只用于诊断（`/session-debug` 暴露**长度**，不暴露具体 ID），
并可作为「会话结束事件 → 归档钩子」桥接的数据源（§5.5）。

### 5.3 deterministic 的轮换语义（已实现）

- epoch 桶宽 = `max(ttlMinutes, deterministicBucketMinutes)`（默认 = ttlMinutes）；
- 同一 epoch 内同 (key, scope, fp) 确定性收敛；跨桶空闲会话自然轮换为新 sid；
- 已知限制：跨桶边界存在「换新 sid」而非严格连续——`deterministic` 解决
  多实例收敛，不承诺跨 epoch 的会话连续性（连续性是 Redis 共享表的收益）。

### 5.4 命名空间归档（已实现，内核侧 gc 除外）

- `storage.archiveNamespaces`：命中命名空间（space/team/agent 规则）→
  旧会话不恢复、不注入（`isNamespaceArchived`）；
- `routes/session-force-archive.ts`：从 SessionStore 取 sessionInfo →
  调内核 forceArchive（skill 资产归档）；
- sweeper 按 spaceId 清理会话键；`session-refresh` / `session-task` 路由用
  `buildStoreSessionKey` 定位会话（含 workbuddy 别名）。

### 5.5 待办：TTL 到期「归档」而非「消失」

prune 定时器没有 handler 上下文（tdai client / sessionInfo），当前无法在
会话到期时直接触发 archive hooks。台账（§5.2）已为「会话结束事件 → 归档层
桥接」备好数据；把过期事件桥接到归档属于后续课题，不在本分支做半截接线。

## 6. 可观测与告警（已实现）

### 6.1 会话决策计数

`common/session-stats.ts`（进程内）：

```
created / resumed / expired / windowEvicted / capEvicted /
ghostRejected / scopeRejected / fenceBlocked / fenceAllowed / fenceMiss
```

- `resumed`：活跃会话 / 指纹窗口续接；
- `scopeRejected`：auto ID 在带 scope/指纹绑定上下文被拒（跨线程/窗口复用或伪造）；
- `ghostRejected`：默认上下文的签名拒绝（换 key/伪造/旧签名密钥）；
- `fenceBlocked` / `fenceAllowed`：archive 写侧 fence 的拦截与放行。
- `fenceMiss`：L1 与 binding repo 都无记录（fence 无法校验）的写入次数，
  多副本下常见于新 pod 首次写入。

### 6.2 分解与派生指标

- 按 `agentSource` / `spaceId` 分解（每类决策都带 meta 打点）；
- **高基数治理**：per-space prometheus label 只导出 created 最多的前 32 个，
  其余计 `tdai_auto_session_spaces_exceeded_total`；
- `reuseRate = resumed / (created + resumed)`；
- `fenceRate = fenceBlocked / (fenceBlocked + fenceAllowed)`；
- `fenceCoverage = (fenceBlocked + fenceAllowed) / (blocked + allowed + miss)`：
  第二道防线“有绑定信息可校验”的写入占比；
- `/session-debug` 与 `/metrics` 同步暴露 `fenceMiss` 与 `fenceCoverage`。
- `/session-debug`：输出 `autoSessionSizes()`（activeKeys/windows）、台账长度、
  `reuseRate`、`fenceRate`、`fenceCoverage`、全量 stats 与 breakdown；
  端点与 admin 端点同口径：`config.admin.apiKey` 非空时要求 Bearer；
- `/metrics`：聚合 `protocolStatsToPrometheus()` +
  `sessionStatsToPrometheus()` + `injectionStatsToPrometheus()`。
- prometheus 新增 `tdai_auto_session_fence_miss_total`（counter）与
  `tdai_auto_session_fence_coverage`（gauge）。

### 6.3 建议告警信号（运维文档已写入 README_CN）

- `scopeRejected` / `ghostRejected` 突变：疑似伪造会话 ID 或签名密钥轮换；
- `fenceRate` 骤升：会话归属漂移增多（检查路由/space 解析）；
- `fence_miss_total` 突增：多副本下大量写入查不到绑定，检查 binding 落库；
- `fence_coverage` 骤降：越来越多的 L0 写入在“无绑定信息”下放行；
- `reuseRate` 骤降：auto 会话大量新建（TTL/epoch 配置变动或客户端行为变化）。

### 6.4 遥测键对齐（已实现）

model-intent 埋点与 session-init 日志的会话键统一走 `buildStoreSessionKey`，
threadIsolation 部署下都带 `:threadId` 后缀，查询语义按话题可对齐。

## 7. 多副本 / K8s 结论

### 7.1 自带会话 ID 的客户端（Claude Code / CodeBuddy / 显式 header）

跨 pod 无影响：会话 ID 在请求头自带，状态恢复走 SessionStore
L2a（SQLite/Redis/ProxyStorage 多节点读写）+ L2b binding，
不依赖进程内 Map。

### 7.2 无会话 ID 客户端（codex / workbuddy / Hermes / OpenClaw / DSH）

生产多副本部署需满足：

1. `autoConversationId.deterministic: true`；
2. `TDAI_SESSION_SIGNING_KEY` 通过 K8s Secret **全副本共享**（默认随机 =
   重启后旧 auto ID 全失效，从源头杜绝幽灵会话，但多副本会各自签发不同 ID）；
3. 接受 epoch 边界限制（空闲跨桶会话轮换，见 §5.3）。

### 7.3 后续独立课题：Redis 共享 auto-session

跨 pod **严格连续 + 台账共享**的真正解法：把 `ACTIVE` / `ACTIVE_MSG` 换到
`config.redis` 已接的存储层（SessionStore 已有 Redis 通路可复用），
`resolveOrCreateSessionId` 需要异步化（当前热路径为同步）。

该课题与当前 PR **解耦**：当前 `deterministic + 共享签名键` 是无共享状态的
最优近似，可独立合入、独立评审；Redis 共享表单独成 PR，避免把存储中间件
依赖塞进本课题。设计蓝图书写在 `session/auto-session.ts` 头注释与本 §7.3。

### 7.4 已知边界（如实记录）

- 台账/计数是**进程内**、有界审计，跨实例不共享，不承诺全局一致；
- `recentExpiredSessions` 只暴露长度给诊断端点，不暴露具体 sid。
- `threadIsolation` 只做进程内 L1/状态机键与遥测分组，不承诺持久隔离（§2.2）；
- initialized 持久行/绑定长期不清理是存储治理课题（§5.5），
  L1 内存侧已由 LRU + 周期 cleanup 保持有界。

## 8. 落地状态清单

| 项 | 状态 | 位置 / 说明 |
|---|---|---|
| 会话解析统一入口（sessionStage + SessionAdapter，4 handler 接入） | 已实现 | `stages/session.ts`、`stages/types.ts` |
| 转发/归档/观测阶段化（forwardStage、buildArchiveCtx/writeL0、buildObsInput） | 已实现 | `stages/forward.ts`、`archive.ts`、`obs.ts` |
| store 键单点约定（workbuddy→codex 别名 + thread 后缀） | 已实现 | `session/store.ts::buildStoreSessionKey`（4 handlers + 3 routes + telemetry + fence） |
| auto ID 签名绑定（keyId+scope+fp）与 ghost 回退修复 | 已实现 | `session/auto-session.ts` |
| deterministic 派生 + epoch 桶（含配置校验） | 已实现 | `auto-session.ts`、`config.ts`、config.example |
| per-key / per-key-msg 策略、TTL、窗口容量 | 已实现 | `auto-session.ts` |
| 稳定兜底键（keyId:msg-<fp>:<日桶>） | 已实现 | codex/workbuddy SessionAdapter |
| store 恢复层归属校验（跨 user/space 视为新会话） | 已实现 | `store.ts::l1OwnedBy` / `getOrRecover` |
| archive 写侧 fence（L0 前候选键校验 + 计数） | 已实现 | `stages/archive.ts::writeL0` |
| archive fence：L1 miss → binding repo 补查 + fenceMiss/fenceCoverage | 已实现 | `stages/archive.ts`、`common/session-stats.ts` |
| SessionStore L1 有界 LRU + 周期清理 | 已实现 | `session/store.ts::trimL1/cleanup`、`index.ts` |
| 管理端点鉴权（/session-debug、/v3/session/*） | 已实现 | `routes/admin-auth.ts`、`server.ts` |
| autoGenerate:false 客户端回传 auto-* 也过签名 | 已实现 | `stages/session.ts` |
| 会话结束台账（有界 512）+ prune/expire/evict 分类 | 已实现 | `auto-session.ts`、`index.ts` |
| 决策计数分解 + prometheus + /session-debug + 高基数治理 | 已实现 | `common/session-stats.ts`、`server.ts` |
| 遥测键对齐（model-intent/init 日志带 thread 后缀） | 已实现 | handler/anthropic telemetry 调用点 |
| bypass 自愈（header 预选可解析 → 重绑） | 已实现 | `session/codebuddy/init.ts`（CC 同款 preset 路径） |
| 命名空间归档拦截 + force-archive/refresh/task 路由 | 已实现 | `archiveNamespaces`、`routes/session-*.ts` |
| bypass 读写策略 / 审计事件线 / grants 拉取 + TTL | 已实现 | `extraction-gate.ts`、`audit.ts`、`tdai/grants-fetcher.ts` |
| 跨客户端续接的归属锁判定（记忆续接、历史隔离） | 部分 | 归属/space 校验已就绪；整体 E2E 与记忆侧迁移待专项验证 |
| TTL 到期 → 归档事件桥接 | 待办（后续课题） | 台账已备数据（§5.5） |
| Redis 共享 auto-session（跨 pod 严格连续 + 台账共享） | 待办（独立 PR） | §7.3 |
| 存储物理隔离（SQLite 按 space 分文件 / Postgres RLS / 向量分 collection） | 待办 | 当前 SQLite 单文件 + 应用层键隔离为过渡态 |
| 审计扩展（search/read/query 事件、Opik audit_log） | 待办 | `audit.memory-access` 已有 recall/write |
| grant 撤销即时推送 | 待办 | 当前 60s TTL 轮询拉取 |
| 内核记忆 gc / 命名空间级删除 | 待办（内核侧） | Proxy 侧 archive 拦截已实现 |

## 9. 验证方法

**自动化**（全部在仓库内跑通）：

```bash
npm test          # 274/274：stages-session / stages-forward / stages-archive /
                  # stages-obs / session-isolation / session-store-fence /
                  # routes-session-force-archive / routes-session-refresh-task 等
npx tsc --noEmit  # 0 错误
```

**手工验证**：

```bash
# 1) 串号防护：同 sessionId 换 key 请求 → 重新走 Session Init
#    （日志 owner mismatch / treat as new session）

# 2) deterministic 收敛：TDAI_SESSION_SIGNING_KEY 固定 + deterministic: true，
#    两个实例同 epoch 内对同 (key, fp) 请求 → 日志出现同一 auto sid

# 3) archive fence：人为让写入 space 与绑定 space 不一致 → 日志
#    "[archive-fence] L0 skipped"，/metrics 中 fence_blocked +1

# 4) 会话台账：等 TTL/prune 或触发淘汰 → /session-debug 的 expiredLedger 长度增长

# 5) 指标与诊断：
curl -H "Authorization: Bearer <admin.apiKey>" http://127.0.0.1:<port>/session-debug  # reuseRate / fenceRate / fenceCoverage / stats.fenceMiss
curl http://127.0.0.1:<port>/metrics         # tdai_auto_session_* 指标

# 6) 伪造 auto ID（改一个字符）→ scopeRejected/ghostRejected 计数增加，
#    不会回退到 raw（防幽灵会话）
# 7) L1 有界/清理：压入超过 10k 会话后最旧被淘汰；cleanup 定时清过期 pending
#    （只清内存，L2a/L2b 可恢复）
```

## 10. 参考

- 阶段化重构与隔离优化基线：本分支 `c9152ee`（未推送，工作区干净）；
- 协议转换层（OpenAI Chat/Responses ↔ Anthropic）见 `docs/protocol-conversion-matrix.md`
  与 PR #1226（与当前分支源码一致，差异见评审结论）；
- 验证手册：`docs/design/2026-08-28-verification-handbook.md`；
- Redis 共享蓝图：`session/auto-session.ts` 头注释（独立课题引用）。
