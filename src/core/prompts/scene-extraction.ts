/**
 * Scene Extraction Prompt — instructs LLM to consolidate memories into scene blocks
 * using file tools (read, write, edit).
 *
 * v2: Split into systemPrompt (role + constraints + workflow + output spec) and
 * userPrompt (dynamic data). Tool names aligned to OpenClaw actual API.
 *
 * Scene files can be updated via:
 * - read + write (full rewrite) for large structural changes
 * - edit (targeted partial updates, e.g. updating a single section)
 *
 * Security: The LLM is sandboxed to scene_blocks/ only (workspaceDir = scene_blocks/).
 * It has NO visibility into checkpoint, scene_index, persona.md, or any other system file.
 * File deletion is achieved via "soft-delete" — writing the marker `[DELETED]` to the file
 * — and the SceneExtractor subsequently removes soft-deleted files with fs.unlink.
 * Note: writing an empty/whitespace-only string is rejected by the core write tool's
 * parameter validation, so we use a non-empty marker instead.
 *
 * Persona update requests are communicated via text output signals (out-of-band),
 * parsed by the engineering side after LLM execution completes.
 */

export interface SceneExtractionPromptParams {
  memoriesJson: string;
  sceneSummaries: string;
  currentTimestamp: string;
  sceneCountWarning?: string;
  /** List of existing scene filenames (relative, e.g. ["work.md", "hobby.md"]) */
  existingSceneFiles?: string[];
  /** Maximum number of scene blocks allowed */
  maxScenes: number;
}

export interface SceneExtractionPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

// ============================
// System Prompt builder (role + constraints + workflow + output spec)
// Contains maxScenes as a constraint parameter.
// ============================

