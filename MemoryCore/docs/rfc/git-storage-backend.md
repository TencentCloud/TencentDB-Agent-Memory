# RFC：以 Git 作为记忆文件存储后端

- 状态：提议
- 日期：2026-08-09
- 决策范围：只讨论 `IStorageBackend` 所承载的文件记忆；不替换向量数据库

## 摘要与建议

建议**有条件推进一个实验版**：新增工作树型 `GitStorageBackend`，复用现有文件语义，在单写者、私有远端、按批次提交的约束下试点；不要把它作为高并发在线写入的默认后端。若业务需要多实例同时追加同一 JSONL 且不能经过单写者协调器，则结论是“不做”，因为 Git push 的分支更新与业务追加之间没有跨主机原子事务。

本文的“后端”指工作树中的对象读写；Git commit/push 是其持久化与同步阶段。必须先定义可观测的同步状态，不能把一次本地写成功等同于已经远端持久化。

## 八条硬结论

### 结论 1：正确接缝是 `IStorageBackend`，不是 `IMemoryStore`

文件记忆已经由 `IStorageBackend` 抽象：合同位于 `MemoryCore/src/core/storage/types.ts:95-158`，上层由 `StorageAdapter` 包成类 fs API（`MemoryCore/src/core/storage/adapter.ts:80-283`）。向量/结构化记忆走独立的 `storeBackend: "sqlite" | "tcvdb"`（`MemoryCore/src/config.ts:183,320-323,479-480`）。因此 Git 应成为第三种**文件存储**实现，不能塞进 SQLite/TCVDB 层。

可复跑：

```bash
grep -n -E 'export interface IStorageBackend|storeBackendRaw|type StoreBackend' \
  MemoryCore/src/core/storage/types.ts MemoryCore/src/config.ts
```

### 结论 2：接口实际是 7 个方法加 1 个属性，不是 8 个方法

`IStorageBackend` 有 `type` 属性，以及 `putObject`、`appendObject`、`getObject`、`exists`、`listObjects`、`deleteObject`、`deleteByPrefix` 七个方法（`MemoryCore/src/core/storage/types.ts:95-158`）。设计与验收必须以源码合同为准；若把 `type` 口头计入“8 项”，也应明确它不是方法。`type` 联合类型及 `StorageBackendConfig.type` 都需在未来实现中加入 `"git"`（`MemoryCore/src/core/storage/types.ts:97,210`）。

可复跑：

```bash
sed -n '95,158p' MemoryCore/src/core/storage/types.ts
```

### 结论 3：Git 保存文件记忆对象，坚决不保存向量库、凭据和运行时锁

纳入版本控制的 key 空间是 `persona.md`、`scene_blocks/`、`conversations/`、`records/`、`.metadata/`、`.backup/`（`MemoryCore/src/core/storage/types.ts:248-276`）。这是合同声明的 L0–L3 文件与恢复所需元数据/备份；迁移时应保留所有这些 key，不能只挑 Markdown。

坚决不提交：SQLite/TCVDB 内容（属于另一抽象，证据见结论 1）、Git/云端认证凭据、进程锁、临时文件、clone 缓存，以及本地后端为了 `contentType/metadata` 生成的 `.meta.json` 内部 sidecar。最后一项不是业务 key：它由本地实现额外生成并在列举时主动跳过（`MemoryCore/src/core/storage/local-backend.ts:97-104,265`）；Git 后端若需保留对象元数据，应使用实现私有索引且禁止泄露密钥。远端仓库必须是私有仓库，并应用组织侧访问控制和保留策略。

可复跑：

```bash
grep -n -E 'persona:|sceneBlocksDir:|conversationsDir:|recordsDir:|metadataDir:|backupDir:|meta.json' \
  MemoryCore/src/core/storage/types.ts MemoryCore/src/core/storage/local-backend.ts
```

### 结论 4：最难的是 `appendObject`；多写者下不能承诺现有原子追加语义

现有合同明确要求追加，调用适配器会直接委托给后端（`MemoryCore/src/core/storage/types.ts:107-125`；`MemoryCore/src/core/storage/adapter.ts:109-125`）。本地实现依赖 `appendFile`（`MemoryCore/src/core/storage/local-backend.ts:108-124`）。Git 没有“远端原子追加文件”操作：两个写者从同一父提交追加后，只能由其中一个先更新分支，另一个必须拉取、合并/重放、校验后重试。

实验版必须在每个仓库内串行化 `fetch → 读取最新分支 → append → commit → push`；push 被拒后重新读取远端文件并重放**尚未确认的完整记录**，不能对字节串盲合并。唯一能给出清晰语义的部署约束是每个记忆空间单写者。没有单写者或外部排序服务时，跨主机“每次调用原子且恰好一次”无解，Git 后端必须拒绝启动或明确降级，不能悄悄声称兼容。

