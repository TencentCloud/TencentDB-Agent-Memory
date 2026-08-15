# 实现计划：GitStorageBackend

- 状态：设计评审中（Codex 检查点 A）
- 关联：[docs/rfc/git-storage-backend.md](../rfc/git-storage-backend.md)、上游 RFC PR [#894](https://github.com/TencentCloud/TencentDB-Agent-Memory/pull/894)
- 分支：`feat/git-storage-backend`，基于 `feat/server_team`（**注意**：不是 `main` —— `main` 是另一条落后且结构不同的分支，`IStorageBackend` 在那条线上不存在；`feat/server_team` 才是 PR #894 实际的 base branch）

## Context

RFC 已核实：文中每处代码引用都逐字节对照当前源码验证过，工程判断（单写者约束、本地/远端持久化状态分离、Git 无法真正删除历史）站得住。现在把它变成真代码。

本仓库存储层此前**没有任何测试**（`vitest` 配置好但零 `.test.ts` 文件），CI 也不跑测试/lint/typecheck。`createStorageBackend()` 工厂函数**零调用**——不是"被绕过"，是从未被真正接入。因此这次实现顺带把存储层测试基线和工厂接入补齐。

目标：在不违反 CI 红线（禁止改动 `src/core/state/{types,local-backend}.ts`、`src/services/pipeline-worker.ts`、`src/integrations/redis/**`，禁止 `src/core/skill/**` 新增直接 `fs` import）的前提下，实现 `GitStorageBackend`，接入配置与 `server.ts` 的 3 个构造点，然后过一轮 Codex 交叉评审再考虑对外提 PR。

## 架构决策（组合优于重写）

`GitStorageBackend` 内部持有一个 `LocalStorageBackend` 实例（指向本地 clone 的工作目录），纯文件 I/O（`getObject`/`exists`/`listObjects`，以及 put/append/delete 的文件落盘部分）直接委托给它——白得 `.meta.json` sidecar 处理、marker 分页逻辑，只在"写入"路径上叠加一层薄的 git 同步层（WAL、暂存、批量 commit/push、冲突重放）。4 个方法几乎不用新写代码，且复用已验证正确的 `resolvePath` 逻辑（现已抽成 `path-safety.ts`）而不是再抄一份。

其余关键决定：
- **Shell 出系统 `git` 二进制**（`execFile`，参数用数组不用字符串，杜绝 shell 注入），不加 `simple-git`/`isomorphic-git` 依赖——本仓库已有的风险姿态是"外部依赖是可以接受的"（COS 需要网络+密钥），这里只是换成"需要 PATH 上有 git"，且免去 COS 那套动态 import + optionalDependency 的仪式。
- **`factory.ts` 静态 import** `GitStorageBackend`（不是 COS 式动态 import）——没有重量级可选依赖需要延迟加载。
- **每个记忆空间一个独立 `git clone --single-branch --no-tags`**，不用 `git worktree add`——独立 clone 运维更简单、无需管理跨 worktree 共享对象库的 GC；`--single-branch` 是必须的，否则普通 clone 会把远端其余所有空间的分支历史也拉下来，磁盘/网络开销随空间数量接近平方增长（Codex 检查点 A 指出的问题，已修订）。首次创建空间（分支在远端还不存在）时改用 `git init` + `git remote add` + 本地建 orphan branch，而不是 `clone`。
- **`appendObject` 的幂等键 = 后端自生成的操作 UUID**，不解析 JSONL 里业务自带的 `record_id`/`id`（已核实 L0/L1 writer 确实有这些字段，但在存储层解析业务内容格式是分层违规），也**不是**内容 SHA-256（Codex 检查点 A 指出：内容哈希会把"合法的重复内容"误判成"崩溃重放"，静默丢数据，已修订为操作 UUID + commit message trailer 记账，见下方"关键设计细节"）。
- **`fileStorageBackend` 配置新增 `"auto"` 默认值**（RFC 原文是 `local|cos|git` 三选一）——因为这个字段今天在 `config.ts` 里完全不存在，现网服务模式是靠 `deployMode`+运行时 COS client 存在与否临时推断的；如果默认值是 `"local"`，会静默改变现网行为。`"auto"` = 保留现状推断，显式设置才生效。

## 实现范围

**不包含**：RFC §8 的迁移工具（未来工作）、Option B（每对象一个 ref 的 git plumbing 方案）、修复 `StorageAdapter.rename` 的非原子性（adapter 层限制，本次不动）、任何对红线文件的改动。

## 已完成（阶段 1-3，先于本次设计评审落地）

- 合同测试框架 `storage-backend.contract.ts`（覆盖 7 方法 + 路径穿越 + 分页 + 幂等删除）+ `LocalStorageBackend` 首个测试覆盖（35 用例）
- CI 新增 `test:` job 跑 `vitest run`（**已知缺口**：`pr-ci.yml` 目前只在 `pull_request.branches: [main]` 触发，而本 PR 及上游 RFC PR #894 都以 `feat/server_team` 为 base——`gh pr checks 894` 显示"no checks reported"，说明这条 CI 目前对这条分支的 PR 完全不触发。这是仓库级触发范围问题，本次未修改，留给维护者定夺）
- 配置骨架：`fileStorageBackend`/`git` 字段与解析块（`config.ts`）、`configSchema` 镜像 `tcvdb` 块（`openclaw.plugin.json`）、`IStorageBackend.type`/`StorageBackendConfig.type` 拓宽加 `"git"`、新增 `IGitCredentialProvider`/`GitCredential`（`types.ts`）；顺带修了 `ScopedStorageBackend.type`（`adapter.ts:17`，RFC 结论 2 漏掉的第三处需要拓宽的地方）
- `path-safety.ts` 抽取（`resolveSafeRelativePath()`），`local-backend.ts` 改用它，纯行为保持型重构，35 用例回归全过 + 12 个新增单测
- 每步都做了 `tsc --strict --noEmit` 全量对照检查：改动前后 325 行历史遗留类型错误数量完全一致，零新增

## 待实现（阶段 5-8，Codex 检查点 A 通过后开始）

**新增文件**
- `git-cli.ts` — `execFile` 封装的 git 子命令（fetch/push/commit/add/status/init/clone/check-ref-format），结构化返回值 + 超时
- `git-credential.ts` — `IGitCredentialProvider` 具体实现（镜像 `credential-provider.ts` 的 Mock/Static 分法）
- `git-backend.ts` — `GitStorageBackend` 主体
- `../../gateway/storage-resolver.ts` — `resolveFileStorageBackend()`，替掉 `server.ts` 里两处几乎重复的 resolve 逻辑
- `git-backend.test.ts` / `git-backend.git-specific.test.ts`

**关键设计细节（已按下方"Codex 检查点 A 评审结论"修订，此处是修订后的最终版本）**

分支命名：对 `(tenantId, instanceId)` 做长度前缀编码后取完整 SHA-256（32 位十六进制，128 bit），拼成 `memory/{sanitizeSlug(tenantId)}/{sanitizeSlug(instanceId)}-{hash32hex}`；`sanitizeSlug()` 只留 `[a-z0-9_-]`，截断到 40 字节，清空后用占位符 `"empty"` 兜底。构造时跑 `git check-ref-format --branch` + 显式总长度校验兜底。

Git 保留路径防护：任何首段等于 `.git` 的 key 在委托给内部 `LocalStorageBackend` 之前直接拒绝（clone 根目录下真实存在 `.git/`，委托是"直接转发"不是"沙箱隔离"，必须显式挡住）。

暂存纪律（消掉好几个 RFC 特例的一条规则）：永远不跑 `git add -A`，每次改动只 `git add -- <相对路径>` 那一个文件。`.meta.json` sidecar 自动不会被提交（仅本地可见，跨 clone 后消失，这是接受的限制，需有测试显式验证），put/append/delete/deleteByPrefix 都走同一条暂存调用。

`appendObject`（RFC 结论 4 最难的方法）：锁的获取/续约检查放进每个 `SerialQueue` 入队任务内部（不是外面获取一次就不管），续约失败置 `lockLost`、下一步 git 操作前检查、命中即中止并保留 WAL。流程：fetch → append → commit（message trailer 写入本批次全部操作 UUID）→ push；push 被拒时 `git log origin/<branch>` 扫最近提交的 message，命中已知操作 UUID 的视为已落地跳过，其余重放——**幂等键是后端自生成的操作 UUID，不是内容哈希**（内容哈希会把"合法的重复内容"误判成"已处理"，静默丢数据）。锁本身只降低写者互踩概率，真正的正确性兜底是 git 非强制 push 的 ref CAS；多实例部署必须注入真实分布式 `IStateBackend`，进程内 `LocalStateBackend` 在多实例场景下等于无锁。

持久化状态机：`clean → dirty-local → pushing → clean`，或 `→ push-rejected → replaying → pushing`，或 `→ push-failed`。落盘在 `state/{branch}/sync-state.json`（tmp+rename 原子写），WAL 放在 git 工作目录**之外**的兄弟目录，永远不会被误暂存。崩溃恢复不是独立代码路径，就是同一个 `flush()` 函数在进程重启后第一次访问该空间时被懒调用；`recoveryMode: "manual"`（默认）遇到 WAL 之外的未知脏改动拒绝自动 flush。`deleteByPrefix` 和其他写操作走同一条批处理防抖路径（不再立即 flush——实际调用点如 `skill-versioning.ts` 会在循环里连续调用，立即 flush 会产生一次删除一次 push），需要同步完成信号的调用方改用显式的 `flush()`/durability-barrier 方法，在整个工作流结束后调用一次。

健康检查：`HealthResponse.services.gitStorage = {enabledSpaceCount, unsyncedSpaceCount, oldestPendingPushAgeMs, worstStatus}`，读内存里已有的同步状态，不做 I/O。

测试：Git 专属测试用 `git init --bare` 临时目录当 remote（不需要真实网络），覆盖崩溃恢复、push-rejected 重放去重、分支名编码。COS 不参与测试（源码在这个 checkout 里本来就不存在）。

## Codex 检查点 A：评审结论与修订（2026-08-15）

六项全部判定"需要改设计"，逐条核实（对照实际调用点）后全部属实，采纳如下修订：

**1. 组合掩盖了 Git 专属策略（needs-change → 已修订）**
`LocalStorageBackend` 的委托没有过滤掉 `.git/` 这个真实存在于 clone 根目录下的保留路径——一个形如 `.git/config` 的 key 会被当作普通业务 key 正常读写，直接暴露/篡改 git 自身控制文件。修订：`GitStorageBackend` 在委托前拒绝任何首段等于 `.git` 的 key（大小写敏感，精确匹配）。另外，`.meta.json` sidecar 不同步到远端这件事本来就在计划里被标注为"接受的限制"，现在补一条要求——必须有测试显式验证"跨 clone 后 metadata 消失"，不能只在文档里嘴上说说。

**2. `git clone` per space 需要限定单分支（needs-change → 已修订）**
普通 `git clone` 默认拉取远端所有分支；如果一个 remote 上有 N 个记忆空间各一个分支，每个空间的 clone 都会带上其余所有空间的历史，磁盘/网络开销接近 N² 级别。修订：改用 `git clone --single-branch --branch <branch> --no-tags <remote> <dir>`；首次创建空间时（分支在远端还不存在）不能用 `clone`（会因分支不存在而失败），改为 `git init` + `git remote add origin <remote>` + 本地建 orphan branch。保留"独立 clone、不用 `git worktree add`"的整体选择——Codex 指出"共享 worktree 锁竞争"这个顾虑本身被夸大了（index/HEAD 是 per-worktree 的，只有对象库/引用维护是共享的），但独立 clone 仍是运维更简单、无需管理跨 worktree 对象库 GC 的更保守方案，只是必须限定单分支来避免历史膨胀。

**3. 分支命名需要更强的抗碰撞设计（needs-change → 已修订）**
原方案 8 位十六进制哈希只有 32 bit，在几千个记忆空间量级上有实打实的生日碰撞风险；`sanitize()` 也没处理"清空后变成空字符串"的边界（如 tenantId 全是被过滤字符）；`check-ref-format` 只做语法校验，不检查长度/碰撞。修订：
- 哈希后缀从 8 位十六进制（32 bit）改为完整 SHA-256 的 32 位十六进制前缀（128 bit）；
- 哈希输入改成对 `(tenantId, instanceId)` 做无歧义的长度前缀编码（如 `` `${tenantId.length}:${tenantId}${instanceId.length}:${instanceId}` ``），避免"ab"+"c" 和 "a"+"bc" 拼接后撞成同一个哈希输入；
- sanitize 后为空的分量用固定占位符（如 `"empty"`）兜底，不允许空分量直接进入分支名；
- 每个分量截断到固定字节上限（如 40 字节，按 UTF-8 字节而非字符计数），并在跑 `check-ref-format` 之外额外显式校验总长度。

**4. `appendObject` 幂等键必须是操作 ID，不能是内容哈希（needs-change → 已修订，最重要的一条）**
这是最严重的一处：用内容 SHA-256 做幂等键，会把"同一操作因崩溃重放"和"业务上合法地追加了两次完全相同的内容"混为一谈——后者是真实场景（如两条完全相同的日志行），用内容哈希去重会**静默丢数据**。修订：
- 每次 `appendObject` 调用在真正写入前，由后端自己生成一个操作 UUID（`crypto.randomUUID()`），写入 WAL 条目；
- 不新增单独的 receipts 账本文件，而是把已应用的操作 ID 复用 git 自己的历史作为唯一真相来源：每次 flush 提交时，把本批次包含的所有操作 ID 写进 commit message trailer（如 `Ops: <opId1> <opId2> ...`）；push 被拒后 `git log origin/<branch>` 往回扫最近若干条提交的 message，命中的 op ID 视为已落地，只重放未命中的；
- 明确写清楚一个接受的限制：`IStorageBackend.appendObject` 接口本身不接受调用方传入的幂等 token，所以"调用方自己重试导致的重复"（不是我们这边崩溃触发的重放）无法被区分和去重——这是接口层面的限制，不在这次改动范围内（改接口签名会影响 local/COS 两个现有实现）。

**5. 锁与 `SerialQueue` 的组合需要让续约失败真正打断执行（needs-change → 已修订）**
`SerialQueue`（`utils/serial-queue.ts`）是纯本地 FIFO，对外部锁的租约状态完全无感知——锁续约在别处静默失败时，`SerialQueue` 里已入队/正在跑的任务不会自动停下来。修订：把锁的获取/续约检查放进每个入队任务内部（而不是只在外面获取一次），续约失败时设置 `lockLost` 标志，在下一步 git 子进程操作前检查该标志，命中就中止本次 flush、保留 WAL 不动、要求下次操作重新获取锁——这正是 `pipeline-worker.ts` 续约失败时用 `AbortController` 中断执行的现成模式，直接照抄。同时明确一点：`IStateBackend` 没有 fencing token，锁本身只能降低"多个写者互相踩"的概率、减少无用功，**真正的正确性兜底是 git 自己的非强制 push 被拒（ref 层面的 CAS）+ 冲突重放**——多实例部署时必须注入真实的分布式 `IStateBackend`（如 Redis 后端），进程内 `LocalStateBackend` 在多实例场景下等于没锁，这一点要在文档里显式写成硬性运维要求。

**6. `deleteByPrefix` 不应该跳过批处理防抖（needs-change → 已修订）**
原方案假设 `deleteByPrefix` 是"罕见的管理员操作、需要强完成保证"，但实际调用点 `skill-versioning.ts:361` 是在循环里对每个版本各调一次——如果每次都立即 flush，会产生"每个版本一次 commit+push"，既慢又会把中间态的残缺树暴露到远端，还完全违背批处理的初衷。修订：`deleteByPrefix` 回归和 put/append/delete 一样的路径——WAL 立即写入，但 commit/push 走正常的防抖/最大延迟策略；如果调用方确实需要"确认已经推送成功"的同步信号（比如整个批量删除工作流跑完后要确认落地），提供一个显式的 `flush()`/durability-barrier 方法供调用方在**整个工作流结束后调用一次**，而不是让每次 `deleteByPrefix` 都单方面加上网络依赖的强完成语义。

## 验证方式（实现完成后）

- `cd MemoryCore && npm test`（`vitest run`）——本地跑通全部合同测试（local + git）
- 手动构造 `git init --bare /tmp/fixture-remote`，起一个真实的 `GitStorageBackend` 实例，跑 put/append/delete 全流程，人工 `git log`/`git show` 检查提交历史里只有 6 个约定前缀下的文件，没有 `.meta.json`、没有凭据
- 杀掉进程模拟崩溃（flush 中途 kill -9），重启后验证新实例能正确识别未推送的 WAL 并续跑
- 两个后端实例并发 append 同一 key，制造 non-fast-forward，验证重放去重不产生重复行
- `npm pack --dry-run` 确认没有意外新增依赖体积
