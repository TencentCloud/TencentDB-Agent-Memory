# 孤儿 Agent 生命周期与级联清理（issue #1321）

> 状态：**基础 / 进阶 / 深入** 已实现并有测试覆盖（136 个用例全绿）；
> **拓展**（ownership transfer / GC）为设计方案，**未实现**，见 §5。

---

## 1. 问题现象

移除团队成员、或删除用户后，该用户名下的 Agent 会变成**孤儿 Agent**：`owner_user_id` 指向一个已离开团队 / 已不存在的用户，而 Agent 的删除与归档是**严格 owner-only** 校验，于是：

- Panel 的 Agents 列表不做权限过滤，孤儿 Agent 对全团队可见，owner 标签无法解析；
- 团队 admin / system admin 点删除按钮恒返回 `403 NOT_YOUR_AGENT`（UI 与内核授权不一致：`canManageAsset` 对 team admin 返回 `true`，按钮可点）；
- 其名下 skill 同样卡死（`skill/delete` 也要求 caller 是 agent owner）；
- 无 GC / ownership transfer 机制，存量数据只能靠运维拿 kernel token 手工清理。

---

## 2. 生命周期与权限链路（基础）

### 2.1 三条实体的生命周期

```
User ──拥有──> Agent ──引用──> Team
  │              │  │            │
  │              │  └─ meta_agents.owner_user_id
  │              └─ meta_agent_fixed_assets（借入的资产）
  └─ meta_team_members（成员关系，决定 team 内角色）
```

**创建侧（对称性缺失的那一半）**

```
team-member/add
  └─ 内核 addTeamMemberForCaller()  ── 校验 assertCallerIsTeamAdmin
       └─ store.addTeamMember()      ── 只写 meta_team_members 一行
  └─ Panel 后置钩子（best-effort、异步不阻塞响应）
       └─ cloneDefaultAgentForNewMember()
            └─ 内核 agent/create { owner_user_id: 新成员 }   ← 产生 meta_agents 行
```

**删除侧（修复前的缺口）**

```
team-member/remove
  └─ 内核 removeTeamMemberForCaller() ── 校验 assertCallerIsTeamAdmin
       └─ store.removeTeamMember()     ── 只删 meta_team_members 一行
                                          ✗ 没有任何 Agent 清理

user/delete
  └─ 内核 deleteUsersForCaller() ── 校验 canManageUsers(ctx) = ctx.isSystemAdmin
       └─ store.deleteUsers()      ── 删 meta_users / meta_user_keys /
                                       meta_team_members / meta_asset_acl(user)
                                       ✗ 不碰 meta_agents

team/delete
  └─ store.deleteTeams()           ── 直接 DELETE FROM meta_agents  ← 绕过级联
                                       ✗ 残留 meta_task_agents /
                                         meta_agent_fixed_assets /
                                         chat_memory 资产记录
```

创建侧会为成员**新建** Agent，删除侧却什么都不做 —— 这是缺陷链的根源。

### 2.2 Agent 删除 / 归档的权限校验链路

**修复前**

```
agent/delete  ──> deleteAgentsForCaller()
agent/archive ──> archiveAgentForCaller()
                     │
                     └─> assertCallerIsAgentOwner()
                            └─> assertCallerIsResourceOwner()
                                   callerId !== agent.owner_user_id → throw
                                   （纯等值比较；ctx.isSystemAdmin / ctx.isAdmin 从未被读取）
```

`assertCallerIsAgentOwnerOrTeamAdmin()` 这个 helper **在代码里已经存在**
（`MemoryCore/src/metadata/service/metadata-service.ts`），只是 delete / archive 没用它 ——
它当时只服务于 agent 固定资产写操作。

**修复后**

```
agent/delete  ──> deleteAgentsForCaller()
agent/archive ──> archiveAgentForCaller()
                     │
                     ├─ ctx.isSystemAdmin === true ────────────> 放行
                     │   （system_admin 无需加入目标 team）
                     │
                     └─> assertCallerIsAgentOwnerOrTeamAdmin()
                            ├─ agent.owner_user_id === callerId ─> 放行（owner 本人）
                            └─> assertCallerIsTeamAdmin(agent.team_id)
                                   └─> requireActiveTeamMember()
                                          member.role === "admin" → 放行
```