可复跑：

```bash
grep -n -E 'appendObject|appendFile' \
  MemoryCore/src/core/storage/types.ts MemoryCore/src/core/storage/local-backend.ts MemoryCore/src/core/storage/adapter.ts
```

### 结论 5：其余 6 个方法可映射，但提交边界必须与对象操作分开说明

逐项语义如下（加上最难的追加，共覆盖全部 7 个方法）：

| 合同项 | Git 后端提议实现 | 失败/一致性边界 |
|---|---|---|
| `putObject` | 校验 key 在工作树根内，原子写临时文件后 rename，加入暂存区；批次末 commit | 本地写成功但 push 失败时返回“本地已提交、远端待同步”状态；不能伪装完全成功 |
| `appendObject` | 单写者锁内追加完整记录并提交；远端拒绝时基于最新分支重放 | 最难；多写者严格原子语义无解，见结论 4 |
| `getObject` | 从当前已检出工作树读取 Buffer，并由 `stat` 填充大小/时间 | 默认读本地已确认提交；若要求 read-after-remote-write，先同步或报陈旧状态 |
| `exists` | 安全解析 key 后检查工作树文件 | 不把 Git tree 中未检出的对象算存在 |
| `listObjects` | 遍历工作树，按 key 排序，再应用 `marker/maxKeys/recursive` | 必须稳定排序；现有本地实现是收集后按 marker 分页（`local-backend.ts:176-204`） |
| `deleteObject` | 幂等删除工作树文件并暂存删除 | 只有 commit/push 后才完成远端删除；历史仍保留内容 |
| `deleteByPrefix` | 先枚举并计数，再删除前缀下文件并暂存 | 返回业务对象数，不计实现私有文件；历史仍保留内容 |
| `type` 属性 | 返回字面量 `"git"` | 需扩展两个联合类型；它是属性而非第 8 个方法 |

现有适配器的 `rename` 本来就是 get → put → delete，源码已注明非原子（`MemoryCore/src/core/storage/adapter.ts:188-202`）；Git commit 可以把最终树变化一起提交，但进程在暂存前后崩溃仍需启动恢复。目录在对象存储语义中是隐式的，`mkdir` 当前也是 no-op（`MemoryCore/src/core/storage/adapter.ts:158-164`）。

可复跑：

```bash
sed -n '90,240p' MemoryCore/src/core/storage/local-backend.ts
sed -n '180,205p' MemoryCore/src/core/storage/adapter.ts
```

### 结论 6：推荐工作树后端；“每对象一个分支/提交”不推荐

比较两个可实现方案：

| 方案 | 做法 | 代价 | 适用场景 |
|---|---|---|---|
| A. 每个记忆空间一个工作树与分支（推荐） | key 直接映射相对路径；本地批次写，单队列 commit/push | 需要磁盘工作树、锁、崩溃恢复和后台同步；仓库会持续增长 | 单写者、希望人工审阅/回滚、写入量中低的试点 |
| B. 每个对象版本用 Git plumbing/独立引用 | 内容写 blob/tree，用自定义 ref 或每对象分支更新 | 列举与快照需自建索引；引用数量爆炸；跨对象一致快照困难；运维工具不直观 | 极少对象、强对象隔离、团队能维护 Git plumbing 的专用系统 |

A 与当前本地映射最接近：`LocalStorageBackend` 已把 key 解析到根目录下并防目录穿越（`MemoryCore/src/core/storage/local-backend.ts:61-86`），且 `StorageAdapter` 无需理解 Git。不要“一次方法调用一次 push”；应以流水线批次/短时间窗口合并 commit，否则 L0/L1 JSONL 的高频追加会产生大量提交和网络往返。批处理意味着必须把本地持久化状态与远端同步状态分别暴露。

可复跑：

```bash
sed -n '61,86p' MemoryCore/src/core/storage/local-backend.ts
git check-ref-format --branch 'memory/tenant-a'
```

### 结论 7：配置必须独立命名，并统一三个绕过工厂的构造点

新增配置应叫 `fileStorageBackend: "local" | "cos" | "git"`（名称可在实现 RFC 中最终确定），绝不能复用现有 `storeBackend`，后者只控制 SQLite/TCVDB。Git 专属配置至少包括：本地工作树根、私有 remote URL、目标 branch、同步模式、批次窗口、单写者开关、认证引用（只引用秘密管理器，不接受 token 明文）。默认仍为 local；service 现有 COS 配置保持可选，三者互斥选择，回滚只需切回原后端。

