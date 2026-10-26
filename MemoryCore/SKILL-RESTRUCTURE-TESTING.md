# Skill 语义重构：测试计划与验证记录

> **验收重点不是“文件变小了”，而是：有效规则保留下来，结构更合理，结果能安全进入现有生命周期。**

[设计方案](./SKILL-RESTRUCTURE.md) · **测试计划与验证记录** · [效果说明](./SKILL-RESTRUCTURE-EVALUATION.md)

## 1. 验收标准

- 大小只触发诊断；同一能力不被机械拆碎，清晰的包可以保持原样。
- 原版本和候选都进入必要的检查。候选已经变短，不能掩盖原包被删掉的关键规则。
- 正文、引用、脚本、模板和资源共同构成可用的包；未读内容不能被假称为已验证。
- 权限、结构或独立审核不通过时，不发布未经批准的结果。
- 发布遇到并发修改、超时、重启或资产登记失败时，能识别已经提交的部分，避免重复版本、覆盖后续修改或误删资源。
- 重构后的 Skill 可被检索、加载和继续更新；父、子 Skill 的版本不能混用。
- 本次改动的相关测试通过，严格类型扫描相对原分支不引入新增诊断。

## 2. 测试分层

| 层次 | 验证内容 | 方法 |
|---|---|---|
| 可重复自动化测试 | 工具协议、校验、隔离、版本和故障恢复 | 受控 runner、故障注入、真实本地存储及接口测试 |
| 真实模型评估 | 内容理解、整理方式、规则保留和独审效果 | 固定合成样本；写作者与审核者使用独立上下文 |
| 整理后的任务验证 | 结果是否仍能指导任务、脚本是否符合约束 | 前后任务决策对照；审核后的脚本执行检查 |

自动化测试中的脚本化模型用于稳定复现边界，不作为模型语义能力的证明；真实模型和效果证据单独记录在[效果说明](./SKILL-RESTRUCTURE-EVALUATION.md)。

## 3. 自动化测试计划与对应实现

以下列出主要场景和验收条件，不宣称穷尽所有输入组合。

| 测试目标 | 主要场景与期望 |
|---|---|
| 诊断策略 | 小包常规发布、较大包进入诊断、独审后允许 keep；保持未变化的包不制造新版本 |
| 原版约束保留 | 原包较大而候选变短、候选遗漏 TLS 规则、原版指纹变化；不能跳过原版审核或复用错误缓存 |
| 包结构与资源 | 非法路径、引用/锚点错误、资源声明不符、字节损坏；明确拒绝，不静默丢资源 |
| 预算与取消 | 调用、步骤、读写字节或 deadline 耗尽，以及运行中取消；停止后不能继续使用旧工具上下文发布 |
| 私有草稿 | 模型写入不直接改变 live Skill；覆盖前完成读取，保留资源属性和必要元数据 |
| 幂等与并发 | 重放同一意图、同 ID 不同输入、源版本漂移、竞争发布；只接受合法结果，不覆盖胜出版本 |
| 发布恢复 | 丢失提交确认、资源准备失败、资产登记失败、数据库关闭重开；保留回执并恢复，已冻结计划不重复调用模型 |
| 配额与授权 | 新意图和实际新写入受配额限制；已接受意图重放和已提交资产修复不重复申请；错误 owner/team 不获得写权限 |
| 删除与手动修复 | 远程删除失败后按授权回执继续清理；null head 不是删除授权；允许显式替换/移除损坏资源，仍拒绝继承缺失字节 |
| 调用链路 | HTTP/队列/SDK 的身份与错误信息一致；父 v12、子 v1 和子独立升级的正文/附件读取保持版本一致 |

### 测试入口

- **诊断、原版对照和结构/预算校验**：[`skill-restructure-config.test.ts`](./src/core/skill/skill-restructure-config.test.ts)、[`engine.test.ts`](./src/core/skill/restructure/engine.test.ts)、[`baseline.test.ts`](./src/core/skill/restructure/baseline.test.ts)。
- **草稿、操作和幂等**：[`skill-draft-session.test.ts`](./src/core/skill/skill-draft-session.test.ts)、[`skill-extractor-drafts.test.ts`](./src/core/skill/skill-extractor-drafts.test.ts)、[`skill-restructure-service.test.ts`](./src/core/skill/skill-restructure-service.test.ts)。
- **存储与发布故障**：[`skill-publication-coordinator.test.ts`](./src/core/skill/skill-publication-coordinator.test.ts)、[`存储契约测试`](./src/core/skill/__contract__/)、[`skill-delete-recovery.test.ts`](./src/core/skill/skill-delete-recovery.test.ts)、[`skill-state-store.test.ts`](./src/core/skill/skill-state-store.test.ts)。
- **HTTP、队列与重启**：[`skill-restructure-runtime.test.ts`](./src/gateway/skill-restructure-runtime.test.ts)、[`skill-restructure-api.test.ts`](./src/gateway/skill-restructure-api.test.ts)、[`restructure-queue.test.ts`](./src/core/skill/conversation-add/restructure-queue.test.ts)、[`skill-restructure-recovery.test.ts`](./src/core/skill/skill-restructure-recovery.test.ts)。
- **子 Skill 与 SDK**：[`Proxy 测试`](../MemoryProxy/src/skill/__tests__/skill-bridge-resources.test.ts)、[`TypeScript SDK 测试`](../sdk/memory-core/typescript/tests/skill-restructure.test.ts)、[`Python SDK 测试`](../sdk/memory-core/python/tests/test_skill_restructure.py)。

### 本地基础设施范围