为什么 `system_admin` 必须在**调用点**短路：`assertCallerIsTeamAdmin` 要求 caller 是
**该团队的 active 成员**（`requireActiveTeamMember`），未加入目标 team 的 system_admin
过不去 —— 若不短路，把权限面放宽到 team admin 只是把「admin 也 403」从 team admin
挪到了 system_admin，控制层的放行形同虚设。

### 2.3 孤儿 Agent 的产生路径

```
① admin 在 Panel「成员管理」添加成员
② team-member/add 成功后，Panel 异步为该成员克隆默认 Agent（owner = 该成员）
③ 移除该成员 / 删除该用户
④ 成员关系行被删（或用户名下 key 被删），但 meta_agents 行原样保留
```

第 ④ 步之后分两种情形 —— 严重程度不同，需要区分：

| 路径 | 触发 | 后果 |
|---|---|---|
| **A. 仅移出团队**（用户仍在） | `team-member/remove` | Agent 的 owner 仍能认证（用户还在），**本人仍可删除**；但 owner 已不是团队成员，team admin / system_admin 一律 403。Agent 对全团队可见、owner 标签解析失败（`canViewUser` 不再授权读取已移出的成员）。 |
| **B. 用户被删除** | `user/delete` | 该用户的 `meta_user_keys` 被一并删除 —— **唯一有删除权的主体永久消失**，任何角色都无法再认证为该 owner。此时 Agent 及其 skill 彻底无法清理，只能运维手改库。 |

路径 B 是真正意义上的「死锁」；路径 A 是「权限真空 + 数据可见性错乱」。
两者都由同一条缺陷链产生，因此修复取同一处。

> 补充：`deleteTeams` 的 raw SQL 直删 `meta_agents` 是**次生问题** —— 它不产生孤儿
> Agent，但会残留 `meta_task_agents` / `meta_agent_fixed_assets` / chat_memory 资产
> 记录，属于同一类「级联不完整」。

---

## 3. 修复实现（进阶）

| # | 缺陷 | 改动 | 位置 |
|---|---|---|---|
| 1 | 成员移除不级联 Agent | 移除成员前，先分页收集该成员**在本团队**名下的全部 Agent 并硬删除 | `metadata-service.ts` · `removeTeamMemberForCaller` |
| 2 | 用户删除不级联 Agent | 删除用户前，先分页收集该用户**名下全部** Agent（跨团队）并硬删除 | `metadata-service.ts` · `deleteUsersForCaller` |
| 3 | 删除无 admin 旁路 | `deleteAgentsForCaller` / `archiveAgentForCaller` 改用已有的 `assertCallerIsAgentOwnerOrTeamAdmin`，并在 `ctx.isSystemAdmin` 时短路 | `metadata-service.ts` |
| 4 | `deleteTeams` 绕过级联 | sqlite / mongodb 两个 adapter 都改为先收集 `agent_id` 再调 `deleteAgents()` | `sqlite-adapter.ts` · `mongodb-adapter.ts` |
| 5 | Panel 授权面过窄 | `delete-cascade` 放宽为 owner / team admin / system_admin；admin 路径跳过 skill 逐条删除（`skill/delete` 仍要求 owner），改走内核 `agent/delete` 硬删除 | `MemoryPanel/.../agent-lifecycle.ts` |
| 6 | UI 与内核授权不一致 | `canManageAsset` 尊重全局 admin 标记，调用点传入真实值；`AgentGrid` / `TeamManagementPanel` 同步 | `MemoryPanel/web/...` |

### 3.1 顺序约定：先清内容，再删元数据

新增的 `purgeAgentsCascade()` 对每个 Agent **先调 chat_memory 内容清理器，再删元数据**。

这不是风格问题，而是硬约束 —— `archiveAgent` 的注释里已经记录过同一条教训：

> 若把顺序颠倒（先删资产再清内容），资产记录一没，就再也无法从 asset_id 定位到
> (team, agent)，内容会变成**永久不可达的孤儿数据**留在库里。

