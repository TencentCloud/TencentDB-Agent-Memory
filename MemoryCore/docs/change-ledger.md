# 统一变更账（memory_events）持久性与恢复

`memory_events` 是记忆变更的统一账本：extraction（L1 抽取）、api_mutation（管理面增删改 / clear）、
review（revert）三类事件都写入这里，供 `/memory/diff`、`/memory/history`、`/memory/review/inbox`
和 revert 使用。`memory_audit` 仍是独立的 API 访问日志，不受影响。

## 提交与运行模式

以 PR 目标分支 `feat/server_team` 为升级基线，不兼容本 PR 未发布的中间协议或账本 schema。
只接受 protocol 2，审核收据必须有确定性身份；不猜测旧 token、旧操作结果或整记录 revert 标记。
SQLite/Mongo 的 L1 抽取及管理面编辑/删除，把目标读取、正文变更、替换删除和事件组放在同一事务；Mongo 要求副本集或分片集群。
任一步失败都回滚，正文不会先成功、再靠进程内 pending 补账。去重目标已退役且仍有作用域内历史时拒绝迟到决策，不能丢掉血缘后当新事实写入。
JSONL 是提交后的镜像：本地与 COS 使用同一个 StorageAdapter；standalone 缺适配器时构建 LocalStorageBackend，
没有权威 store 则拒绝写入，不保留 JSONL-only 模式。embedding 在事务前计算，镜像失败不撤销权威提交。
原生 TCVDB 保留目标分支的普通记忆功能，但多步骤写入仍非原子；失败可能已落部分正文，不能据此启用事务型审阅。

## 事件身份 `event_id`

- 每条事件在逻辑写入点生成一次 `event_id`：`evt-` + 32 hex（共 36 字符）。
  见 `src/core/store/memory-event-id.ts`。
- 同一个 `event_id` 贯穿 JSONL outbox 与所有 store，重复写入是幂等的：
  - SQLite：`memory_events.event_id` 上的 partial unique index（`event_id != ''`），
    `INSERT ... ON CONFLICT DO NOTHING`。
  - MongoDB：`event_id` 上的 unique partial index，重复键（11000）视为已写入。
  - TCVDB：文档主键 `id = event_id`，追加前探测、已存在即 no-op，仅提供顺序重放去重。
    查后 upsert 不是原子创建；并发追加/擦除不能保证首次内容不可变，不能等同于 SQLite/Mongo。
    原生模式拒绝审核操作收据与代次栅栏；可读取当前格式的已提交事实，审核/事务撤销需要共享原子账本。
    主键不拼业务字段，长度恒为 36，低于 TCVDB 128 字符上限。
- 非审核事件的调用方未传 `event_id` 时由 store 生成；审核收据必须在提交前确定身份。
  迁移拒绝缺失身份的事件，不重新编号控制事实。

## 隔离 id 契约

`team_id` / `user_id` / `agent_id` 的 `""`、缺失与 `"default"` 表示同一个逻辑值，
写入一律收敛为 `"default"`（`task_id` 保持缺省，无 default 约定）：

- `appendLedgerEvent` 与回放行归一化后落库（`""`/缺省 → `"default"`，task 缺省 → undefined）。
- 比较双侧愈合：`healIsoId` 把 defined `""` → `"default"`，`undefined` 保持无约束；store
  过滤对 `"default"` 同时匹配存量 `''` 与 `"default"` 两种形态
  （SQLite `IN ('','default')`、Mongo `$in`、TCVDB `(x="" or x="default")`）——
  外来写入的 `''` 行不会逃出 scope 查询或擦除覆盖。
- 管理面镜像事件按**记录自身租户**归属：audit 行记请求方 IdFields（谁调的），ledger 事件
  记 snapshot 里的记录 IdFields（改的是谁的数据）——请求缺 team 头的人工编辑不会把事件
  错挂到 default 租户而绕过 revert 守卫。

## JSONL outbox

- 路径：按 `event_ts` 的 UTC 日期、按写入进程（writer）分片，经 `StorageAdapter.appendFile` 写入，本地文件系统与 COS 后端均适用：
  - `events/YYYY-MM-DD.<writerId>.jsonl`：本 writer 追加的活动分片；
  - `events/YYYY-MM-DD[.<writerId>]~<gen>.jsonl`：擦除改写生成的封存分片（内容已脱敏，此后不再追加，再次改写时换新 `<gen>`）；
  - `events/YYYY-MM-DD.jsonl`：未设置 writer id 的进程（`setLedgerWriterId(undefined)`）写入的无后缀分片；可回放，仅该类进程拥有并改写。
- COS 部署前置：目标桶**不得开启多 AZ 特性**——官方限制为 MAZ 桶不支持 Append Object
  （追加请求返回 405 MethodNotAllowed），而 outbox 的 live 分片、擦除标记、封存分片全部依赖
  `appendObject`。多 AZ 开启后无法关闭，必须建桶时选择单 AZ（已在真实 COS 桶冒烟验证）。
