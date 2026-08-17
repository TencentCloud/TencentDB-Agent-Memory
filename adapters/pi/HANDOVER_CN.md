# Pi 适配器工作交接

> 交接日期：2026-08-17
> 分支：`codex/pi-memory-adapter`（38 笔 commit，领先 `feat/server_team`）
> 已推送到 fork：`kbob3687-hub/TencentDB-Agent-Memory`
> 关联 issue：#926（TencentDB 共建计划第二季，2026-08-10 ~ 08-31）

---

## 1. 一句话概括

一个 Pi 本地扩展，通过**官方 SDK** 把 TencentDB Agent Memory 接进 Pi：让 Pi 拥有**跨会话持久记忆**（L0-L3）和**技能学习**（服务端自动提炼 SKILL.md，可同步成 Pi 原生技能），全程 **fail-open**（记忆挂了 Pi 照常回答）且**不可信边界**（召回内容绝不当作指令执行）。

## 2. 已完成功能（全部有测试/E2E 背书）

| 能力 | 说明 | 验证 |
|---|---|---|
| L0-L3 自动召回 | `before_agent_start` 注入 4 层记忆（不可信上下文），全局 3s deadline | `e2e:l0-l3` |
| L0 可靠采集 | 文件 outbox（跨进程 lease、离线补投、死信 `.dead` 隔离、at-least-once） | `e2e:lifecycle` |
| 分支隔离 | `/tree` 分支独立 Memory session；`/fork` 天然隔离 | `e2e:lifecycle` |
| setup 向导 | 交互配置 + 验证身份/L0-L3 + 创建私有 Agent；**复用非私有 Agent 会警告** | `e2e:setup` |
| 只读工具 | `tdai_memory_search` / `tdai_conversation_search` / `tdai_skill_search` / `tdai_skill_read`（共享每轮 3 次限额） | 单测 |
| Skill 学习 | 五角色采集 → `conversation/add` → 服务端归档 → LLM 提炼 SKILL.md → 召回注入第五层 `[Skill]` | `e2e:skill` |
| Skill 同步（P3） | `/tdai-memory-sync-skills` 下载到 `<agentDir>/skills/<name>/`，成为 Pi 原生技能（可编辑、`/skills` 可见） | `e2e:skill` + 单测 |
| 状态透明 | `/tdai-memory-status` 显示记忆是否已有 + skill pending/uncertain/dead | 单测 |
| 安全 | 脱敏、项目配置沙箱、TLS 强制、capture 结构校验 fail-closed、peer 版本声明 | 单测 |

## 3. 关键设计决策（不要轻易推翻，都踩过坑）

1. **官方 SDK，不手写 HTTP**——vs 竞品 #954 手写 client 的核心差异化。
2. **Skill 写入 at-most-once，不是 durable outbox**——`conversation/add` 是增量追加 + 计数跨批次累计，durable 重试会重复追加、提前归档。模糊失败标记 `uncertain` **绝不自动重试**。
3. **召回是"不可信上下文"**，不是把技能当指令注入；本地同步（P3）是用户显式信任后才落成本地原生技能。
4. **项目配置只放行 `recall.*`**，绝不让项目文件碰 endpoint/密钥（安全审计 P0 修复的延续）。
5. **同步落点是 `<agentDir>/skills/<name>/`**（Pi 原生发现路径），不是独立缓存目录；用 `tdai-remote.json` 标记所有权，同名手写技能不覆盖。

## 4. 代码地图（`adapters/pi/src/`）

| 文件 | 职责 |
|---|---|
| `index.ts` | 扩展入口：hooks（recall/采集/工具调用配对）、4 个命令、4 个工具 |
| `capture.ts` | L0 消息规范化 + 助手消息**结构校验**（fail-closed） |
| `outbox.ts` | L0 跨进程文件 outbox（lease 竞态 + 心跳续租） |
| `recall.ts` | 四层（L0-L3）+ 第五层 Skill 并行召回，全局 deadline，预算分配 |
| `skill-capture.ts` | 五角色 normalizer + at-most-once 一次到位投递（pending/uncertain/dead） |
| `skill-sync.ts` | P3：远程技能 fetch/校验/原子安装到 Pi 原生目录 |
| `security.ts` | `redactText` + 递归 `redactValue` + UTF-8 安全截断 |
| `config.ts` | 配置加载/校验/合并/环境变量（含 `skills` 对象） |
| `setup.ts` | 交互向导（含私有 Agent 警告） |
| `status.ts` | 状态检查（含记忆/技能管线透明显示） |
| `clients.ts` | Memory/Metadata/SkillClient 工厂 |
| `tools.ts` | 4 个只读搜索工具 |
| `session.ts` | 分支隔离记忆身份 |