`deleteAgents()` 会连 `chat_memory` 资产记录一起删掉，所以级联清理必须沿用同一顺序。
内容清理失败时向上抛（不吞异常）：宁可让调用方重试，也不留下「资产已删、内容还在」
的不一致状态。未注入 cleaner 时（单测 / 迁移脚本）退化为只删元数据 —— 与 `archiveAgent` 一致。

### 3.2 分页遍历

`store` 的 list 接口带默认分页（20 条），级联收集必须拿到**全量** id，否则一页之外的
孤儿 Agent 会被静默跳过、问题依旧。`collectAllAgents()` 按 100/页遍历到 `total` 为止，
沿用 service 层已有的 `allAclRecords()` 范式。

### 3.3 数据库适配器

sqlite 与 mongodb **同步修改**，保持后端切换时行为一致：原先两处都是直接删除
`meta_agents` / raw `DELETE FROM meta_agents`，现在都改为「先收集 id → `deleteAgents()`」，
从而复用 `deleteAgents` 已有的 `meta_task_agents` / `meta_agent_fixed_assets` /
chat_memory 级联。

### 3.4 权限面速查（修复后）

| 操作 | owner | team admin | system_admin | 其他成员 | 无关用户 |
|---|---|---|---|---|---|
| `setAgentFixedAssets` | ✅ | ✅（原有，未改） | ❌（未放宽） | ❌ | ❌ |
| `agent/update` | ✅ | ❌（未放宽，本 issue 未要求） | ❌ | ❌ | ❌ |
| `agent/delete` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `agent/archive` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `delete-cascade`（Panel） | ✅ archive | ✅ 硬删除 | ✅ 硬删除 | ❌ 403 | ❌ 403 |

> `system_admin` 的短路刻意只加在 `deleteAgentsForCaller` / `archiveAgentForCaller`
> **两个调用点**，没有下沉进 `assertCallerIsAgentOwnerOrTeamAdmin` 本身。
> 后者同时服务于 `setAgentFixedAssetsForCaller`，若把旁路写进 helper，会顺带扩大该接口的
> 权限面 —— 这超出本 issue 的要求。加上 team admin 的放宽，delete / archive 与
> `setAgentFixedAssets` 现在**不再完全同源**，是有意为之的最小改动。

---

## 4. 测试（深入）

引入前，该分支**没有任何测试文件**：`metadata-store.contract.ts` 这套契约套件虽然存在，
却没有任何 `*.test.ts` 调用它（`vitest.config.ts` 的 `include` 指向空集）。因此第一步是把
契约套件真正接上。

| 文件 | 覆盖 |
|---|---|
| `src/metadata/store/sqlite-adapter.test.ts` | 挂载契约套件到 SQLite（60 用例） |
| `src/metadata/store/mongodb-adapter.test.ts` | 挂载同一套契约到 MongoDB（单节点副本集，保持事务开启） |
| `src/metadata/service/metadata-service.test.ts` | 16 个 service 层用例：三条缺陷链 + 角色矩阵 |

新增的契约用例（两端各跑一遍）：

- `deleteTeams 走完整 Agent 级联，不残留 task_agents / fixed_assets / chat_memory`
- `deleteUsers 不级联 meta_agents —— Agent 级联由 service 层负责`（**固化设计边界**）

service 层用例覆盖的角色矩阵：

| 场景 | 期望 |
|---|---|
| 成员被移出团队 → 其 Agent + chat_memory 资产 + 成员关系全部清除 | 通过 |
| 团队 owner 不可被移出（且其 Agent 不受影响） | `permission_denied` |
| 非 team admin 移除成员 → 无半截级联副作用 | `permission_denied` |
| 删除用户 → 其跨多个团队的 Agent 全部级联删除 | 通过 |
| 非 system_admin 删除用户 → 无副作用 | `permission_denied` |
| 删除不存在的用户 | 幂等，无副作用 |
| 孤儿 Agent：team admin 删除 / 归档 | 通过（修复前恒 403） |
| 孤儿 Agent：system_admin（未加入 team）删除 / 归档 | 通过 |
| 孤儿 Agent：旁观者、普通 team member 删除 | `permission_denied` |
| owner 本人删除自己的 Agent | 通过（原路径不回退） |
| 不存在的 agent（admin 旁路） | `agent_not_found`（不吞 404） |