- `writerId` = `<hostname>-<8 hex>`，首次启动时生成并持久化到 `<dataDir>/.metadata/ledger_writer_id`，
  同一数据目录重启后沿用（因此仍“拥有”并能改写重启前的分片）；每个数据目录只应有一个写入进程。
  未经 TdaiCore 初始化（如单测、脚本）时使用进程级随机 id。
- 回放、TTL 删除、`pruneLedgerOutbox` 都按日期前缀枚举 `events/` 下全部 `.jsonl`，与 writer 后缀无关。每行一条完整 `MemoryEvent`（含 `event_id`、`snapshot_json`），
  足以重建 `memory_events`。
- L1 抽取、编辑/删除、审核和 revert 在权威提交后，以 `storeAlreadyCommitted` 发布 outbox。
  `appendLedgerEvent` 仍负责 L2/L3 操作镜像、保留期事件及回放补齐；该 best-effort API 的顺序：
  1. 分配 `event_id`；
  2. 追加 JSONL outbox（分片锁内复查已知擦除标记，被覆盖的事件直接以骨架行落盘）；
  3. 追加到当前 store；若写入期间有新的擦除标记注册，落库后按该标记的 filter 补一次
     定向擦除（`store.redactMemoryEvents`），失败记 `pending_redactions`；
  4. 任一步失败只记 warn 与健康度计数，**不阻塞主写路径**。
- 已知擦除标记集合（进程内）：本进程接受过的所有 clear/TTL filter + 回放时在 outbox
  扫到的标记，按 (team,agent,user) scope 去重——同 scope 只保留最大 `until`（后者严格
  覆盖前者），容量界于不同 scope 数而非擦除次数。**不做 FIFO 淘汰**（淘汰仍有效的标记 = 竞态追加
  可能落明文，fail-open）：集合达到软上限（1000）时只清理 `until` 早于 1 小时前、且无 pending
  擦除的标记——实时追加的 `event_ts` 都取写入时刻，这类标记已不可能覆盖它们；回放直接使用 outbox
  中的标记，不依赖该集合。
  本进程已知标记覆盖的追加写骨架；跨进程仍依赖对方节点回放收敛。
  TCVDB 查后 upsert 的并发覆盖不提供不可变/原子擦除保证，不能承诺两条腿无条件不复活明文。
- 接入点：L1 writer（created / superseded / updated / merged）、管理面 `recordMutation`（审计 + ledger 镜像）、
  chat_memory clear 的 L1/L2/L3 deleted、`/memory/diff/revert` 的 reverted。
- 未配置 storage 时只写 store（行为与之前一致，但无法回放）。
- **L2/L3 事件只记录操作事实**：场景块、persona 等管理面变更以 `layer: l2|l3` 记账，内容字段为空、
  不带前像快照。`/memory/diff` 对这类卡片返回 `layer` 字段（L1 卡片不带），Panel 标出层级、不给撤销入口；
  `/memory/diff/revert` 命中非 L1 写入时直接 409（撤销只对 L1 定义）。

## 健康度与降级提示

- 按逻辑 store（StorePool 建店时以 `backend:instanceId` 注册 `LedgerState`，对象被 LRU 驱逐重建后记账延续）
  × 租户（team/agent，进程内）统计 `store_failures` / `jsonl_failures` / `last_failure_at`
  （不对外暴露后端原始错误文本），
  以及 `pending_store_events`、`rejected_redactions`。计数是进程级、重启清零，
  多实例部署下各实例独立。
- `degraded` 在 `pending_store_events > 0`、`pending_redactions > 0`、
  `rejected_redactions > 0` 或出现不可恢复失败时为真。
  backfill 成功回放后对应事件出队，补齐完成即自动解除降级。store 与 outbox 同时失败
  （或待补事件超过 10000 条上限）的事件无法回放，只能重启清零或 `reset`。
  仅 outbox 失败时 store 中的数据完整，不算降级，只计入 `jsonl_failures`。
- **契约拒收也计入降级**（曾是静默消失）：`event_ts` 非法的 append 记为 unrecoverable
  （并入 `pending_store_events`，无 outbox 副本可回放）；filter/`until` 非法的
  redaction 记 `rejected_redactions`。这些计数反映镜像/运维健康度，不作为事务型 revert 的完整性守卫。
  scope 查询遵循同一隔离契约：defined `""` 读作 `"default"`；记入无租户桶的失败
  （如无 scope 的被拒 redaction）对所有租户视角可见。