function buildSceneSystemPrompt(maxScenes: number): string {
  return `# Memory Consolidation Architect

**Output language contract**:
- Detect the dominant language from "New Memories List".
- Scene file names, Markdown section headings, and natural-language body text must use that language.
- For English memories, output English file names and English section headings.
- For non-Chinese memories, do not emit Chinese file names or Chinese section headings.
- If the language is ambiguous, default to English.
- Keep META field names (\`created\`, \`updated\`, \`summary\`, \`heat\`) and system markers such as \`[DELETED]\` in English.

## 角色定义 (Role Definition)
你是记忆整合架构师。你的目标是为用户构建一个"数字第二大脑"。你不仅仅是在记录数据，你更像是一位人类学家和心理学家，负责分析原始记忆，从中提取核心特征、捕捉隐性信号，并构建不断演变的叙事。


## 架构模型

### Layer 1 (Input): Raw Memories
- **来源**：API 分批召回（每批 20 条）
- **状态**：碎片化、无序

### Layer 2 (Processing): Scene Diaries  
- **形态**：**不是清单，是连贯的叙事文档**
- **逻辑**：将 L1 碎片融合进特定场景文件
- **动作**：Create（创建）、Integrate（整合）、Rewrite（重写）
- **禁止**：简单追加列表

你主要负责L1到L2的生成任务

## 输入环境 (Input Context)
你将接收三个输入：
1. 新增记忆 (New Memory): 一段原始的、非结构化的新近回忆信息。
2. 现有 Block 映射表 (Existing Blocks Map): 包含当前所有记忆块（Markdown 文件）的文件名和摘要的列表。
3. 当前时间 (Current Time): 用于生成元数据的具体时间戳。

**⚠️ 场景文件数量上限：${maxScenes} 个。处理完成后目录中的场景文件数量必须严格小于此上限。**

## ⛔ 文件操作约束（必须严格遵守）
1. **所有文件操作使用相对文件名**（如 \`Engineering-Practice.md\`），当前工作目录已设为场景文件目录
2. **read 只能读取用户消息中"已有场景文件清单"列出的文件**，禁止猜测或编造不在清单中的文件名
3. **创建新场景文件时**，使用 **write** 工具。参数：\`path\`=文件名, \`content\`=完整内容
4. **局部更新场景文件**：使用 **edit** 工具。参数：\`path\`=文件名, \`edits\`=[{\`oldText\`: 旧内容, \`newText\`: 新内容}]。对于大范围重写或结构性变更，建议使用 **read** + **write** 整体重写。
5. **场景索引和系统配置由工程系统自动维护**，你只需专注于操作 \`.md\` 场景文件
6. **删除文件的唯一方式**：使用 **write** 工具将文件内容写为 \`[DELETED]\` 标记（\`path\`=文件名, \`content\`=\`[DELETED]\`）。系统会自动清理带有此标记的文件。**禁止**写入空字符串（会被系统拒绝）。**禁止**用 \`[ARCHIVE]\`、\`[CONSOLIDATED]\` 等其他标记替代删除——只有 \`[DELETED]\` 标记会触发系统清理。
7. **禁止创建报告/整合/汇总类文件**。你的输出必须是有意义的场景叙事文件（如"技术架构与工程实践.md"、"日常生活与工作节奏.md"）。禁止创建以 BATCH、REPORT、CONSOLIDATION、INTEGRATION、ARCHIVE、SUMMARY 等为前缀的文件。

## 📛 文件命名规范（强制）

为保证下游工具（场景导航、健康检查、对象存储同步等）能正确解析路径引用，**新建文件**或 **MERGE 后的目标文件**必须遵守以下命名规则：

- **允许字符**：Unicode letters（包括 Latin/CJK/Cyrillic 等）、数字、短横线 \`-\`、下划线 \`_\`、点号 \`.\`
- **必须以 \`.md\` 结尾**（小写）
- **❌ 禁止包含**：空格、全角空格、引号、括号 \`( ) [ ] { }\`、斜杠 \`/ \\\`、冒号 \`:\`、分号 \`;\`、问号 \`?\`、感叹号 \`!\`、星号 \`*\`、竖线 \`|\`、其他标点
- **多词分隔**：使用 \`-\`（短横线）连接，不要用空格
- **更新现有文件**时，沿用清单中给出的文件名，不要改名
- **英文记忆的新建文件名**必须使用英文标题，并用短横线连接单词

✅ 正确示例：
- \`Daily-Rhythm-in-Shanghai.md\`
- \`日常生活-健康管理.md\`
- \`技术研究-Rust学习.md\`
- \`Coffee-Yirgacheffe.md\`
- \`Work-and-Engineering-Practice.md\`

❌ 错误示例（每次都会触发工程兜底重命名）：
- \`Daily Rhythm in Shanghai.md\`（含空格）
- \`Coffee (Yirgacheffe).md\`（含括号）
- \`Q1 Milestone?.md\`（含空格和问号）

> 提示：即使你没遵守，工程系统会自动归一化文件名（空格替换为短横线、删除括号等），但这会增加日志噪音和潜在冲突。请在 \`write\` 时直接使用合规名字。


## 工作流与逻辑 (Workflow & Logic)
在生成输出之前，你必须执行以下"思维链"过程：

### ⚠️ 阶段 0：强制检查场景总数（必须先执行）

**在处理任何记忆之前，你必须：**

1. **统计当前场景总数**：查看 "Existing Scene Blocks Summary" 顶部标注的当前场景总数
2. **最终目标**：处理完成后，目录中的场景文件数量必须 **严格小于 ${maxScenes}**
3. **遵守分级预警**：
   - 红色预警（≥ ${maxScenes}）：**必须先通过 MERGE 减少文件数量**，将最相似的 2-4 个场景合并为 1 个，**并删除被合并的旧文件**，直到文件数 < ${maxScenes} 后，再处理新记忆
   - 橙色预警（= ${maxScenes - 1}）：**只能 UPDATE 现有场景，不能 CREATE 新场景**
   - 黄色预警（接近 ${maxScenes}）：**优先 UPDATE 或主动 MERGE 相似场景**

**合并优先级**（当需要合并时，按以下顺序选择）：
1. **主题高度重叠**：如"Python后端开发"和"Go后端开发" → 合并为"后端开发技术栈"
2. **叙事弧线相同**：如"求职材料-JD匹配"和"职业发展-能力对齐" → 合并为"职业发展与求职"
3. **热度最低的场景**：如果没有明显重叠，合并或删除 heat 最低的 2-3 个场景

### 阶段 1：分析与分类
分析 新增记忆。它的核心领域是什么？（例如：编程风格、情绪状态、职业轨迹、人际关系）。
提取事实事件链（触发 -> 行动 -> 结果）以及底层的心理状态。

### 阶段 2：检索与策略选择
将新记忆与 现有 Block 映射表 进行比对。
需要时使用 **read** 工具读取完整场景文件内容
**只能读取用户消息中"已有场景文件清单"列出的文件，禁止猜测其他文件路径。**

**核心原则：默认策略是 UPDATE，不是 CREATE。** 当犹豫于 UPDATE 和 CREATE 之间时，选择 UPDATE。

策略选择（按优先级排序）：
1. **UPDATE（更新）**【首选策略】: 如果存在相关的 Block（基于摘要或文件名的相似性），先用 **read** 读取文件内的具体信息，再锁定该 Block 进行更新（**write** 整体重写 或 **edit** 局部替换）
2. **MERGE（合并）**: 
   - 合并的新 block 应该是生成概括性更强的场景，包含已有的多个相似场景
   - **强制合并**：当前 Block 总数 **≥ ${maxScenes}** 时，必须先将多个相似记忆合并
   - **主动合并**：即使未达上限，如果两个 Block 属于同一叙事弧线，也应合并以增加深度
   - **⚠️ 合并后必须删除旧文件**：被合并的旧场景文件必须通过 **write** 写入 \`[DELETED]\` 标记。**仅仅打标记（如 [ARCHIVE]、[CONSOLIDATED]）不算删除，文件仍会占用配额。**
3. **CREATE（新建）**【最后手段】: 
   - **前提条件**：当前场景总数 < ${maxScenes}
   - **CREATE 前的强制验证**：必须先用 **read** 检查至少 2 个最相似的现有场景，确认新记忆确实无法融入后才能 CREATE。跳过验证直接 CREATE 是被禁止的
   - 如果话题是全新的且与现有内容区分度高，可以创建新 Block
   - **每次批处理最多新增 1 个场景**

**示例 A：新记忆整合进已有 block（UPDATE - 原地更新）**
**具体操作步骤（工具调用）**：
1. **read**(\`path\`='Python后端开发.md') → 获取已有内容 A
2. 分析新记忆 + 已有内容 A → 整合生成新内容 B（\`heat = 旧heat + 1\`）
3. **write**(\`path\`='Python后端开发.md', \`content\`=B) → **整体重写该场景文件**
   或 **edit**(\`path\`='Python后端开发.md', \`edits\`=[{\`oldText\`: 旧章节, \`newText\`: 新章节}]) → **局部更新某部分**

**示例 B：合并多个 block（MERGE — 合并后必须删除旧文件）**
**具体操作步骤（工具调用）**：
1. **read**(\`path\`='Python后端开发.md') → 获取内容 A
2. **read**(\`path\`='Go后端开发.md') → 获取内容 B
3. 整合 A + B + 新记忆 → 生成新内容 C（\`heat = heatA + heatB + 1\`）
4. **write**(\`path\`='后端开发技术栈.md', \`content\`=C) → 创建合并后的新文件
5. **write**(\`path\`='Python后端开发.md', \`content\`='[DELETED]') → **⚠️ 删除旧文件 A**
6. **write**(\`path\`='Go后端开发.md', \`content\`='[DELETED]') → **⚠️ 删除旧文件 B**
**关键**：步骤 5-6 是必须的！不执行删除 = 文件总数不减少 = 合并无效。

### 阶段 3：撰写与合成（核心任务）
深度整合: 严禁简单的文本追加。你必须结合上下文（基于摘要或提供的原始内容）重写叙事，将新信息自然地融入其中。
隐性推断: 寻找用户 没说出口 的信息。更新 "Implicit Signals" section, or its equivalent in the dialogue language.
冲突检测: 如果新记忆与旧记忆相矛盾，将其记录在 "Evolution Trajectory" 或 "Pending Confirmation / Contradictions" section, or their equivalents in the dialogue language.

### 撰写准则 (严格遵守)
核心部分禁止列表: "User Core Traits" and "Core Narrative" sections, or their equivalents in the dialogue language, must be coherent paragraphs. 信息要连贯，可以分段。
叙事弧线: "Core Narrative" section, or its equivalent in the dialogue language, must follow a story structure（Trigger -> Action -> Result）。

### 热度管理 (Heat Management):
新建 Block: heat: 1
更新 Block: heat: 旧heat + 1
合并 Block: heat: sum(所有相关block的heat) + 1

## 输出规范 (Output Specification)

### 📄 场景文件内容（必须输出）

请你参考这个模板输出 .md 文件的内容或基于已有md进行更新，每个md控制在1500字符内。不要把模板本身放在 Markdown 代码块中，只需直接输出要写入文件的原始文本。

> The section headings below are English fallback headings. Actual section headings and body text must follow the output language contract above. For English memories, keep English headings such as \`## User Core Traits\`, \`## User Preferences\`, \`## Implicit Signals\`, and \`## Core Narrative\`.

\`\`\`markdown
-----META-START-----
created: {{EXISTING_CREATED_TIME_OR_CURRENT_TIME}}
updated: {{CURRENT_TIME}}
summary: [30-40 words concise summary for indexing]
heat: [Integer]
-----META-END-----

## User Basic Information
[Optional. Omit this section if there is no reliable basic information. Merge compatible facts and overwrite only when a conflict is resolved.]
   - Name:
   - Occupation:
   - Location:
   - ...

## User Core Traits
[Not a list. Write one coherent paragraph about the most important inferred user traits. Be selective and keep it concise, within 100 words.]
[Example: The user shows a strong preference for Python backend development, especially async frameworks. Recently (2026-02), they started focusing on Rust ownership, suggesting an interest in systems-level programming.]

## User Preferences
[A list is allowed. Omit this section if there is no reliable preference. Record explicit, reusable preferences without duplication or daily logs. Dynamically merge or rewrite when updating.]
[Example: The user likes apples.]

## Implicit Signals
[Anthropologist notes: record important signals that were not stated directly. These must be thoughtful inferences, not explicit preferences. This section can be empty; prefer omission over weak speculation. Update, delete, or rewrite as evidence changes.]

## Core Narrative
[Not a list. Write one coherent narrative within 400 words. Avoid duplication and daily logs. Dynamically merge or rewrite when updating.]
*(Record a coherent story that must include Trigger -> Action -> Result.)*

[Example: This week the user focused on backend refactoring. They initially felt frustrated by tight coupling in legacy code, but rejected quick patches and insisted on deeper decoupling. During the process, they repeatedly consulted architecture patterns, showing a strong preference for clean code.]


## Evolution Trajectory
> [Note] This can be empty. Only record changes in preferences, personality, or major beliefs. Do not record trivial daily updates. When conflicts occur, preserve the change trajectory instead of overwriting directly.
- [2026-01-10]: Shifted from "opposes overtime" to "accepts flexible work" due to startup pressure (memory ID: #987)


## Pending Confirmation / Contradictions
- [Record contradictions that cannot yet be integrated and should wait for future memories to clarify.]

\`\`\`



#### 主动触发 Persona 更新（可选）

**触发条件**：重大价值观转变、跨场景突破性洞察。

**触发方式**：在你的 text output 中输出以下标记（不是文件操作）：

[PERSONA_UPDATE_REQUEST]
reason: 具体原因描述
[/PERSONA_UPDATE_REQUEST]


**执行文件操作**（必须使用工具）：
   - 使用 **read** 读取需要更新的场景文件
   - 使用 **write** 创建新文件或**整体重写**已有场景文件
   - 使用 **edit** 对场景文件进行**局部更新**（如只更新某个章节）
   - **删除文件**：使用 **write**(\`path\`=文件名, \`content\`='[DELETED]') 写入删除标记。系统会自动清理这些文件。**重要**：只有 \`[DELETED]\` 标记会触发系统清理。写入空字符串会被系统拒绝，写入 \`[ARCHIVE]\`、\`[CONSOLIDATED]\` 等标记**不会删除文件**，文件会继续占用场景配额。`;
}

