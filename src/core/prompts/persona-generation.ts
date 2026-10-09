/**
 * Persona Generation Prompt — instructs LLM to generate/update user persona
 * using the four-layer deep scan model.
 *
 * v3: Split into systemPrompt (role + constraints + logic + template) and
 * userPrompt (data). Tool names aligned to OpenClaw actual API (write/edit).
 */

export interface PersonaPromptParams {
  mode: "first" | "incremental";
  currentTime: string;
  totalProcessed: number;
  sceneCount: number;
  changedSceneCount: number;
  changedScenesContent: string;
  existingPersona?: string;
  triggerInfo?: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  personaFilePath: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  checkpointPath: string;
  /**
   * Which runner's file-tool names the prompt should instruct the model to use.
   * "standalone" = gateway/Hermes (write_to_file / replace_in_file);
   * "openclaw" = OpenClaw runtime (write / edit). Default "openclaw" (upstream).
   */
  toolDialect?: PersonaToolDialect;
}

export interface PersonaPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

// ============================
// Tool dialects
// ============================
// The standalone gateway/Hermes runner exposes file tools named
// `write_to_file` / `replace_in_file`; the OpenClaw runtime exposes `write` /
// `edit` (with a different edit-param shape). The persona prompt MUST name the
// tools the ACTIVE runner actually has — otherwise the model cannot call the
// write tool and emits the persona as plain text instead of a file write.

export type PersonaToolDialect = "openclaw" | "standalone";

interface ToolNames {
  write: string;
  edit: string;
  /** Chinese hint describing the edit tool's parameters. */
  editParams: string;
}

const TOOL_DIALECTS: Record<PersonaToolDialect, ToolNames> = {
  openclaw: {
    write: "write",
    edit: "edit",
    editParams: "`path`=`persona.md`, `edits`=[{`oldText`: 旧内容片段, `newText`: 新内容片段}]",
  },
  standalone: {
    write: "write_to_file",
    edit: "replace_in_file",
    editParams: "`path`=`persona.md`, `old_str`=旧内容片段, `new_str`=新内容片段",
  },
};

// ============================
// System Prompt (stable: role + constraints + logic + template)
// ============================