- `POST /v3/memory/ledger/status` 返回 `{ supported, jsonl_outbox, backfill_enabled, health }`，
  `health` 含 `pending_redactions` / `pending_outbox_rewrites`。`{"reset": true}` 清零失败计数
  （运维手段，需 `TDAI_LEDGER_BACKFILL_ENABLED`）；**只清调用方 (team,agent) 自己的桶**——其它租户的
  计数与无租户桶（如被拒的 TTL redaction）不受影响；请求既无 team 也无 agent 时返回 400，不会退化成
  进程级全清（全清只能重启或内部调用 `resetLedgerHealth(store)`）。**pending 擦除是未落地的工作项，
  不在 reset 范围内**——只能由 backfill 真正落地或进程重启清除。
- 网关没有 admin/role 概念：backfill / reset 的准入只有部署级开关 `TDAI_LEDGER_BACKFILL_ENABLED`
  加请求 isolation 收窄。开启该开关即意味着信任所有持 API key 的调用方执行本租户范围内的运维动作。
- 出现过追加失败时，`/memory/diff`、`/memory/history` 与 `/memory/review/inbox` 响应附带
  `ledger: { degraded: true, store_failures, jsonl_failures, pending_store_events, pending_redactions, pending_outbox_rewrites, rejected_redactions, last_failure_at }`，
  MemoryPanel 审阅页据此显示“变更账降级”提示。
- 事务内 `appendMemoryEvent` 失败中止 L1 变更；best-effort 镜像失败由 `appendLedgerEvent` 记录健康度。
  审阅路径（diff/history/inbox/revert）的查询失败一律 fail-closed，返回 503。

## 撤销守卫（revert）

默认 fail-closed，以下情况返回 409：
- 目标写入之后同 team/agent 有管理面 `deleted`（`scope==="agent"`）或记录已不存在（含 TTL 清理）；
- 提取写入之后有 `source=api_mutation` 的人工编辑：先按 `event_id` 撤销该人工编辑层，或 `force:true` 覆盖；
- 被恢复的旧记录还有其它存活后继（并发 session 分叉）；
- 被恢复的旧记录没有可用快照（写入缺口或已被 clear/TTL 擦除）：默认 409，`force:true` 接受只删不恢复（响应带 `missing`）；

管理面 update 事件带修改前的 `snapshot_json`，可按 `event_id` 逐层回退。revert、retract、restore
的 `reviewer_id` 都只取 `x-tdai-reviewer-id` 显式声明，缺头不署名，不回落记忆所有者。
这个请求头不是认证或独立审核员授权；内核沿用数据面的部署信任边界。

`/memory/diff` 每张卡带 `event_id`（历史事件缺省）。同一 record 可有多次写入，单条撤销应回传它：
Core 只撤该事件或显式拒绝，不会改撤同记录的其它写入；不传时缺省为该记录最后一次提取写入。
卡片的撤销状态按本页卡片的 `record_id` 反查 `reverted` 标记，不受 session 内标记总数影响。

`core/record/memory-revert.ts` 拥有领域工作流；路由只校验请求并映射结果。
SQLite/Mongo 将最终守卫、快照恢复、目标删除、protocol 2 收据放入同一数据库事务。
失败由数据库回滚，不再逐行手工删回；embedding 预计算与 outbox 发布在事务外。
已有恢复行不盲覆盖，快照身份/租户/task 必须吻合；已被 clear 或管理删除的来源不恢复。
Mongo 物理撤销要求副本集/分片集群事务；无事务能力的后端返回 501，不降级成部分写入。

请求可带 `operation_id`；相同身份返回原收据，换理由/目标事件/操作者返回冲突。
省略身份仍兼容旧接口，但丢失整个响应后无法保证逻辑幂等。响应始终提供身份。
提交结果不能确认时返回 `commit_unknown`；提交后 outbox 失败标 `outbox_pending`，不再返回假成功的 `ledger_pending`。
撤销只写事务收据及其 outbox 镜像，不再写无人消费的正文 JSONL 墓碑；完整恢复必须携带权威账本。
撤销新身份写入形成不可由 visibility restore 取消的消费栅栏，防止同 ID 再写复活；就地编辑撤销保留恢复行。

## 事后审核：撤回 / 恢复 / 清单（retract / restore / list）

待人工验收。revert 退一次写入，retract/restore 管理 L1 可见性，delete 删除行；隐藏不等于擦除。
`TDAI_MEMORY_REVIEW_ENABLED` 默认关闭，只控制新的审核 HTTP 写入口（关闭返回 403）。
已提交审核始终抑制消费读；显式审计口径和写入防复活守卫不随开关关闭失效。
消费侧没有可用账本时不回退原始 profile 文件，也不把依赖故障伪装成“没有记忆”。