测试：`test/`（12 文件 118 测试）；E2E：`scripts/e2e-{setup,lifecycle,l0-l3,skill}.mjs` + `verify-pi-load.mjs`。

## 5. 如何跑（维护者）

```powershell
cd adapters/pi
npm ci
npm run check        # typecheck + 118 单测
npm run verify:pi-load
# 真实 E2E（需 Docker + .env 的 MEMORY_LLM_*）
npm run e2e:setup -- --env-file ../../deploy/global-images/.env
npm run e2e:lifecycle -- --env-file ../../deploy/global-images/.env
npm run e2e:l0-l3 -- --managed-core --env-file ../../deploy/global-images/.env
npm run e2e:skill -- --managed-core --env-file ../../deploy/global-images/.env
```

## 6. 踩坑与经验（本会话真金白银换来的，务必保留）

- **服务端 yaml `skill.extraction.toolCallThreshold` 不生效**——设 1/2 仍走默认 10。归档只能靠**字节阈值（40KB 累计）**或 10 次工具调用。适配器按默认行为设计，未深挖（服务端问题）。
- **发布版 npm SDK（beta.2）无 `conversation/force-archive`**——14 端点；仓库源码是 15（含 force-archive，未发布）。E2E 用字节阈值驱动归档。
- **归档按会话累计**：40KB 或 10 次工具调用**单会话内**。日常短会话很难触发 → 技能学得慢是设计，不是 bug。快速看技能用 `scripts/make-skill.mjs`。
- **审查模型只收"可复用技术"**（≥72 分），拒绝"项目事实/单次会话/环境细节"。测试/演示对话必须做成通用技术（E2E 用"Node CI OOM 排查"）。
- **`skill.search` 匹配 name+description+snippet，不匹配 SKILL.md 正文关键词**——断言/召回不要依赖正文独有词。
- **官方冷启动（v2.0.1-beta.2）自动建团队可见的 `default-agent-<用户名>`**——个人记忆放进去会团队共享；向导已加警告，默认建私有 Agent 更安全。
- **Pi 耦合**：`peerDependencies` 声明 `>=0.84.1 <0.85`；capture 读消息结构有 fail-closed 守卫。升级 Pi 前先跑 `verify:pi-load` + E2E。
- **Windows Docker Desktop**：`docker stop/start` 会丢自动分配的宿主端口绑定（healthy ≠ 端口可达），离线恢复必须删容器重建 + 固定端口。

## 7. 已知边界 / 未做

- status 的 `Skills: pending/uncertain/dead` 是文件扫描计数，`uncertain` 记录没有一键重发/清理命令（手动删文件即可）。
- 手动 flush 命令、`/tdai-memory-archive-skill` 未做。
- 服务端 `toolCallThreshold` yaml bug 未修（服务端侧）。
- 上游 `TencentCloud` 仓库已发布 v2.0.1-beta.2（比 fork 的 `feat/server_team` 领先 7 笔），含冷启动/默认 Agent/Wiki 加速/Skill 导出——**合并前建议评估是否要对齐**。

## 8. 提 PR 待办

- [ ] 决定 PR 目标（fork 内 / 对上游 TencentCloud）
- [ ] 38 笔作为一个 PR 提交（已选：整支一个 PR）
- [ ] 写 PR 标题：`[good first issue-platform adapt-Pi.dev] Pi adapter: durable memory + skill learning`
- [ ] PR 描述要点：官方 SDK / L0-L3 召回 + outbox 可靠采集 / Skill 学习闭环 + 原生同步 / fail-open + 安全 / 118 单测 + 4 套真实 E2E / 已知边界
- [ ] DCO 已含（commit 均带 Signed-off-by）
- [ ] 注意：工作区两个 deploy 脚本改动（本地 Windows 修复）未提交、不进 PR

## 9. 快速体验路径（给接手的人）

1. 本地 MemoryCore 跑着（`tdai-memory-core` 容器，技能抽取已开）
2. `pi -e <适配器目录>`
3. `scripts/check-skills.mjs`（看服务端已有技能）/ `scripts/make-skill.mjs`（强制造一个）
4. `/tdai-memory-sync-skills` → 拉到 Pi 原生 `/skills`
5. 问相关问题 → `memory: recalled` + 第五层 `[Skill]` 注入