SQLite 控制记录、文件资源、部分 MongoDB 文档存储及 HTTP 链路使用真实本地实现。服务测试中的模型与配额响应受控；部分远程存储契约使用模拟响应。重启场景会关闭并重新打开数据库、metadata 和 Gateway 对象，但不是生产进程故障演练。Proxy 使用 handler 与模拟上游；SDK 使用真实 loopback HTTP 和固定响应。

## 4. 语义质量测试计划

固定样本位于 [`scripts/skill-restructure-fixtures.ts`](./scripts/skill-restructure-fixtures.ts)。

| 样本 | 预期验证点 |
|---|---|
| 重复排障历史 | 提炼规则而非搬运流水账；保住第 118 条中的 TLS 约束 |
| 独立能力混装 | 数据库排障和无障碍检查合理分开，各自可单独触发 |
| 二进制较大但结构清晰 | 不因为附件体积大而强制改写或拆分 |
| 原包规则在候选中丢失 | 审核仍能看到原版；拒绝遗漏或缩窄约束的结果，并验证有界修正 |
| 重复操作与报告格式 | 形成可复用脚本、参考说明和模板；审核后再检查脚本行为 |

验收同时查看原包、候选、结果、引用和独立审核证据。字数和资源数是辅助观察指标，不单独决定通过。生成模板的检查属于这组模型评估，不混入 Vitest 自动化测试数量。

## 5. 已通过的本地检查

验证基于原分支 `6a4bb55`，记录日期为 2026-10-23。后续文档整理未修改运行时行为。

| 检查 | 结果 |
|---|---|
| MemoryCore 自动化测试 | **483 项通过，19 个测试文件** |
| MemoryProxy 自动化测试 | **54 项通过** |
| TypeScript SDK 测试 / 包类型检查 | **5 项通过 / 通过** |
| Python SDK 同步、异步接口测试 | **10 项通过** |
| 本次功能代码及相关测试的严格类型检查 | **通过** |
| 原分支对照：Core 运行时入口及依赖链的严格扫描 | **无新增诊断**；原分支 196 条，当前 150 条 |
| 插件构建 | **通过** |
| 插件 manifest、包内容及体积检查 | **通过**；包低于现有 2 MiB 限制，测试和本地记录不打入包 |
| 隔离、变更范围、凭据样例与暂存内容检查 | **通过**；没有修改记忆管线红线文件或新增依赖 |
| 贡献规范与提交材料 | **已检查**；修正导入、Python 格式/注解，准备 Conventional Commit / DCO 草稿与 PR 说明 |

四个模块合计 **552 项自动化测试**。定向复核时重复运行的测试不再累加。五组真实模型评估、26 项生成脚本检查及模型记录重放分别统计，详见[效果说明](./SKILL-RESTRUCTURE-EVALUATION.md)。

### 验证边界与原分支差异

- 没有接入维护方的云端 TCVDB/COS、MongoDB 副本故障环境或已安装宿主，未将这些项目标作云端实测通过；本地 MongoDB 文档测试不包含搜索服务初始化。
- 入口依赖链的严格扫描是额外检查，不是全仓库所有模块的统一类型检查。“无新增诊断”是原分支对照结果，不表示原有诊断已清零；Proxy 仍有原分支的模块缺失诊断。
- 原分支完整构建和正常打包存在 `scripts/seed-v2/tsconfig.json` 缺失，本次同样复现。插件构建通过；包内容/体积检查显式跳过 prepack，不等同于正常打包成功。没有为本 PR 删除构建阶段或修改 CI 规则。
- 线上 CI 和维护者 Review 在提交 PR 后进行，不以本地记录代替。

## 6. 如何复验

先安装各模块声明的依赖；Python SDK 测试需要 `httpx`。在仓库根目录运行：

```bash
npm --prefix MemoryCore test
npm --prefix MemoryProxy test
npm --prefix sdk/memory-core/typescript test
npm --prefix sdk/memory-core/typescript run build -- --noEmit
PYTHONPATH=sdk/memory-core/python python3 -m unittest discover -s sdk/memory-core/python/tests -v
npm --prefix MemoryCore run build:plugin
npm --prefix MemoryCore run lint:skill-isolation
```

运行时入口依赖链的额外严格扫描，在 `MemoryCore` 目录运行以下命令，并与相同依赖下的原分支结果对照：

```bash
npx tsc --noEmit --strict --skipLibCheck --target ES2022 \
  --module NodeNext --moduleResolution NodeNext --esModuleInterop --types node \
  src/gateway/server.ts src/core/tdai-core.ts
```

### 真实模型评估入口

```bash
MemoryCore/node_modules/.bin/tsx MemoryCore/scripts/eval-skill-restructure-bridge.ts \
  --fixture independent-capabilities --output .local-docs/skill-restructure-live/new-run
```

该工具把真实引擎的私有工具暴露给本地模型上下文，**不是自行调用 provider 的客户端**：

1. 输出目录必须为空，以免覆盖旧证据或误认旧结果。
2. 从 `slots.json` 获取模型入口；GET 返回提示和工具 schema，POST `{name,args}` 调用实际工具。
3. 写作者与审核者分别接入；必须显式提交草稿/审核，再调用 finish。审核入口未就绪时返回 HTTP 202。
4. 大型提交写入 JSON 文件后使用 `curl --data-binary @file`，避免把生成代码嵌入复杂 shell 引号。
5. `--replay-writer` 或 `--replay-first-round` 会显式记录重放；后者允许一个修正轮次。重放不计作新的模型调用或完整时延测量。

评估只使用合成数据，不读取 CLI 隐式凭据，不发送私有 Skill。保存输入、工具调用、指纹、覆盖情况和最终结果；没有 provider 的真实输入/推理 token 总量时明确记录不可用。

本次原始执行日志、暂存补丁摘要和详细检查清单保存在本地 `.local-docs/pre-submission/`；它们不属于运行时代码，也不随包分发。