```text
POST /v3/memory/review/retract
{ "record_id": "m_x", "reason": "抽取错误", "operation_id": "caller-stable-key" }
POST /v3/memory/review/restore
{ "record_id": "m_x", "operation_id": "another-stable-key" }
POST /v3/memory/review/list
{ "visibility": "quarantined", "limit": 50, "offset": 0 }
POST /v3/memory/review/derived
{ "path": "persona.md" }
POST /v3/memory/review/derived
{ "path": "persona.md", "acknowledge": true, "expected_hash": "<returned content_hash>", "expected_fence": "<returned fence_hash>", "reason": "人工核对" }
```

### 唯一审核协议与提交点

- 新审核使用 protocol 2：规范化审核事件同时就是不可变操作收据，不新增平行事件系统。
  `commitMemoryEvent` 必须按确定性 `event_id` 原子创建或读回已有收据，校验请求 hash，并返回实际胜出的结果。
  SQLite/Mongo 使用数据库唯一约束；TCVDB 原生查询后 upsert 不满足此能力，当前审核写入口拒绝该配置。
  TCVDB 的共享权威账本接入与真实服务验收是本轮尚未解除的外部阻塞，不能据此宣称三后端交付。
  提交失败/超时返回 `commit_unknown`，不预写未提交 outbox；提交后镜像失败返回 `outbox_pending`。
  outbox 不保证包含全部审核：崩溃于提交与镜像之间时必须通过权威 store 备份恢复。
- 每个新 retract 身份增加独立 token，即使记录已经隔离；相同身份重试只返回原收据。
  restore 仅取消该收据固定观察的 token，不按时钟选胜者；新撤回不会被旧恢复消掉。
  同身份副本不得产生第二份效果，different-input 在提交边界返回冲突，不新增正常业务冲突 token。
- `operation_id` 作用域是 service 的 store + team/user/agent/task + record。相同身份的重试返回原收据，
  不重新执行；修改动作、理由或操作者返回 409。提供身份的 no-op 也持久留收据，不取消未来撤回。
  调用方应在发请求前保存身份；省略时服务端生成，但丢失整个响应后无法保证逻辑请求幂等。
- 状态列只保留导入基线；有效状态、token 与血缘约束由已提交事件解析，backfill 无需另一套状态投影。
  非空未知状态保守隔离并以 `invalid_status` 标记异常；目标分支缺字段的内容行默认 active。坏协议/坏血缘拒绝解析。

### 血缘、读写与边界

- 在默认值填充前强制显式 team/user/agent，不依赖全局严格隔离开关；session 不收窄审核，task 收窄行操作。
  事件归属取记录自身；跨租户与不存在都返回 `not_found`。retract 理由必填、restore 可选，批量最多 50。
- 后继行和抽取事件持久保存审核来源；撤回通过来源图传播，删除祖先行不删除审核控制。
  历史控制仍可 list/restore，响应 `exists:false`，不会重建正文。restore 后继只解除该分支观察到的 token，
  不恢复祖先或兄弟；缺失来源保守隔离并在清单标 `lineage_incomplete`，人工解除抑制不冒充血缘已修复。
  LLM 判重失败不会无条件退化为“全部新写”。这不是事实级永久黑名单。
- 新后继先持久写入、再删除源行；后继写入失败不删除源行、不留虚假 supersession。
  clear 先提交 L1 消费栅栏，再物理清理和重试；失败如实披露 fence/计数不确定性。
  SQLite/Mongo 的新 clear 在事务中提交单调 `guard_epoch`；L1 写入携带开始抽取前捕获的 `review_epoch`。
  代次由已提交 clear 事实查询；Mongo 的 scope 文档只用于串行分配，并以账本最大代次修复计数下界，不作为消费事实源。
  SQLite/Mongo 代次不依赖实例时钟；旧代次/未知代次在 clear 后隔离，不能 visibility restore。
  普通更新不能改记录出生代次；迁移的显式导入绕过写前拒收，但消费读仍验证栅栏。
  时间守卫用于原生 TCVDB 的当前非事务 clear 模式，不提供代次协议的跨实例提交顺序保证。
- 普通消费、召回、分页、count、文本重嵌入共用解析器；审计/去重显式 all。完整清单包含历史控制，
  不宣称截断数据完整。每批完整历史最多 50k 事件；图总预算 50k 节点、500k 事件、64MiB 元数据，超限拒绝而非放行。
  同步/异步解析共用一份执行计划；批量完整历史只读取一次，不在 TCVDB 每页重复全扫。
  L1 查询只保留一套条件构造/行映射；空 ID 集合匹配空集，全部给定条件取交集。
  原始审计读也传播后端故障，不再保留吞错空结果或 `strict` 开关。
  精确分页/计数最多解析 50k 候选行，需按租户/类型/时间收窄；召回有界超取，欠数记截断告警。
  单次读取不是跨多个请求的可串行化快照，也不能召回已交给模型的在途 prompt。
