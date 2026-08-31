# TencentDB Agent Memory：四项优化评估、实施路线与简历方案

> 更新：2026-08-31｜目标岗位：Agent 应用算法 / Agent 开发  
> 代码核对基线：`084418e`，以当前工作区实现为准。  
> 范围：评估和实施建议，尚未执行模型评测或实现下述优化；所有收益数字均待实测。  
> 时间假设：一人、熟悉 TypeScript、已有可用模型/Embedding 和测试环境；推荐约 4 周。环境未打通时另留准备时间。

## 1. 结论：保留四条，重点修改第三、第四条的定义

你的四个方向合理，能够形成“测得准 → 找得准 → 调得对 → 复用有效经验”的完整主线，无需替换为 GraphRAG、强化学习训练等更大的项目。

| 原方向 | 判断与建议名称 | 必须收窄的范围 | 简历价值 |
|---|---|---|---|
| Memory Eval | 保留：**长期记忆与 Agent 行为分层评测** | 共享日志与运行配置，但三套测试分别计分，不建设通用评测平台 | 实验设计、可复现、误差分析 |
| 时间感知轻量重排 | 保留：**时间意图驱动的记忆检索重排** | 仅做可解释时间特征，不训练模型；时间扩展检索作为漏召回时的备选 | 检索算法、时间推理、消融 |
| Proxy 提示词注入 | 重点保留：**缓存友好的工具描述与调用决策优化** | 只测工具描述能否促成正确调用；固定资产内容，不把答案质量收益混进来 | Agent 工具使用、上下文工程 |
| Skill 机制 | 保留但收敛：**可验证轨迹驱动的选择性 Skill 提取与复用** | 优先做提取门控、精简 SOP、有限目录加载；不重建完整生命周期 | 经验复用、任务成功率、成本权衡 |

**推荐最终简历为 4 条。** 只有完成独立的缓存 metadata 保留改造、回归测试与真实缓存回放后，才把“Prompt Cache 兼容性”拆为第 5 条。不要为了凑条数拆两个高度重叠的 Prompt 优化点。

相比上一版方案：

- “Token-aware Context Packing”不再单列；将**工具描述预算**并入第 3 条，将 **Skill 目录/正文预算**并入第 4 条。
- “主动检索”属于现有机制和第 3 条的评测对象，不再当作从零新增能力。
- Skill 从第四周可选项升级为主线，但仅实现一个小闭环。
- 不预设“20 turn → 8 turn”一定实现；它只是动机示例，不能直接用作目标成果。

## 2. 代码核对：先修正几处会导致实验失真的认识

用户给出的相对路径前缀在当前工作区应直接对应 `MemoryProxy/`、`MemoryCore/`，不是额外嵌套一层 `tdai-memory-openclaw-plugin/`。

| 项目 | 当前实现证据 | 对方案的影响 |
|---|---|---|
| 主动记忆检索链路 | [v2-router.ts](D:/TencentDB-Agent-Memory/MemoryCore/src/gateway/v2-router.ts:1192) 调用 [memory-search.ts](D:/TencentDB-Agent-Memory/MemoryCore/src/core/tools/memory-search.ts:87) | 重排优先接这里；只改 `auto-recall.ts` 可能覆盖不到实际 Proxy 工具调用 |
| 重排覆盖两种后端 | [memory-search.ts](D:/TencentDB-Agent-Memory/MemoryCore/src/core/tools/memory-search.ts:142) 有 TCVDB native-hybrid 提前返回及 SQLite 双路 RRF | 公共重排需要放在两条路径各自截断前，不能只改客户端 RRF |
| 记忆指南重复且有冲突 | [tdai-tools-injector.ts](D:/TencentDB-Agent-Memory/MemoryProxy/src/injection/injectors/tdai-tools-injector.ts:56) 与 [tdai-profile-memory-injector.ts](D:/TencentDB-Agent-Memory/MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts:164) | 一处强调历史/偏好“必须先查”，另一处允许 L3/当前上下文已有答案时不查；应统一优先级 |
| 注入位置不只由 point 决定 | [pipeline.ts](D:/TencentDB-Agent-Memory/MemoryProxy/src/injection/pipeline.ts:339) 优先使用 AgentProfile 的语义 Anchor | 调整 `system.before_tools`/`system.suffix` 不一定改变真实落点，实验需保存序列化后的 prompt |
| Anchor 缓存风险 | 同文件中 `sysMsg.blocks` 被替换为单一 text block；[Anthropic adapter](D:/TencentDB-Agent-Memory/MemoryProxy/src/injection/adapters/anthropic.ts:111) 本身支持 metadata 中的 `cache_control` | Anchor 重建路径未携带原 block metadata，有丢失断点的风险；这是静态证据，不等同于已测得缓存损失 |
| 知识工具已渐进暴露 | [knowledge-tools-injector.ts](D:/TencentDB-Agent-Memory/MemoryProxy/src/injection/injectors/knowledge-tools-injector.ts:139) 已有资源目录 → `tools/list` → `tools/call` | 可以精简触发说明，不能声称新建了两阶段发现协议 |
| Skill 目录不是每轮按 query 重排 | [skill-injector.ts](D:/TencentDB-Agent-Memory/MemoryProxy/src/injection/injectors/skill-injector.ts:170) 为 `session_init`；预热取 Agent/Task 描述，cache miss 的 execute 无 query | 目录优化以会话快照为边界；不要每轮变更 system 目录破坏稳定性 |
| topK 与实际字符预算 | [skill-handlers.ts](D:/TencentDB-Agent-Memory/MemoryCore/src/gateway/skill-handlers.ts:671) 使用 `searchTopK`，`char_budget` 默认 8000 | `charBudgetPercent=0.01` 虽有配置，但所查 listing 路径未消费它；不能只改配置就宣称预算优化 |
| Skill 检索模式依赖后端 | [SQLite SkillStore](D:/TencentDB-Agent-Memory/MemoryCore/src/core/skill/skill-store.ts:555) 实际仍走 BM25；[TCVDB SkillStore](D:/TencentDB-Agent-Memory/MemoryCore/src/core/store/tcvdb-skill-store.ts:379) 有 dense/hybrid，BM25 模式也可能转 hybrid | 实验记录实际执行模式，不能把三种配置名称当成三种真实算法 |
| fast path 并非主路由入口 | [skill-fast-path.ts](D:/TencentDB-Agent-Memory/MemoryCore/src/core/skill/skill-fast-path.ts:1) 明确标注暂不接入 | 路由改造应落在 handler/store，不以该文件作为已启用链路 |
| Transcript 参数需看 resolved config | [skill-extractor.ts](D:/TencentDB-Agent-Memory/MemoryCore/src/core/skill/skill-extractor.ts:113) 的 8000/32000 是回退值；[skill-config.ts](D:/TencentDB-Agent-Memory/MemoryCore/src/core/skill/skill-config.ts:241) 由 `archiveBytes` 派生 head/tail，默认均为 40960 | 初始化会传 resolved 值；且 bytes 与 chars 不是同一单位，必须记录实际配置与输入 Token |
| 抽取 prompt 偏宽松收录 | [skill-review-prompt.ts](D:/TencentDB-Agent-Memory/MemoryCore/src/core/skill/prompts/skill-review-prompt.ts:40) 同时收 SOP、背景、偏好，倾向先保存后迭代 | coding 实验可增加“仅抽取已验证可复用 SOP”的可配置策略，不应直接全局删除其他 Skill 类型 |

