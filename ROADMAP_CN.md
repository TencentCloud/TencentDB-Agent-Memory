# 路线图

本文档说明**我们接下来要做什么**。已经发布的内容请看 [CHANGELOG.md](./CHANGELOG.md)。

当前版本：**v2.0.0**

路线图列出的是团队正在推进的工作，不是承诺，范围与时间可能调整。如果这里的某一项对你很重要，
或者你更在意的东西不在这里，欢迎在 [Discussions](https://github.com/TencentCloud/TencentDB-Agent-Memory/discussions)
告诉我们。

---

## 下个版本 · v2.0.1

### 冷启动开箱即用：默认 Agent + 预置 Skill

**所属模块：Memory Hub**

现在上手的流程是：部署 → 建团队 → 建 Agent → 绑资产 → 复制接入地址 → 才能说第一句话。
在产生第一次有效对话之前，步骤太多。

v2.0.1 中，Memory Hub 会在初始化时准备好一个**默认 Agent**：

- 团队或用户创建即自带默认 Agent，无需手工配置
- 默认 Agent 自带**预置 Skill**，在你还没积累任何自有 Skill 之前就能干活
- 默认预挂基础记忆资产，首轮对话就能写入并召回 Chat Memory
- 面板直接给出可粘贴的客户端接入地址，并支持指向 Memory Proxy
- 单机部署下接入地址解析为宿主机 LAN 地址，而不是容器内主机名，外部客户端能真正连上

**目标**：跑完 `start-all.sh` 之后，复制一行就能开始。

### Wiki 生成加速

**所属模块：Memory Knowledge**

导入较大的文档集时，等待是最明显的体感问题：页面从 `processing` 到 `ready` 是一页一页串行完成的。

v2.0.1 把 Wiki 生成改造为受控并发的流水线：

- 页面生成并发执行，不再严格串行
- 构建队列设置并发上限与限流，避免单次大批量导入耗尽上游 LLM 配额
- 单页失败不再拖停整批，失败页独立重试并保留错误原因
- 构建进度与单页状态可见，长任务不再是黑盒

文档规模越大，收益越明显。这一点在冷启动首次导入既有知识库时最为关键。

### 用户级 / 团队级自定义 Prompt

**所属模块：Memory Core** —— 通过 Memory Core 接口配置。Memory Hub 面板上的自定义 Prompt
编辑能力**尚未支持**。

记忆抽取质量与业务语境强相关：做基础设施的团队关心变更影响面，做产品的团队关心用户诉求。
一套写死的 prompt 无法同时满足两者。

- 支持在 **user** 与 **team** 维度覆盖记忆抽取与召回 prompt
- 未配置时回落到内置默认值，完全向后兼容
- 生成的记忆携带 **provenance**：用了哪套 prompt、哪个模型、什么时间产出

有了 provenance，「记忆质量变差了」就成为一个可追溯的问题，而不是靠猜。

### Skill 导出

**所属模块：Memory Hub**

Skill 不是一段 prompt —— 它带版本、资源文件、触发边界、执行步骤和校验规则。目前这些只能留在 Hub 内。

- 新增 `/v3/skill/export` 接口，将 Skill 及其资源文件打包为可下载的 zip
- 放宽导出超时，适配包含大体积资源的 Skill
- 导出内容与运行时实际注入的内容保持一致，包含列表注入的 header/footer

适用于备份、跨环境迁移，以及在社区之间交换可复用的工作流。

### 记忆时间过滤

**所属模块：Memory Hub**

面板上的记忆列表目前只能整体翻页，记忆一多就很难定位到某段时间的内容。

- 面板支持按时间范围过滤记忆列表
- 与本版的时间戳修正配套：导入的历史会话保留原始记录时间，过滤结果才符合预期

### Codex 支持（IDE Plan 模式）

**所属模块：Memory Proxy**

Memory Proxy 新增 Codex 适配，复用与其他框架相同的记忆注入与回写链路。

- **v2.0.1 支持范围：仅 Codex IDE 的 Plan 模式**
- 在规划阶段，Codex 可读取 Chat Memory、Skill、Wiki 与 CodeGraph，让方案基于团队既有上下文，
  而不是从零推断
- Codex CLI 与非 Plan 执行模式**暂不支持**，我们会根据实际需求排优先级

v2.0.1 后的框架支持范围：
OpenClaw · Hermes · Claude Code · CodeBuddy · Codex（IDE Plan） · SDK

### v2.0.1 同期还会包含

**Memory Core —— 正确性**
- 导入会话保留原始时间戳（含 JSONL 镜像）—— 导入历史对话后时间线不再被压平到导入时刻

**Memory Proxy —— 正确性**
- 修复多 Agent 场景下 `conversation/search` 读取字段错误导致检索恒为空
- 修复 session refresh 未清理 hook 缓存，导致资产解绑不生效

**Memory Hub —— 生态**
- Opik → Skill 导入器，可从外部 trace 平台蒸馏 Skill

**Memory Hub —— 面板**
- 加载骨架屏、过渡动效、无障碍改进，各资产详情页头部统一

---

## `mem:` 会话指令

**所属模块：Memory Proxy** —— 已随 v2.0.0 发布，正在收集下一批要做哪些指令。

在对话里直接输入 `mem:` 开头的指令，Proxy 会拦截并就地处理，不用离开当前会话去开面板：

| 指令 | 说明 |
| --- | --- |
| `mem:sync` | 刷新本次会话的全部资产注入（Skill / 记忆 / Knowledge / Task & Agent 描述） |
| `mem:create-skill [提示词]` | 把本次对话归档为 Skill，后台异步提取 |
| `mem:help` | 显示指令帮助 |

格式为 `mem:<command>`，冒号后不加空格，命令名大小写不敏感。

**我们想听听你的想法。** 指令是最轻量的入口 —— 不用切界面、不用记API，一行就能触发。
但接下来做哪些指令，取决于你在实际使用中反复需要什么：

- 你希望在对话里直接完成哪些操作？（例如查看当前注入了什么、临时禁用某个资产、把某段对话存成记忆）
- 现有的三个指令，哪里不好用？参数设计是否别扭？
- 有没有你已经在用工作流绕过的场景，其实一个指令就能解决？

欢迎在 [Issues](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues) 提出你想要的指令，
描述清楚**使用场景**比给出接口设计更有帮助。

---

## 一起决定路线图

Agent 记忆还没有形成公认标准。优先做什么，很大程度取决于大家实际遇到了什么问题。

- 🐞 Bug 与问题 → [Issues](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues)（24 小时内响应）
- 🛠️ 贡献代码 → 请先阅读 [CONTRIBUTING_CN.md](./CONTRIBUTING_CN.md)

特别欢迎的贡献方向：**新框架适配器**、**Memory Hub 的新用法**等内容。

[English](./ROADMAP.md)