- Mongo `$search` 不依赖审核索引字段：以 local readConcern 获取候选，再用 primary/majority 记录及账本复核。
  pooled client 使用 journaled majority 写。TCVDB 使用 strongConsistency，审核不改 L1 文档；普通更新使用
  版本条件部分更新保留未更新字段；Embedding 集合更新 text 时由服务端刷新向量，审核动作本身不碰向量。
  既有集合补齐 scope/event_id/生成守卫标量索引，未 ready 则拒绝启动能力。
  TCVDB 不稳定分页通过去重+count 完整性核查拒绝欠数，不能用最终一致索引或桩测试代替真实服务保证。
- SQLite 从目标分支内容库直接创建最终事件表，不重建开发期间的旧 CHECK 或补开发版账本列。
  导出游标全量；迁移复制原始导入基线、来源/守卫和完整事件账本，任一批部分写入中止，
  校验物理 all 数量及每个事件的完整规范化内容；目标空检查包括账本。
  先复制控制账本，再导入记录。事件身份必须完整，不发明替代 token。
  迁移需停写、目标不对外服务，成功前不切配置；protocol 2/代次事实不能迁入原生 TCVDB，能力不足中止。
  原始导出查询失败/数量不符退出失败，不把残缺文件标成功。

### 派生内容与交付范围

- `store/derived-review.ts` 拥有派生消费策略与确认命令，复用同一不可变收据。L2/L3 不自动改写/删除、不自动调用 LLM 重生成。
  profile 作用域内尚有未解除的撤回、revert 或 clear 栅栏时，
  persona、scene_blocks、scene_index 默认停止消费；人工只可确认当前正文 hash + 当前审核 fence，
  正文变更/新撤回使确认失效，确认不会恢复 L1。作用域沿用 team/agent profile 存储，刻意保守覆盖所有 user。
- downstream 始终披露 `scan=complete|failed|unavailable`、截断、`lineage_analyzed:false`；最多返回一页文件，
  local 后端已有 10k 文件扫描硬预算。它不是逐记忆影响面；不存在/失败/截断不能互相冒充。
  精确 DAG 影响面和排除错误输入的重生成是 A 类延后，需要消费现有 generation DAG，不能再建平行血缘系统。
- API 实际 schema 在 `v2-schemas.ts`；TypeScript SDK 提供 revert/retract/restore/list/derived 方法和显式 reviewerId。
  仓库 Kubb 配置引用的 `docs/team-api-仅memory.yaml` 不存在，未伪造全量 codegen 或改无关生成 schema。
  配套 Panel 操作闭环在 #1539，本 PR 不吞入 UI。MongoDB 8.3 + mongot 有本机集成证据；
  TCVDB 只有 HTTP 合约验证，真实腾讯云实例及其索引/更新保证仍是部署验收项。

## clear / TTL 擦除

`redactLedgerEvents(filter)` 覆盖 `event_ts <= until` 且 team/agent/user（设置时）匹配的事件，依次做三件事：

1. **擦除标记**：向本 writer 活动分片追加 `{"redact": filter, "marker_ts": ...}`。标记行永不修改、永不删除，
   只随所在分片按日期整体删除。
2. **outbox 行改写**：对本 writer 拥有的分片（本 writer 后缀，含其封存分片）中日期 ≤ `until` 的分片，
   将匹配事件行的 `content` 置空、删除 `snapshot_json` 与自由文本 `reason`；`event_id`、`op`、`event_ts`、record/scope 元数据原样保留，
   与 `store.redactMemoryEvents` 的骨架语义一致。标记行、畸形行、不匹配的行逐字节保留。
   封存分片通过 `appendObject` 写到全新的 `~<gen>` key（单次 append 落完整内容），随后才删除原分片——
   `events/` 下所有对象保持 append-created 的单一访问模式，COS `APPENDABLE_KEY_PREFIXES` 前缀守卫不会拒绝；
   删除原分片严格发生在封存 append 完成之后，所以封存分片在写完前永远不是唯一副本，
   读到半途分片的回放不会丢事件（重复按 `event_id` 幂等去重，截断尾行计 malformed）。
3. **store 擦除**：`content` / `snapshot_json` / `reason` 置空，保留审核身份、hash、token 和元数据骨架。

入口先把 filter 登记进本进程的已知标记集（fail-closed：即使三步全失败也生效）——
本进程内被覆盖的追加写骨架（分片锁内复查保证时序无关），store 落库后按标记补定向擦除。
并发的两次擦除由全局改写锁串行，后到者对"已被封存的分片"按 (日期, writer) 族键重新列举，
不会对着已消失的文件名报成功。