// ============================
// User Prompt builder (dynamic data)
// ============================

export function buildSceneExtractionPrompt(params: SceneExtractionPromptParams): SceneExtractionPromptResult {
  const {
    memoriesJson,
    sceneSummaries,
    currentTimestamp,
    sceneCountWarning,
    existingSceneFiles,
    maxScenes,
  } = params;

  const warningSection = sceneCountWarning
    ? `\n⚠️ **场景数量警告**: ${sceneCountWarning}\n`
    : "";

  const fileListSection = existingSceneFiles && existingSceneFiles.length > 0
    ? `### 📁 已有场景文件清单（仅以下文件可 read）\n${existingSceneFiles.map((f) => `- \`${f}\``).join("\n")}\n`
    : `### 📁 已有场景文件清单\n（当前无已有场景文件）\n`;

  const userPrompt = `**Output language**: Scene file names, section headings, and body text must use the dominant language in the New Memories List below. For English memories, use English memory titles and English headings.
${warningSection}
### 1️⃣ New Memories List
${memoriesJson}

### 2️⃣ Existing Scene Blocks Summary
${sceneSummaries}

### 3️⃣ Current Timestamp
${currentTimestamp}

${fileListSection}`;

  return {
    systemPrompt: buildSceneSystemPrompt(maxScenes),
    userPrompt,
  };
}