不能只改 `factory.ts`。虽然工厂已有 local/cos 分支（`MemoryCore/src/core/storage/factory.ts:24-63`），`server.ts` 至少在 `592`、`2187`、`2352` 直接构造 `LocalStorageBackend`，另有多处直接构造 COS。因此未来实现必须让这些路径统一走解析器/工厂，否则 standalone、按实例 API 与 worker 会出现不同后端。

可复跑：

```bash
grep -n 'new LocalStorageBackend(' MemoryCore/src/gateway/server.ts
grep -n -E 'switch \(config.type\)|case "cos"|case "local"' MemoryCore/src/core/storage/factory.ts
```

### 结论 8：迁移可做成可回滚复制，但 Git 不能满足“真正删除历史”

迁移步骤：进入维护/单写者模式；冻结源端写入；对六个约定前缀递归 `listObjects`，逐项 `getObject → putObject` 到 Git 后端；比较对象数、每个 key 的字节数和 SHA-256；生成一次基线 commit 并推私有远端；以只读方式抽查；切换 `fileStorageBackend`；保留原 local/COS 快照直至观察期结束。失败时停止 Git 写入并切回只读源快照，避免双写分叉。现有 `copyTree` 已采用 list/get/put 组合（`MemoryCore/src/core/storage/adapter.ts:232-275`），说明迁移无需扩展接口，但正式工具需要分页循环，不能照搬其固定 `maxKeys: 100_000` 上限。

Git 删除只会从新树移除文件，旧 commit 仍可恢复。因此涉及“用户要求彻底删除”、凭据误提交或隐私保留期到期时，普通 `deleteObject/deleteByPrefix` 不足：需要重写历史并协调所有 clone；已被复制或拉取的内容无法追回。这条对已分发副本**无解**。若法规要求可验证擦除，不应选择 Git 作主存储。

可复跑：

```bash
sed -n '232,275p' MemoryCore/src/core/storage/adapter.ts
sed -n '248,276p' MemoryCore/src/core/storage/types.ts
```

## 风险登记

| 风险 | 触发条件 | 缓解 |
|---|---|---|
| 并发追加冲突/重复记录 | 两个实例同时追加同一 JSONL，或 push 成功但客户端超时后重试 | 每空间单写者；记录稳定事件 ID；远端拒绝后按记录重放并去重。没有协调器时严格原子恰好一次无解 |
| 敏感记忆永久留史 | persona/会话包含隐私，或凭据误写入业务 key | 私有仓库、最小权限、提交前 secret/PII 策略、短保留与加密；已被第三方拉取的历史无法追回 |
| 仓库体积与延迟持续增长 | 高频 JSONL 追加、备份累计、一次调用一次提交 | 批量提交、按租户/时间分仓、监控 pack 大小与 push 延迟、到阈值后归档；不要把二进制/向量库放入 Git |
| 本地成功、远端失败造成耐久性误判 | 网络中断、权限撤销、non-fast-forward | 状态机区分 working-tree/committed/pushed；持久化待推队列；健康检查暴露最后成功 push 时间；超过 RPO 阈值拒绝继续写 |
| 崩溃留下脏工作树/锁 | 写入、暂存、提交之间进程退出 | 单仓库进程锁；启动时检查 index/worktree，只能重放带事件 ID 的日志；不自动丢弃未知修改 |
| 分支/key 注入与目录穿越 | tenant/instance/key 来自外部输入 | 复用并强化 `resolvePath` 规则；分支名用固定编码映射并经 `git check-ref-format`；不把用户输入拼进 shell |
| 配置路径不一致 | 只扩展工厂，三个直接构造点仍走 local | 用同一解析器覆盖启动、按实例与 worker 路径；合同测试逐路径断言 backend type |

## 验收门槛与试点退出条件

在写产线实现前，先补合同测试（当前仓库任务书确认无可用测试基线，且本次 RFC 不改测试/依赖）：同一套用例覆盖 7 个方法、路径穿越、分页、崩溃恢复、push 拒绝、重复事件与两写者冲突。缺少的 COS 后端源码也必须在完整构建源中跑相同合同测试。

试点仅限脱敏数据、私有远端、单写者；记录 p95 写入延迟、待推队列长度、最后 push 年龄、仓库 pack 大小与冲突重试数。出现任一情况即退出：无法保证单写者、远端落后超过约定 RPO、历史删除成为硬性要求、仓库增长超预算，或追加重试出现无法去重的数据。

## 拍板结论

- 若目标是低到中频、单写者、可人工审阅和回滚的文件记忆：做工作树型实验版，Git 作为有延迟的同步持久层。
- 若目标是高频多写者在线主存储，或要求可验证彻底删除：不做；继续使用 local/COS 文件层，并把审计/版本能力做在外围。
- 本 RFC 不建议改向量存储，也不建议双写作为长期架构；迁移期双写会引入无法可靠判定主副本的分叉。