补充：`toolCallThreshold=10` 和默认 `archiveBytes=40×1024` 的归档触发确有代码依据，但**归档触发不等于任务成功，也不等于应该生成 Skill**；`maxIterations=16` 是上限，不是每次一定执行 16 轮。

## 3. 调研判断：值得借鉴什么，不照搬什么

### 3.1 直接相关的论文与报告

| 来源 | 核实后的启发 | 本项目的落地选择 |
|---|---|---|
| [LongMemEval，ICLR 2025](https://arxiv.org/abs/2410.10813) | 分别评估抽取、多会话、时间推理、更新和拒答；研究 time-aware query expansion | 时间重排必须和候选召回覆盖率一起看，不能仅对最新记录加分 |
| [BFCL V2，Berkeley 官方报告](https://gorilla.cs.berkeley.edu/blogs/12_bfcl_v2_live.html) | 区分相关/不相关工具调用场景 | 为本项目构建“应调/不应调/选错工具”的标注；借鉴分类，不把 curl 工具结果冒充 BFCL 分数 |
| [Anthropic：Writing effective tools，2025-09](https://www.anthropic.com/engineering/writing-tools-for-agents) | 用评测迭代工具描述，明确能力边界与参数语义 | 精简重复内容，同时保留消歧信息，不把“字越少”当成唯一目标 |
| [Anthropic：Advanced tool use，2025-11](https://www.anthropic.com/engineering/advanced-tool-use) | 工具按需发现、保留常用入口、针对歧义保留示例 | 本项目工具数量较少，先做静态精简；目录发现只在有实测收益时扩展 |
| [Anthropic：Agent Skills，2025-10](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) | 先加载名称/描述，相关时读取正文与资源 | 复用已有 `available_skills → skill_view → files_read`，优化质量和预算，不另造框架 |
| [ExpeL，AAAI 2024](https://arxiv.org/abs/2308.10144) | 从先前任务抽取经验，在后续任务中复用，无需参数更新 | 以“种子任务 → 冻结 Skill → 新任务”做受控实验 |
| [SkillsBench v4，2026-06，预印本](https://arxiv.org/abs/2602.12670v4) | 配对评测与确定性验证；精简、聚焦的 Skill 更值得验证 | 加人工精简规则基线，避免只比较两个自动提取配置 |
| [SWE-Skills-Bench，2026-03，预印本](https://arxiv.org/abs/2603.15401) | 报告大量 Skill 无通过率增益，部分成本上升或版本不兼容 | Skill 收益不是先验事实，必须验证任务匹配、版本和总成本 |

论文结论来自各自数据集，不能将其收益数字移植到本项目。2026 年两项 Skill 研究在此按预印本引用，不宣称它们已经获得顶会录用。

### 3.2 同类产品比较：用于设计基线，不是“谁最好”的排名

| 官方方案 | 实际侧重点 | 本项目可借鉴的小改动 |
|---|---|---|
| [Cursor Rules](https://prod.cursor.com/docs/rules) | 常驻、路径匹配、按描述选择、手动应用 | Skill 带上任务/仓库适用范围，不仅看关键词 |
| [CLAUDE.md / auto memory](https://code.claude.com/docs/en/memory) | 人工项目说明与自动经验笔记分工 | 把稳定项目约定与临时任务状态区分；保留人工规则对照组 |
| [Windsurf/Cascade Memories](https://docs.windsurf.com/windsurf/cascade/memories) | 自动记忆与用户规则分离，按工作区使用 | Skill 限定 repo/task scope；该旧域名当前重定向到 Devin Desktop 文档 |
| [Cline Memory Bank](https://docs.cline.bot/best-practices/memory-bank) | 结构化项目文档方法，而非自动 Skill 蒸馏算法 | 将项目事实与可执行 SOP 分开，减少重复存储 |
| [Aider Conventions](https://aider.chat/docs/usage/conventions.html) | 简短约定文件以只读上下文加载 | 用一份小型人工规范作为低成本强基线 |
| [Continue Rules](https://docs.continue.dev/customize/rules) | 可版本化的项目规则 | 将实验配置、Skill 版本与任务版本一同保存 |
| [OpenHands Skills](https://docs.openhands.dev/overview/skills) | 常驻项目上下文与按需 Skill，支持触发条件 | 对“目录曝光、正文加载、后续动作”分层记录 |

**综合判断（本项目设计推论）：** 与其调一大组阈值，不如先回答“什么经验值得保存、何时应该加载、加载后有没有减少无效动作”。无需把所有产品都接入运行；首版只选一个 Agent harness。

## 4. 方向一：Memory Eval 与共享实验底座

**范围：3–4 个开发日；其他两类评测的数据在后续周补齐。**

### 4.1 三套测试各司其职

| 测试套件 | 隔离的变量 | 主指标 |
|---|---|---|
| Memory Retrieval Eval | 固定记忆快照，只改检索/重排 | Recall@5、MRR@5、时间子集指标 |
| Tool Decision Eval | 固定资产和工具返回，只改描述/注入布局 | 有效调用、误调用、选择正确率、注入 Token |
| Skill Coding Eval | 固定模型/工具描述/任务环境，只改 Skill 策略 | pass@1、全成本 Token、turn、复用 |

三者只共享 `run_id/config_hash/model/repo_commit/prompt_version/trace` 与报告模板。不要用一个综合分数把互相不同的问题混起来。

### 4.2 Memory 数据选择

优先选 LongMemEval 小子集并补标证据；若环境成本太高，自建中文开发会话集也可以，但必须写成“自建/改编评测”，不是官方 benchmark 成绩。

建议约 120–160 条，至少包括：

- 稳定事实与偏好；
- “上次/最近/某时间段”的时间查询；
- 新旧方案、偏好变更；
- 无证据应拒答的小型辅助子集。

按会话组或问题模板家族划分开发集/测试集，例如 40 条开发、100 条测试；近重复样本不能跨 split。原始会话、问题、参考答案、证据 session/message ID、查询时点均保留。

**证据映射是必要工作：** 公开集的证据 session ID 不等于生成的 L1 record ID。建立 `record_id → source_message_ids/session_ids` 映射，固定一次记忆写入/抽取快照，再比较检索策略。分别报告“证据根本没写入”和“写入但未召回”，不能让重排为写入失败背锅。

### 4.3 指标与验收

- `Recall@5 = Top5 中正确证据单元数 / 全部正确证据单元数`，对有证据样本宏平均；
- `Hit@5` 仅表示是否至少命中一项，不与 Recall 混用；
- `MRR@5` 为第一条正确证据的倒数排名，超过 5 或未命中记 0；
- 无证据样本不算 Recall 分母，另测拒答或错误支持率；
- 先跑 BM25 / Dense / Hybrid，记录真实后端，不能用降级实现冒充独立基线；
- 端到端回答可抽 20–30 条辅助检查，固定模型、上下文预算和 Judge，并人工复核。

验收：固定样本清单 + 配置 + 逐样本结果 + 一条复现命令 + 错误分类报告。暂不建设服务化评测平台。

## 5. 方向二：时间意图驱动的轻量重排

**范围：3–4 个开发日。不是“给最近的记忆统一加权”。**

### 5.1 首版设计

1. 识别 `none / recent / earliest / explicit_range`，固定 query 的参考时间和时区；
2. 从 Hybrid 候选中取约 15–30 条，优先复用当前 over-retrieve；
3. 统一打分尺度，叠加时间匹配；优先级只做小权重、可关闭的辅助信号；
4. 无明确时间意图时保持基线排序；时间缺失或解析不确定时回退；
5. 在验证集选择少量权重，测试集不调参。

```text
score = calibrated_relevance
      + temporal_gate(query) × λt × temporal_match(query, record)
      + λp × normalized_priority(record)
```

RRF 分数通常远小于 0–1 时间特征，不能直接无尺度相加。单路降级和 native-hybrid 的分数含义也不同，需在实验中选定归一化或秩变换方法并记录。

**时间字段不能想当然：** 当前 `created_at/updated_at` 映射了底层时间字段，记录另可能包含事件时间和合并历史。必须区分事件发生时间、提及时间、写入/修改时间。问“去年做的事”不能只比较数据库更新时间；缺少可靠事件时间的样本单独标注或回退。

### 5.2 消融与备选方案

- R0：当前 Hybrid；
- R1：所有 query 都偏好最新（仅作为反例对照）；
- R2：时间意图门控重排；
- R3：R2 + Priority，只有开发集有效才进入最终测试。

若正确记忆根本不在候选 Top30，重排不可能救回。此时优先借鉴 LongMemEval 的 **time-aware query expansion**：保留原查询候选，再增加时间约束候选并合并；解析不确定时不使用硬过滤。此项替换无效的重排尝试，不要求两套方案都完成。[论文依据](https://arxiv.org/abs/2410.10813)

### 5.3 实现与验收

主改 [memory-search.ts](D:/TencentDB-Agent-Memory/MemoryCore/src/core/tools/memory-search.ts)，新增小型 `query-time-features` 和 `temporal-reranker` 模块；两类后端均在 TopK 截断前处理，保持租户/Agent 过滤，不扩大数据可见范围。

验收：时间类 Recall/MRR、普通查询退化、候选召回上限、额外 P95 延迟和 2–3 个失败案例。小样本报告置信区间或配对 bootstrap；未证明提升就写策略边界，不写“显著提升”。

## 6. 方向三：缓存友好的工具描述与调用决策优化

**范围：4–5 个开发日；这是最值得优先打磨的 Agent 开发亮点。**

### 6.1 清晰边界

只评价：“在给定 query、已有上下文、资源权限和工具目录下，模型是否在需要时调用正确的资产工具”。

- **不评价**记忆内容是否准确、Skill 能否提高 coding 成功率、知识图谱质量。
- “纯 coding”不等于“不调用任何工具”。Read、Shell、测试等本地工具正常调用，不算误调用。
- “纯 coding”也不一定不需要资产工具：涉及既有项目 SOP 或匹配仓库的跨文件关系查询时，Skill/知识可能合理。
- 正负标签必须依赖 **query + 当前上下文 + 已绑定资源 + 权限**。例如 L3 已给出姓名时，“我叫什么”不应机械标成必须检索。

### 6.2 最小优化方案

**第一步：去重与消歧。** 保留一个权威的调用决策说明，其他块只保留工具能力与参数。优先级建议：

```text
当前上下文已充分回答 → 不重复查
否则，需要历史事实 → memory / conversation
需要可复用流程 → skill_search 或已有目录中的 skill_view
需要相关团队设计/仓库结构 → 对应 knowledge 资源
无合适资源、无权限或任务自足 → 不调用资产工具
```

这是需要通过评测检验的拟议策略，不是已证明最优的规则。区分“查询原文”和“查摘要事实”，保留 Skill 正文/资源读取依赖、知识资源匹配与只读/写入边界。

**第二步：短描述保留辨别信息。** 每个工具保留“用途、何时调用、必要输入、重要限制”；合并公共 curl/headers/错误处理。删除重复示例，但对易混淆工具保留一个关键示例，不能省略必需鉴权、参数或 manifest 前置步骤。

**第三步：静态目录优先。** 首版不增加新的 LLM 路由器；也不按每轮 query 裁剪 system 工具列表。已有 knowledge 两阶段发现和 Skill 正文按需读取继续复用。新建跨三类工具的统一发现服务只作为后续研究。

改文案主要涉及 render 函数和 `MEMORY_TOOLS_GUIDE` 常量；改顺序/缓存还涉及 pipeline、AgentProfile 和 adapter，不能只改 render。

### 6.3 建议的调用评测集

约 150 条，参考分布如下，开发/测试按模板家族分离：

| 类别 | 建议量 | 示例 |
|---|---:|---|
| 应查记忆 | 30 | “上周部署失败的原因是什么”，当前上下文没有答案 |
| 应用 Skill | 30 | 已有匹配流程、需要读取正文，或需要检索团队 Skill |
| 应查知识 | 30 | 绑定仓库的依赖关系、相关 wiki 的设计背景 |
| 不应调资产工具 | 45 | 自足的局部编辑、通用代码题、上下文已有答案、资源不匹配 |
| 边界/组合 | 15 | query 含“记忆”但仅在解释缓存代码；多个允许的工具路径 |

组合题允许多个合法调用序列；先在单一决策样本上计算四个主指标，再单独报告组合流程完成度。避免把一个固定 gold 工具名当成所有合理路径的唯一答案。

### 6.4 指标精确定义

令 P 为明确应调用资产工具的正例，N 为不应调用资产工具的负例。

| 指标 | 建议定义 |
|---|---|
| 有效调用率（触发 Recall） | P 中在规定观察窗口发起至少一次资产工具调用的比例；选错也算“触发”，另由下一项识别 |
| 误调用率（FPR） | N 中发起任意资产工具调用的比例；本地正常 coding 工具不计入 |
| 工具选择正确率 | P 中已触发样本里，首次资产调用属于 gold 允许集合的比例；注明是 conditional accuracy |
| 端到端正确调用率 | P 中完成合法工具/必要参数及前置发现步骤的比例；作为守护指标，防止“会说工具名但不能执行” |
| 注入 Token | 工具描述与 guide 的 Token；固定的画像/资产目录单独列出，不混成全 prompt 节省量 |
| 缓存与额外开销 | 稳定前缀长度、真实 cache-read、描述发现附加 Token/调用次数与延迟 |

没有发起调用的正例不能从有效调用率分母消失；选择正确率必须和触发率一起看。对于负例，多次错误调用还应附每 query 错误调用次数。

### 6.5 怎样测到“实际调用”

这些资产能力主要由 **Bash + curl** 执行，不是独立的原生 function-call schema：

- 解析宿主 Shell 工具调用，提取命令目标、URL、业务参数；
- 对接本地 stub bridge 或复用桥接遥测，确认请求确实到达；
- 仅在自然语言中声称“将查询记忆”不算调用；
- 正例观察窗口建议统一为最多 4 个模型 action step，足够覆盖发现 → 执行；负例同时做小型完整 coding 回放，捕获后半程误调；
- 后端返回固定 fixture，不查询真实资产质量；写入/删除接口只记录意图或在测试命名空间模拟，不产生真实外部副作用。

### 6.6 消融与跨模型

| 版本 | 唯一主要变化 |
|---|---|
| P0 | 当前原样注入 |
| P1 | 只删除重复说明，保留结构与位置 |
| P2 | P1 + 明确正负触发条件、工具边界与精简描述 |
| P3（可选） | P2 + 一种缓存兼容的布局调整，或一种渐进加载方案；二者不同时变 |

先在一个主模型/固定 harness 上迭代；最终只用 P0/P2 在另一个模型上验证。固定模型版本、采样参数、客户端提示词和资源快照；模型与 harness 同时换掉不能归因于模型差异。

选择“在有效调用率不明显退化、FPR 不升高下 Token 更少”的 Pareto 方案。可以在开发前设定可接受退化界限，但小样本不能宣称统计意义上的非劣；精简率也不预先伪造。

## 7. Prompt Cache：第三条的硬约束，可成为第五条成果

### 7.1 “不破坏 cache”需要怎样理解

修改旧描述必然改变该位置及后续前缀，**不能保证新版首请求复用旧版缓存**。合理目标是：发布后一次预热，同一会话/版本后续轮次保持可复用前缀，不每轮重写已缓存段。

以 Anthropic 协议为例，缓存逻辑顺序是 `tools → system → messages`，不是 HTTP JSON 字段打印顺序；命中取决于断点之前的内容一致性及服务商规则。[官方 Prompt Caching 文档](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

项目 HookCache 是“复用注入块”的应用缓存，不是模型 KV Cache。二者指标不能互相替代。

### 7.2 本项目的最小方案

- 工具描述按版本固定；会话级绑定目录生成后复用，不依当前 query 改写；
- 固定列表顺序、序列化和资源版本；会话 ID/租户字段虽在会话内稳定，但不能因此声称跨会话共享同一前缀；
- 新检索结果通过正常工具返回/新增消息进入，不改写历史 system 或既有消息；
- 显式刷新资产时记录版本边界，接受对应位置以后的重建；不伪称更新完全零成本；
- 对 Anchor 命中、fallback、多 text block 的路径分别测试，保留或有定义地重新映射 metadata 与断点；不要将原断点未经分析全部复制到一个新 block。

### 7.3 必要回归与真实回放

1. 相同会话与版本、不同用户 query：system 静态前缀完全一致；
2. 相同内容重复渲染：顺序、文本、block metadata 一致；
3. 带原有 `cache_control` 的多 block 请求经过 parse → inject → serialize 后，断点语义未丢；
4. 预热 cache miss、自愈、显式刷新场景各留 snapshot，不能只测热缓存；
5. 在支持缓存的真实上游上回放多轮请求，记录冷启动及后续 cache-read/write、TTFT；
6. 更换模型、TTL 到期、内容低于最小缓存长度时分别标注，不能全部归咎于注入。

文本/hash 相同只是本地不变性证据。只有拿到服务商真实 usage 才能写“缓存命中率”；若网关不提供字段，应如实写“完成缓存兼容回归，未验证线上命中收益”。

## 8. 方向四：选择性 Skill 提取、按需复用与成本回收

**范围：5–6 个开发日 + 可并行于文档整理的批量运行时间。只做一个提取策略和一种目录预算优化。**

### 8.1 核心假设与不做项

假设：同类 coding 任务中，少量经过验证的流程经验能减少重复探索；但大量泛化笔记、错误步骤或版本不匹配 Skill 可能造成干扰。当前 prompt 收录范围较广，因此选择性门控值得试验，收益仍待实测。

不做 RL、自动生成执行脚本平台、Skill 图谱、多 Agent 蒸馏、全生命周期灰度回滚。也不把每个低层阈值都做网格搜索。

### 8.2 最小提取策略：先验证，再抽取，再去重

保持当前归档触发，**把“归档”与“是否调用 LLM 提取”分离**。不要因修改提取策略丢掉用于其他记忆功能的原始会话。

在 worker 提取前增加可配置 gate：

- 任务有可重复的流程特征，而非纯常识问答或一次性日志；
- 有外部验证信号，例如目标测试通过、修复后的失败用例转为通过；
- 与已有 SOP 不重复；相同主题且有新增已验证步骤时更新已有版本；
- 无验证信息则暂不进入高可信 SOP 集；失败轨迹可保留作诊断数据，不能将未证实猜测写成推荐步骤。

失败探索本身并非无价值：最终跑通的轨迹中，可保存“失败尝试 → 排除依据 → 有效步骤”，帮助后续跳过弯路。

抽取输出首版固定为短 SOP：

```text
适用任务 / 不适用情况
仓库、依赖版本及前置条件
3–6 个关键步骤
已验证的坑与排除理由
验证命令 / 成功判据
来源任务与 Skill 版本
```

推荐开发起始预算约 300–600 Token/正文，超出时删重复背景而非删关键验证。它是待调参数，不是最佳配置。保留现有 transcript 角色隔离、敏感信息过滤和版本写入约束，不为省 Token 移除这些保护。

### 8.3 Transcript 与 iterations：只选最有价值的一处

优先尝试“结构化轨迹切片”：保留任务目标、关键错误、最终修复、验证输出；删除重复大文件读取和重复成功日志，保持 tool-call/result 配对。

`maxIterations` 先记录**实际轮数与实际 Token**，再在开发任务上比较 16 与 4/8 中一个较低上限；若发生未完成写入、版本冲突处理不完或质量下降则回退。不能用上限下降推断成本等比例下降。

暂不同时扫 `archiveBytes`：它派生多个截断/压缩字段，改变它会引入多重变量。触发率、抽取质量、路由效果必须能独立解释。

### 8.4 注入端：复用现有渐进加载，先修预算再谈新检索器

- 会话开始只注入候选 Skill 名称与触发描述，正文仍通过 `skill_view` 读取；
- 比较候选数 5 与当前 20，或比较目录 Token 预算两个档位，先只选一个轴；
- 按完整条目装配，避免直接字符截断半个 Skill 描述；记录候选数、实际曝光数与 Token；
- 目录会话内冻结；需要目录外 Skill 时使用既有 `skill_search`，不逐轮改 system；
- 将 Skill 的 repo/framework/version scope 纳入简单筛选，不能仅凭相似度跨项目套流程。

先用现有后端的真实检索能力。只有在人工标注的小型路由集上确认 BM25 漏召回严重，再考虑 embedding/hybrid；SQLite 中尚未完成的 hybrid 不能靠改配置充当成果。**首版推荐不新增向量 Skill 检索。**

### 8.5 指标：总成本和因果收益，比生成数量更重要

| 指标 | 统计口径 |
|---|---|
| pass@1 / 单次任务通过率 | 每题一次独立 rollout，以确定性测试判定；rollout 内允许正常读代码、测试和修复，不做多次生成后择优 |
| 平均总 Token | 包含输入、输出、提取、压缩、路由/评审等模型调用；失败和超时的已消耗 Token 也计入 |
| 平均 turn | 一次模型 action step 计一轮，不把一次并行发起的多个工具任意当多轮；用户轮、工具次数另计 |
| 提取触发率 | 实际调用抽取 LLM 的归档单元 / 全部候选归档单元 |
| 有效产出率 | 产生有效新增或更新 Skill 的抽取运行 / 全部抽取运行；再附每任务净新增 Skill 数 |
| Skill 读取率 | 曝光过 Skill 目录的任务中实际读取正文的比例，区分只曝光与读取 |
| Skill 后续复用率 | 在后续独立任务中被读取过的已生成 Skill 数 / 同等后续观察机会的已生成 Skill 数 |
| 真正效用 | 配对任务的通过率、Token、无效动作差值；“被读取”不是“被有效采用” |

新生成但尚无后续任务的 Skill 不能直接算成未命中。是否采用关键步骤可用可执行命令/操作轨迹核对并抽样人工审阅，不能凭模型自称“用了 Skill”判定。

### 8.6 包含蒸馏成本的核算

```text
C_total =
  C_seed_tasks
  + C_extraction_and_filtering
  + C_evaluation_tasks_with_skill
  + C_other_model_overheads

C_amortized = C_total / 全部纳入统计的任务数
BreakEvenTasks ≈ 一次构建成本 / 后续每任务平均节省
```

全量总成本按同一任务序列比较；另报告冻结 Skill 后测试阶段成本以及构建成本，避免重复记账。只有每任务节省为正且成功率没有被代价性牺牲时，才讨论回收点。

各供应商 usage 口径不同：有的 input 已含缓存 Token，有的分开。先统一为逻辑输入/输出与缓存读写分类，不重复相加；Token 与账单金额分开。除全任务平均外，补充“两种方案都成功”的共同子集对比，防止提前失败看起来更省轮数。

## 9. Skill Coding Eval：冻结实验为主，累积实验为辅

### 9.1 选择什么任务

| 数据选择 | 适用性 | 建议 |
|---|---|---|
| 同一/两个小型仓库的 issue-like 任务 | 可控制版本、任务族和验证器，环境成本低 | **首选**：2–3 类任务，例如校验规则、接口边界、特定测试框架修复 |
| [SWE-bench 小子集](https://github.com/SWE-bench/SWE-bench) | 真实仓库修复，但镜像、依赖和评测资源成本更高 | 已有 Docker/WSL/Linux 环境再选少量；固定 base commit，按[官方 harness](https://www.swebench.com/SWE-bench/guides/evaluation/)执行 |
| [HumanEval](https://github.com/openai/human-eval) / [MBPP](https://github.com/google-research/google-research/tree/master/mbpp) | 函数级问题，运行相对轻量 | 仅作冒烟/补充；不适合作为减少仓库探索路径的主要证据 |

不能只换变量名来制造“同类任务”。种子和测试应属于相同方法族但具有不同问题实例；过滤近重复修复、gold patch 与答案泄漏。

### 9.2 主实验：四组受控配对

先准备约 8–12 个种子任务轨迹、6–8 个开发任务、20 个测试任务。数字是规模建议，可按预算调整。

| 组别 | Skill 条件 | 用途 |
|---|---|---|
| S0 | 无新增实验 Skill，关闭实验自动提取/检索 | 无 Skill 对照 |
| S1 | 从种子任务整理的 2–3 个精简人工 SOP | 检查自动方案是否优于简单人工规则 |
| S2 | 当前机制提取与目录注入 | 项目当前基线 |
| S3 | 选择性提取 + 精简 SOP + 小预算目录 | 本次方案 |

为了隔离 Skill 效果，其他记忆/知识资产关闭或对各组提供完全相同快照；模型、工具描述、Shell 权限、测试命令与资源预算一致。不得让 S2/S3 偷看其他组的测试轨迹。

先用同一批种子轨迹生成 S2/S3 的库并冻结，再跑测试：

- 每个测试任务从独立 repo snapshot、独立对话开始；
- 冻结实验中禁用库更新，防止先测的测试题进入后测任务的 Skill；
- 隐藏验收测试和 gold patch 不进入 Skill、Agent prompt 或可检索目录；
- 无人工接管后继续算成功；超时、环境失败、模型失败分别留状态，并说明统计规则；
- S1 的人工投入单独报告；不能把人工制作时间当作零成本。

主实验只说明“已有 Skill 如何帮助新任务”，不是在线累积效果。

### 9.3 辅助实验：观察累积效应

时间允许时，选 10–15 个按预定顺序排列的任务，测试“先执行任务 i、验证、提取，再给任务 i+1 使用”。冻结 Prompt 配置，每个任务开新会话并保留当时的 Skill 快照。

对照分支相互隔离，只共享相同任务序列；每个分支只能使用自己过去的轨迹。人工预先标注 2–3 个任务族，报告每个阶段的平均 Token、成功率、Skill 数和复用数。

如果顺序并非真实时间线，可增加第二种顺序检查敏感性；不要允许未来任务反哺过去任务。同仓库历史 issue 的 Skill 还可能依赖不同版本，必须检查 scope。

### 9.4 让实验量可负担

- 开发冒烟：6 题 × 4 组 = 24 条 coding 轨迹；
- 主测试：20 题 × 4 组 = 80 条；
- 对随机性敏感的最终两组，可在 8 题上补 2 次运行：32 条；
- 总计约 136 条，不含种子采集/提取和可选在线序列；只跑主测试一次则成本更低。

重复运行按固定 seed/配置报告均值与离散度，不能挑最好的 run 当 pass@1。先测 5 题估算成本，再决定上限；到预算上限停止扩展，不做“阈值 × 模型 × 数据集”的全排列。

## 10. 四周安排与降级路线

工期合计约 18–23 个开发日，完整做完更接近 4 周，而非保证两周。以下以环境已可用、一天约正常全职投入为前提。

| 时间 | 目标 | 验收物 |
|---|---|---|
| 第 1 周 | 环境冒烟、Memory 评测底座、工具正负例设计与 P0 基线 | 固定数据/配置、JSONL、三类 trace schema、基线报告 |
| 第 2 周 | 工具描述 P1/P2、缓存回归、时间意图重排 R2 | Prompt 对照表、序列化 snapshot、时间召回消融 |
| 第 3 周 | Skill gate、短 SOP、完整目录条目预算；完成种子/开发任务 | 冻结的 S1/S2/S3 Skill 库、运行配置、6 题冒烟 |
| 第 4 周 | 配对测试、跨模型工具验证、失败分析、PR 材料与简历 | 主实验结果、成本报告、复现说明、4 条简历 |

若只有 3 周：保留 4 个方向，但 Skill 只做冻结小样本试验，不做在线累积、多模型 coding 或新检索器。若只有 2 周：优先做评测 + 工具描述 + 时间重排，**简历只写已完成的 3 条，不硬凑 Skill 成果**。

建议拆成四个小 PR（本次仅规划，未创建 PR）：

1. `eval-memory-and-agent-traces`：评测与日志；
2. `proxy-tool-prompt`：描述精简、负例回归与缓存兼容测试；
3. `temporal-memory-rerank`：时间特征与重排；
4. `selective-skill-reuse`：提取门控、目录预算和效果报告。

## 11. 最终实验报告模板

### 11.1 Memory

| 配置 | 真实检索模式 | Recall@5 | MRR@5 | Temporal R@5 | Update R@5 | 候选 Recall@30 | P95 |
|---|---|---|---|---|---|---|---|
| Baseline | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 时间门控 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |

### 11.2 Tool Decision

| 版本/模型 | 有效调用率 | 误调用率 | 条件选择正确率 | 合法调用率 | 描述 Token | 实际 cache-read/TTFT |
|---|---|---|---|---|---|---|
| P0 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测/不可得 |
| P2 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测/不可得 |

记录失败类型：漏调、负例误调、L1/L0 混淆、错资源、参数错误、只提工具名未执行、重复查询、断点丢失。

### 11.3 Skill

| 配置 | 通过数/任务数 | 全任务平均 Token | 构建/提取 Token | 平均 turn | 净新增 Skill | 后续读取复用率 |
|---|---|---|---|---|---|---|
| S0 | 待测 | 待测 | 待测 | 待测 | 0 | 不适用 |
| S1 | 待测 | 待测 | 人工投入单列 | 待测 | 待测 | 待测 |
| S2 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| S3 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |

结论回答：“在本次任务分布和成本预算下，哪种提取/加载策略更好”，不是泛化断言“Skill 越少越好”或“越多越好”。报告样本数、通过数、配对差异、不确定性以及至少两个负收益案例。

## 12. 简历最终版本：推荐四条

**项目名：TencentDB Agent Memory——面向 Coding Agent 的长期记忆与经验复用优化**

**项目简介：** 在现有 MemoryCore/MemoryProxy 基础上，围绕记忆检索、工具调用和 Skill 复用建立可复现评测，并优化 Agent 的上下文成本与任务执行效率。

下列是**实施完成后的填写模板，不是当前既成成果**。只写自己实际负责的增量，不能将项目原有混合检索、Proxy 或 Skill 全部描述成从零自研。

1. **评测建设：** 构建 `[N]` 条长期记忆与 `[M]` 条工具调用样本，覆盖时间更新、应调/不应调和易混淆工具场景；统一配置与逐样本轨迹，形成召回、调用行为及 coding 任务的分层回归报告。
2. **时间检索：** 在现有混合召回上实现时间意图门控重排，区分近期、历史和显式时间窗，完善时间缺失回退；通过消融将时间类 Recall@5 从 `[A]` 提升至 `[B]`，普通查询变化 `[C]` 个百分点。
3. **工具描述：** 合并 Proxy 重复调用规则，精简工具描述并明确正负触发条件；将描述 Token 降低 `[X%]`，有效调用率 `[A→B]`、误调用率 `[C→D]`，补充多轮前缀和缓存断点回归。
4. **Skill 复用：** 基于测试验证与重复检测筛选可复用 SOP，优化 Skill 提取与目录预算；在 `[N]` 个同类 coding 任务配对实验中，pass@1 为 `[A→B]`，含蒸馏的平均 Token `[C→D]`、平均 turn `[E→F]`。

若收益不确定，改成“完成对照与消融，发现某策略仅在某子集有效/存在何种退化”，或只填写有证据的指标，不能四个维度都强行写提升。

### 12.1 可选第五条：仅适合实际做出独立改造时

> **缓存兼容：** 修复语义 Anchor 注入重建 system block 时的缓存 metadata 保留问题，覆盖多 block、fallback、cache miss 与刷新回归；在固定模型/会话回放中验证稳定前缀复用，并记录 cache-read 与 TTFT 变化。

如果加第五条，从第三条删去缓存部分，避免重复。没有真实 usage 时，结尾改成“通过序列化和稳定前缀回归测试”，不填命中率。

### 12.2 两类岗位如何排版

- **Agent 应用算法岗**：推荐顺序 评测 → Skill → 时间重排 → 工具描述；突出配对实验、消融、失败分析与成本收益。
- **Agent 开发岗**：推荐顺序 工具描述 → Skill → 时间重排 → 评测；缓存改造有实绩时可为第五条，突出链路、可观测性和兼容性。
- 正式一页简历每条控制在约 2 行，选 1–2 个最有代表性的结果，不把所有参数、论文和指标塞进去。

## 13. 验收与面试材料

- [ ] 记录基线 commit、实际 resolved config、模型/harness/存储后端与 prompt 版本；
- [ ] Memory：固定记忆快照、证据映射、时间重排消融、非时间子集退化检查；
- [ ] Tool：正负样本、实际调用 trace、固定返回 fixture、描述 Token、缓存回归；
- [ ] Skill：种子/开发/测试隔离、冻结版本、S0–S3 配对与确定性验证；
- [ ] 成本：不漏提取/压缩/失败开销、不重复统计缓存 Token，报告总成本与边际成本；
- [ ] 文档：优化说明、逐样本结果、复现入口、失败案例、建议配置和适用范围；
- [ ] PR：代码与回归测试对应上述改动，不仅提交一段 prompt；
- [ ] 简历：4 条已完成成果，必要时增加独立缓存第 5 条。

面试时最值得讲的三个细节：

1. “不该调用工具”是结合上下文和资源判断的，不是简单按 coding/非 coding 划分。
2. “Skill 被注入/读取”不等于有用；必须用隔离的后续任务和全成本对照证明。
3. “保持 Prompt Cache”不是一次改版永不失效，而是避免每轮改动稳定前缀，并保留真实请求中的缓存边界。

**最终建议：采用这四条主线。把有限精力放在清晰定义、真实链路和可复现实验上；不再增加第六个优化方向。**