**测试有效性已验证**：把源码回退到修复前的提交再跑，恰好 8 个用例失败，且全部落在三条
缺陷链上；其余 68 个（原有行为）保持通过。

```
# 修复后
MemoryCore  3 files / 136 tests passed

# 回退到修复前
Test Files  2 failed (2)
     Tests  8 failed | 68 passed (76)
```

---

## 5. 拓展设计：ownership transfer 与 GC（未实现）

当前修复走的是「**同步硬删除**」路线：谁触发删除，就在同一次调用里把 Agent 带走。
它解决了今后的数据，但有两个已知缺口：

1. **存量数据**：已存在的孤儿 Agent 不会被自动清理（需要一次性 GC）；
2. **多步非事务**：级联涉及跨表 / 跨库多次写，中途失败会留下部分状态
   （与改动前的风险性质相同，mongo 未用 `withTx`，sqlite 未包 `tx`）。

### 5.1 `agent/transfer`（所有权转移）

对「成员要离开团队，但其 Agent 还有价值」的场景，删除过于粗暴。设计一个显式转移接口：

```
POST /v3/meta/agent/transfer
  { agent_id, to_owner_user_id, to_team_id? }
```

- 权限：`system_admin`，或**源/目标两侧**的 team admin（避免把 Agent 塞给不相关团队）；
- 校验：`to_owner_user_id` 必须是 `to_team_id`（缺省沿用原 team）的 active 成员 ——
  否则转移只是把孤儿换了个 owner，问题原地复现；
- 副作用：不删 Agent / 不删 chat_memory，但要处理 `meta_agent_fixed_assets.created_by`
  与 chat_memory 资产 `owner_user_id` 的归属一致性；
- 审计：记 `meta_participation_logs`（追加型日志，已有表）。

成员移除流程可据此升级为带策略的模式：
`team-member/remove?on_agent=delete|archive|transfer:<user_id>`，默认 `delete`（当前行为）。

### 5.2 GC（存量孤儿清理）

```
POST /v3/internal/meta/agent/gc            （dry_run 默认 true）
```

扫描两类目标：

- **owner 悬空**：`meta_agents.owner_user_id` 在 `meta_users` 中不存在
  （路径 B，永久死锁，应直接清理）；
- **owner 已非团队成员**：owner 存在但不在 `meta_agents.team_id` 的 active 成员里
  （路径 A，策略上应先告警 / 尝试通知，再按配置清理）。

配套要求：

- **默认 dry-run**，输出待处理清单（agent_id / owner / team / 原因 / chat_memory 体积），
  人工确认后再执行；
- **幂等**：重复执行结果一致；已清理的 id 视为成功（与 `deleteAssets` 的既有约定一致）；
- **复用同一条级联路径**：执行时走 `purgeAgentsCascade()`，避免出现第二套级联逻辑；
- 建议以低频定时任务（如每日一次）+ 告警接入，而不是自动删除 —— 转移一个 Agent 的成本
  远低于误删一个 Agent 的成本。

### 5.3 事务化（长期）

`purgeAgentsCascade` + `store.deleteAgents` 目前是多次独立写入。要真正做到「要么全成、
要么全败」，需要：

- mongo：把级联包进单次 `withTransaction`（`withTx` 已具备，需把 session 透传进
  `deleteAgents` / `deleteAssets`）；
- sqlite：用已有的 `tx()` 包裹整个级联。

这会改变 store 接口的签名（传入可选 session），属于独立的重构，建议单独发 PR。

---

## 6. 遗留与取舍

- **Panel 的 owner 标签**：成员被移出团队后 `user/get` 不再授权（`canViewUser`），
  `user-profile-store` 静默失败并回落到裸 `user_id`。本 issue 未要求修改，属已知限制。
- **非 chat_memory 的团队资产**：`deleteTeams` 仍以 raw SQL 删除 `meta_assets`，
  会残留这些资产的 `meta_asset_acl` / `meta_agent_fixed_assets` 记录。本次未扩大范围。
- **SkillCore 未启用时**：owner 路径的 `skill/list` 404 会阻断归档，见 #1218，应单独处理。
- **`agent/update` 未放宽**：本 issue 只涉及 delete / archive，未动 update。