- chat_memory clear 的 filter 为 `{ team_id, agent_id, until }`，并写 `scope=agent` 的 deleted 事件。
- TTL 清理（L1 实际执行时）写一条 `source=retention`、`scope=retention`、`until=cutoff`、`record_id=retention-l1-<cutoff>`
  的批次 deleted 事件，然后走同一路径，filter 为不带租户的 `{ until: cutoff, layer: "l1" }`，覆盖所有租户的
  **L1** 匹配行——L2/L3（场景块、persona 等 `api_mutation`）事件不受 L1 保留期管理，不会被擦；
  没有 `layer` 的旧标记仍覆盖全部层，行侧缺省 `layer` 按 `"l1"` 处理；
  过期的 outbox 分片按日期整体删除。批次事件不含逐条 record_id（`deleteL1Expired` 只返回数量），revert 依靠目标行不存在来拒绝。
  retention 事件没有真实租户身份（归一化后落 `"default"`）：review inbox 按
  `source/scope === "retention"` 显式排除，任何租户（含 default）都不会看到它。
- review inbox 的管理面补查只认 `scope==="agent"` 的 `deleted`（旧版无 scope 事件仅在
  `user_id` 为空时兼容）：4-id 契约下无 user 头的记录级删除同样落 `"default"`，按 user
  判定会把它漏进同 team/agent 下所有 user 的收件箱。事件同时命中租户主查询与管理面
  补查时按 `event_id` 去重只计一次。

### 明文何时真正消失

store 擦除成功，且所有含匹配行的分片都已改写之后：

- 本 writer 的分片：`redactLedgerEvents` 返回时（改写成功的前提下）即已消失。
- 其它 writer（其它节点 / 数据目录）的分片：本进程**不会**改写——改写是读-改-写，不能与对方的追加竞争。
  对方下一次 backfill 读到标记后，会改写自己分片中被覆盖的行；在此之前明文仍留在对方分片里，最迟随分片 TTL 删除。
  writer 已永久下线（如 pod 重建且数据目录未持久化）时，其分片没有 owner，只能靠 TTL 删除。
- 同一进程内，同一分片的追加与改写经 per-shard 队列串行，改写期间到达的追加不会丢失。

### 失败处理

- 三步各自失败都不影响 clear/TTL 本身（不抛错）。失败部分记入 `pending_redactions`，
  其中标记追加或分片改写未完成的另计 `pending_outbox_rewrites`；`degraded` 保持为真，直到 store 擦除与 outbox 改写都已完成。
- backfill 在回放事件**之前**重试未完成的标记追加与分片改写。
- 回放时擦除标记（以及仍 pending 的 filter）总是先于事件应用，因此即使改写始终失败，被擦除内容也不会被回放进 store。

## 回放 / 补齐（runbook）

适用：store 故障恢复后的 outbox 补齐，不替代完整备份。节点重建/迁移先停写，同一备份点携带 L0/L1、profiles
及完整 memory_events（含已擦除骨架、来源、收据、代次）；恢复到隔离目标后核验内容与控制事实，再切流。
只有 outbox/正文 JSONL 不能证明账本完整；目标缺原子能力时拒绝导入新收据。

```bash
curl -X POST "$GATEWAY/v3/memory/ledger/backfill" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "x-tdai-team-id: $TEAM" -H "x-tdai-agent-id: $AGENT" -H "x-tdai-user-id: $USER" \
  -d '{"since":"2026-09-01T00:00:00.000Z"}'
# => { files, scanned, replayed, skipped, malformed, failed, redacted, redactions_applied, outbox_redacted, outbox_failed }
```

- 运维操作：需部署设置 `TDAI_LEDGER_BACKFILL_ENABLED=1`（否则 403）；`since` 必填（否则 400）。
  MemoryPanel 降级横幅提供“从 outbox 补齐”按钮（经面板代理 `/memory/ledger/backfill`）。
- 回放范围限定在请求 isolation 的 team/agent，按文件日期与 `event_ts` 过滤。
- 依赖 `event_id` 幂等，可安全重复执行；非 JSON、非对象（如 `null`、数组）或缺 `event_id` 的畸形行计入 `malformed` 并跳过，不影响后续行与分片。
- store 拒绝写入（含降级状态）时回放计入 `failed`，事件保持 pending，直到真正写入成功。
- 未知 `op`、非字符串字段（含 `content`、隔离 id、session 维度——后端会强转，如 SQLite 把
  `123` 存成 `"123.0"` 篡改租户身份）、`version` 非 number、`supersedes` 非 string[]、
  非毫秒精确的 `event_ts` 一律计 `malformed`（而非 `failed`），`failed` 只反映 store 不可用。
  可无损归一的形态（`+08:00` 偏移、省略毫秒/秒）在落库前归一化为 `…ss.sssZ`。
- 擦除标记的 `until` 须能经 `canonIsoTs` 无损归一（`+08:00` 偏移、省略毫秒/秒归一化为 `…ss.sssZ`）；
  无法识别及带白名单外字段的 marker 计 `malformed` 不生效。回放 `since` 经 `canonEventBound` 归一，非法值直接抛错。