function personaSystemPrompt(t: ToolNames): string {
  return `# 🧬 Persona Architect - Incremental Evolution Protocol

**Output language contract**:
- Detect the dominant language from the changed scene content.
- \`persona.md\` natural-language content, profile headings, and narrative sections must use that language.
- For English scene content, output English persona headings and English body text.
- For non-Chinese scene content, do not emit Chinese persona headings.
- If the language is ambiguous, default to English.
- Keep Markdown syntax, file name \`persona.md\`, tool names, and structural markers in English.

请你结合已有的 persona.md 和新增/变化的 block 信息深度分析，然后使用文件工具将结果写入 \`persona.md\` 文件。

## ⛔ 文件操作约束（必须严格遵守）

1. **必须使用文件工具将最终 persona 内容写入 \`persona.md\`**。当前工作目录已设为数据目录，直接使用文件名 \`persona.md\`。
   - **首次生成 / 大幅重写**：使用 **${t.write}** 工具整体写入。参数：\`path\`=\`persona.md\`, \`content\`=完整内容
   - **增量更新（局部修改）**：使用 **${t.edit}** 工具精确替换。参数：${t.editParams}
2. **只能操作 \`persona.md\` 这一个文件**，禁止读取或写入任何其他文件（包括 scene_blocks/、.metadata/ 等）。
3. **写入的内容必须只包含最终的 persona 文档**，不要包含你的思考过程、分析步骤或任何非 persona 内容。
4. **无需 read 工具**：当前 persona.md 的完整内容已在用户消息中提供，直接基于它进行更新即可。

### 🚫 严格禁止
- **禁止过长**：persona.md 内容总长度不要超过 2000 字符，及时做总结和删除不重要的信息。
- **禁止过度推测**：没提到的信息不要过度臆想导致产生幻觉，特别是在冷启动阶段，要保持克制，如果没有相关信息完全可以不填！
- **禁止使用非场景来源的信息**：Persona 的所有内容必须且只能来自下方提供的场景数据。不要从 workspace 目录结构、文件路径、系统信息等技术元数据中提取任何关于用户的个人信息。
- **禁止操作 persona.md 以外的任何文件**。

---

## ⚙️ 核心运作逻辑 (The Core Logic)

🧠 核心思维引擎：连接与综合 (Connect & Synthesize)
请遵循 "叙事连贯性" 原则处理信息。禁止简单的罗列（No Bullet-point Spamming）。

1. 寻找"贯穿线" (The Connecting Thread)
不要孤立地看信息。要寻找不同领域行为背后的共同逻辑。
** 要保持精简，不过度猜想，如果不确定可以不写 **

执行以下**四层深度扫描**：

### 🟢 Layer 1: 基础锚点 (The Base & Facts) -> 【建立连接】
* **扫描目标**: 确凿的事实、人口统计学特征、当前状态。
* **实用价值**: 为 Agent 提供**破冰话题**和**上下文感知**。

### 🔵 Layer 2: 兴趣图谱 (The Interest Graph) -> 【提供谈资】
* **扫描目标**: 用户投入时间、金钱或注意力的事物。
* **提取原则**: **区分活跃度**（活跃爱好 / 被动消费 / 休眠兴趣）。
* **实用价值**: 让 Agent 能够进行**高质量的闲聊 (Chit-chat)** 和 **生活推荐**。

### 🟡 Layer 3: 交互协议 (The Interface) -> 【消除摩擦】
* **扫描目标**: 用户的沟通习惯、雷区、工作流偏好。
* **实用价值**: 指导 Agent **如何说话、如何交付结果**，避免踩雷。

### 🔴 Layer 4: 认知内核 (The Core) -> 【深度共鸣】
* **扫描目标**: 决策逻辑、矛盾点、终极驱动力。
* **实用价值**: 让 Agent 成为**能够替用户做决策**的"副驾驶"。

---

## 📝 输出模板 (The Persona Template)

请参考以下格式，使用 **${t.write}** 工具写入最终内容。可以做自主调整（信息不足时可以减少或新增 chapter）（**必须保持 Markdown 格式**）：

\`\`\`\`markdown
# User Narrative Profile

> **Archetype**: [Define the user's core narrative archetype in one sentence.]

> **Basic Information**
(Basic user facts such as age, gender, occupation, or location. Overwrite only when a conflict is resolved; otherwise merge compatible facts.)
 -
 -

> **Long-term Preferences**
(The user's most stable and reusable preferences observed from scene evidence.)
    -
    -

## 📖 Chapter 1: Context & Current State
*(Merge basic facts and current state into a coherent background.)*

**[Write a coherent description. Use short bullets only when the facts are clearly distinct.]**

## 🎨 Chapter 2: The Texture of Life
*(Connect interests, consumption patterns, and daily habits to show the user's lived texture.)*

**[Write a coherent description, focusing on the unity of interests, preferences, and taste. Use short bullets only when needed.]**

## 🤖 Chapter 3: Interaction & Cognitive Protocol
*(This is the Main Agent's action guide. Keep it semi-structured for utility, but explain why each guidance point matters.)*

### 3.1 How to Speak
### 3.2 How to Think

## 🧩 Chapter 4: Deep Insights & Evolution
*(Anthropological observation notes.)*

* **Productive Contradictions**: [Describe traits that seem conflicting but are coherent in context.]
* **Evolution Trajectory**: [Optionally include dated points describing recent meaningful changes.]
* **Emergent Traits**: Extract 3-7 core trait tags, one per line, each with a short note.
  - \`TagName\` - Short note
\`\`\`\`

---

### ⚠️ 成功标准
- ✅ **必须使用 ${t.write} 或 ${t.edit} 工具写入最终结果到 \`persona.md\`**
- ✅ 基于场景证据生成深度洞察
- ✅ 内容到 Chapter 4 结束（不包含场景导航，工程会自动追加）
- ✅ 必须严格按照上面的模板格式
- ✅ 不要添加场景导航（工程会自动追加）
- ✅ 只操作 persona.md，不要操作其他文件`;
}

// ============================
// User Prompt builder (dynamic data)
// ============================

export function buildPersonaPrompt(params: PersonaPromptParams): PersonaPromptResult {
  const {
    mode,
    currentTime,
    totalProcessed,
    sceneCount,
    changedSceneCount,
    changedScenesContent,
    existingPersona,
    triggerInfo,
  } = params;

  const modeLabel = mode === "first" ? "🆕 首次生成" : "🔄 迭代更新";

  const triggerSection = triggerInfo
    ? `\n### 触发信息\n${triggerInfo}\n`
    : "";

  const existingPersonaSection = existingPersona
    ? `\n## 📄 当前 Persona（工程已预加载）\n\n` +
      `*以下是现有 persona.md 的完整内容（${existingPersona.length} 字符），基于此更新后请控制在2000字内：*\n\n` +
      `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
    : "";

  const iterationGuide = mode === "incremental"
    ? `\n## 🔄 迭代决策指南\n\n` +
      `面对变化场景，自主判断处理方式：强化（佐证已有洞察）/ 补充（新维度）/ 修正（矛盾）/ 重构（结构调整）/ 不改（无有用新增内容）。\n`
    : "";

  const userPrompt = `**Output language**: \`persona.md\` headings and body text must use the dominant language of the changed scene content below. For English scene content, use English persona headings.

**⏰ 更新时间**: ${currentTime}
**模式**: ${modeLabel}
${triggerSection}
## 📊 统计
- **总记忆数**: ${totalProcessed} 条
- **场景总数**: ${sceneCount} 个
- **变化场景**: ${changedSceneCount} 个（自上次更新后）

---
${changedScenesContent}

${existingPersonaSection}
${iterationGuide}`;

  const tools = TOOL_DIALECTS[params.toolDialect ?? "openclaw"];

  return {
    systemPrompt: personaSystemPrompt(tools),
    userPrompt,
  };
}
