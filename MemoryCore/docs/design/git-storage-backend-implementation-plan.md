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
- **每个记忆空间一个独立 `git clone`**，不用 `git worktree add`——独立 clone 避免共享 `.git` 目录带来的跨 worktree 锁竞争，是更"无特例"的方案。
- **`appendObject` 的幂等键 = 该次调用内容的 SHA-256**，不解析 JSONL 里业务自带的 `record_id`/`id`（已核实 L0/L1 writer 确实有这些字段）——在存储层解析业务内容格式是分层违规；SHA-256 dedup 足够覆盖现有调用方"每次调用一个完整批次"的模式。
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

**关键设计细节**

分支命名：`memory/{sanitize(tenantId)}/{sanitize(instanceId)}-{sha256(rawSeed).slice(0,8)}`，`sanitize()` 只留 `[a-z0-9_-]`；末尾 8 位哈希防止 sanitize 后碰撞。构造时跑 `git check-ref-format --branch` 兜底校验。

暂存纪律（消掉好几个 RFC 特例的一条规则）：永远不跑 `git add -A`，每次改动只 `git add -- <相对路径>` 那一个文件。`.meta.json` sidecar 自动不会被提交，put/append/delete 三种操作用同一条暂存调用。

`appendObject`（RFC 结论 4 最难的方法）：`IStateBackend.acquireLock`（依赖注入，绝不导入红线文件）+ `SerialQueue`（`utils/serial-queue.ts` 现成的，进程内并发=1）双重保护 → fetch/append/commit/push → push 被拒时基于 SHA-256 内容哈希去重重放，不盲合并。

持久化状态机：`clean → dirty-local → pushing → clean`，或 `→ push-rejected → replaying → pushing`，或 `→ push-failed`。落盘在 `state/{branch}/sync-state.json`（tmp+rename 原子写），WAL 放在 git 工作目录**之外**的兄弟目录，永远不会被误暂存。崩溃恢复不是独立代码路径，就是同一个 `flush()` 函数在进程重启后第一次访问该空间时被懒调用；`recoveryMode: "manual"`（默认）遇到 WAL 之外的未知脏改动拒绝自动 flush。

健康检查：`HealthResponse.services.gitStorage = {enabledSpaceCount, unsyncedSpaceCount, oldestPendingPushAgeMs, worstStatus}`，读内存里已有的同步状态，不做 I/O。

测试：Git 专属测试用 `git init --bare` 临时目录当 remote（不需要真实网络），覆盖崩溃恢复、push-rejected 重放去重、分支名编码。COS 不参与测试（源码在这个 checkout 里本来就不存在）。

## 请 Codex 重点评审

1. **特例/投机抽象**：组合优于重写的原则有没有真的贯彻？有没有哪里应该复用却重新实现了？
2. **`git clone` per space vs `git worktree add` off 共享 bare repo**：本计划选了前者（独立 clone，避免共享 `.git` 锁竞争），是否有更好的方案？磁盘开销 trade-off 是否可接受？
3. **分支编码方案**：`sanitize()` + 8 位哈希后缀，是否存在遗漏的边界情况（如 `..`、`@{`、尾部 `.lock`、超长 tenant/instance ID）？
4. **`appendObject` 的 SHA-256 幂等键设计**：是否足以覆盖所有现实调用模式？"每次调用一个完整批次"这个假设是否站得住？
5. **锁设计**：`IStateBackend.acquireLock` + `SerialQueue` 双重保护是否有竞态漏洞（例如锁续期失败但 `SerialQueue` 未感知）？
6. **`deleteByPrefix` 立即 flush（跳过批处理防抖）vs 走同一批处理路径**：这个决定是否合理？

## 验证方式（实现完成后）

- `cd MemoryCore && npm test`（`vitest run`）——本地跑通全部合同测试（local + git）
- 手动构造 `git init --bare /tmp/fixture-remote`，起一个真实的 `GitStorageBackend` 实例，跑 put/append/delete 全流程，人工 `git log`/`git show` 检查提交历史里只有 6 个约定前缀下的文件，没有 `.meta.json`、没有凭据
- 杀掉进程模拟崩溃（flush 中途 kill -9），重启后验证新实例能正确识别未推送的 WAL 并续跑
- 两个后端实例并发 append 同一 key，制造 non-fast-forward，验证重放去重不产生重复行
- `npm pack --dry-run` 确认没有意外新增依赖体积