- 回放先重试 pending 的标记追加 / 分片改写，再用扫描到的全部标记（含其它 writer 写的）改写本 writer 拥有的分片
  （计入 `outbox_redacted`；失败计入 `outbox_failed` 并保持 pending）。`redacted` 统计被标记覆盖、以骨架形式回放的事件数。
- 扫描有内存上限（256MB）：超过后 `truncated=true`，**不再收集事件，但继续读完所有后续分片里的擦除标记**
  （标记总写在它覆盖的事件之后、即更晚的分片里）——已收集的事件总是带着完整的标记集合回放，
  截断不会让已清除的明文复活。按提示缩小 `since` 重跑即可补齐剩余事件。
- 某个分片读取失败（计入 `failed`）时，它可能藏着覆盖更早事件的标记：日期 ≤ 该分片日期的事件本次**不回放**
  （计入 `failed`、保持 pending），分片恢复可读后重跑即可；更晚的事件不受影响。
- 分片改写失败时只有**确实覆盖了本 writer 分片中残留明文**的标记被记为 pending，
  不会把其它租户无关的历史标记一并报成降级。
- 回放会先把扫描到的 clear/TTL 擦除标记重新应用到 store（收窄到请求的 team/agent，幂等，计入 `redactions_applied`）。
  store 擦除失败时健康度记 `pending_redactions` 并置 `degraded`，直到覆盖该标记所在分片的 backfill 成功；
  TTL 标记不带租户：按租户 backfill 只擦该租户，并只清除该租户视角下的 `pending_redactions`。
- TCVDB 在 init 失败后保持降级直到进程重启，期间 backfill 只会计入 `failed`，不会误清 pending。
- `failed > 0` 说明 store 仍不可用，恢复后重跑即可。
- `replayed` 统计的是向 store 发起追加的次数，已存在的 `event_id` 在 store 侧为 no-op，
  因此重复执行时 `replayed` 不会变成 0。
- 单机 standalone 模式下 outbox 位于根存储（`<baseDir>/events/`），多个 service id 共用一份；
  回放按 team/agent 过滤。service 模式下 outbox 位于各实例自己的存储中。

## 顺序与时钟假设

- 事件按 `event_ts` 排序（SQLite 为 `ORDER BY event_ts, seq`），同一时间戳内按各后端的插入序（SQLite rowid、
  Mongo ObjectId）作为稳定次序；TCVDB 由客户端按 `(event_ts, id)` 内存重排、跨页按文档 id 去重。
  残余：服务端对同值排序键次序不稳定时，单窗口 >100 条同毫秒事件可能欠数（去重防重复、不防位移丢失），
  完整收敛待真实例验证多列 sort 决胜键（`id` 作次级 sort 是否被服务端接受）。
- `event_ts` 取写入实例的本机时钟；多实例部署需 NTP 同步，时钟漂移会影响跨实例事件的相对顺序
  与 `since` 过滤，但不会导致事件丢失或重复（身份由 `event_id` 决定）。
- `event_ts` 契约：全链路词法比较要求规范形 `YYYY-MM-DDTHH:mm:ss.sssZ`。校验逐字段做范围
  检查先于 `Date.parse`（`02-30`、`24:00`、越界偏移一律拒），输出必须仍是 4 位年规范形
  （跨年溢出的 `+010000-…` 被拒）。五道门禁：HTTP 边界 schema（`isoDateString`）、
  `appendLedgerEvent` 写入门禁（拒写并记 unrecoverable）、回放入口（行级归一化，不可归一
  计 `malformed`）、三端 `appendMemoryEvent` store 层复检、store 查询 `since`/`until` 经
  `canonEventBound`（非法边界抛错不错过滤）。
  回放写入的事件保留原时刻，diff/history 中的顺序与原始写入一致。

## conversation/add 幂等

- 通过 `Idempotency-Key` 请求头或 body `idempotency_key`（body 优先，≤256 字符）传入。
- 作用域：`(service, team, user, agent, task, session, key)`。
- 缓存条目记录消息体指纹（`messages` 的 sha256）：同 key 换了请求体返回 **422**，不会回放首次结果
  而静默丢掉新消息。
- 同 key 的并发请求在进程内合并：后到者等待在途请求结束后回放其结果，写入 / 通知只发生一次；
  在途请求失败（未缓存）时后到者自行重试。
- 同进程内 24h 内的重试直接返回首次的 `accepted_ids`，跳过 quota 检查、L0 写入、pipeline 通知、
  JSONL 镜像与 quota 上报。
- 缓存未命中（跨实例 / 进程重启）时 L0 id 由作用域与消息序号确定性派生，并走 upsert 路径，
  L0 不会重复；但 pipeline 通知与 quota 上报可能再发生一次。需要跨实例严格幂等时，
  应在网关前置层按 key 做粘性路由或外部去重。
- 任何一条 L0 落库失败（`upsertL0` 返回 false / 抛错）的响应**不**进幂等缓存——同 key
  重试会真正重写而不是回放"假成功"。

## 进程内状态与已知限制

- 健康度与 `pending_redactions` 是进程内状态：重启后清零，未完成的改写不再自动重试，
  直到下一次 backfill 用 outbox 中的标记重新扫一遍本 writer 分片；期间标记保证不会回放进 store。
- 多实例各自统计，状态接口只反映收到请求的那个实例。
- 每次 clear 会读取本 writer 所有日期 ≤ `until` 的分片，开销与 outbox 大小成正比。
- 回放一次性把 `since` 之后的分片读入内存，超大 outbox 需按 `since` 分段执行。
- 回放只使用扫描范围内（`since` 之后分片里）的标记；早于 `since` 的标记不参与回放，其覆盖的事件在原 store 中已擦除，
  但若用于重建新 store，需让 `since` 覆盖相应标记所在分片。
- 封存分片与原分片短暂并存时（崩溃于 rename 与删除之间）可能留下含明文的原分片；它仍属本 writer，下次 backfill 会改写。
- 擦除改写只扫日期 ≤ `until` 的分片（分片按 `event_ts` 日期命名）：一条带旧 `event_ts` 的事件若在
  该日期分片已被改写之后才追加进来，会落进该日期**新重建的 live 分片**，本次改写已经扫过它——那行
  明文残留到下次 backfill/改写为止（标记仍保证其不会进 store）。
- `resetLedgerHealth` / `status {"reset":true}` 只清失败计数，不清 pending 擦除——后者是未完成的
  工作，丢弃它会让失败的 store 擦除永远不重试而账本却报健康。
- 已知标记集是进程内状态：按 scope 去重、按 1 小时视界过期清理（见上）；另一进程的 in-flight 明文追加收敛于该进程的下次 backfill，
  与本节“其它 writer 分片”语义一致。
- store 层查询/擦除语义（真 mongod 冒烟实测）：`queryMemoryEvents` 的 `limit` 被钳制到
  `[1, 1000]`（`0`/负数按 1 处理，不是空集）、`offset` 负值归零；`event_ts` 词法比较的正确性
  由所有写入点的 canonical 时间校验保证。SQLite 对目标分支已有的 L0/L1 时间列执行一次归一化，
  保留内容升级标记以避免每次启动全扫；账本为本 PR 新增，不保留开发版事件归一化迁移。
- `redactMemoryEvents` 的 filter 先过 `isValidRedactFilter` 白名单——仅
  `team_id/agent_id/user_id/layer/until`（`layer` 须为 `l1|l2|l3`），未知字段（如运行时塞入的 `task_id`）整单拒绝；
  `until` 经 `canonIsoTs` 校验：毫秒精确形态归一化后比较，不可无损归一的值返回 0 不擦除
  （与 `deleteL1Expired` 的 `isoToEpochMs` 护栏不同——后者数字域比较天然消歧，词法比较
  必须严格）；不带 team/agent/user 过滤时按全租户擦除并 warn。运行期
  `redactLedgerEvents` 走同款校验，被拒的擦除记 `rejected_redactions`。
- count 接口（`conversation/count`、`atomic/count`）的 `time_start`/`time_end` 保持
  `z.string()`——与生成 schema 一致、不在本特性里夹带破坏性变更；这两个过滤仍是
  裸字符串词法比较，信任调用方传规范形（基线行为，刻意不在本次收紧）。

## 保留期

memory-cleaner 按保留期删除过期 `events/*.jsonl`：分片按 **UTC** 日期命名，清理也按 UTC 日界
（`pruneLedgerOutbox`，经 StorageAdapter 与分片锁，rowfs/COS 部署下走同一 adapter）。
删除后对应时间段的事件无法再回放，但不影响 store 中已存在的事件。

网关（standalone）没有 memory-cleaner，用 `TDAI_LEDGER_OUTBOX_RETENTION_DAYS=<正整数>` 开启同样的分片
保留期：启动时执行一次，此后每 6 小时一次（`startLedgerOutboxRetention`，定时器 unref，不阻止进程退出）。
**默认关闭**——outbox 是 backfill 的数据源，删多少由部署显式决定；不设置时 `events/` 会无限增长。
service 模式暂不覆盖：各实例的存储按请求懒解析，没有进程级的实例清单可遍历，需要由外部任务
（如 COS 生命周期规则按 `events/` 前缀过期）处理。store 中的 `memory_events` 行不随保留期删除
（它们就是审阅历史，clear/TTL 只擦内容保留骨架）。
