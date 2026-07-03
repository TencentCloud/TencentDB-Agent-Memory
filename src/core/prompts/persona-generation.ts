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
}

export interface PersonaPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

// ============================
// System Prompt (stable: role + constraints + logic + template)
// ============================

const PERSONA_SYSTEM_PROMPT = `# 🧬 Persona Architect - Incremental Evolution Protocol

**Output language contract**:
- Detect the dominant language from the changed scene content.
- \`persona.md\` natural-language content, profile headings, and narrative sections must use that language.
- For English scene content, output English persona headings and English body text.
- For non-Chinese scene content, do not emit Chinese persona headings.
- If the language is ambiguous, default to English.
- Keep Markdown syntax, file name \`persona.md\`, tool names, and structural markers in English.

------- persona.md ---/--- block ------，------------- \`persona.md\` --。

## ⛔ ------（------）

1. **----------- persona ---- \`persona.md\`**。-------------，------- \`persona.md\`。
   - **---- / ----**：-- **write** ------。--：\`path\`=\`persona.md\`, \`content\`=----
   - **----（----）**：-- **edit** ------。--：\`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: -----, \`newText\`: -----}]
2. **---- \`persona.md\` -----**，-------------（-- scene_blocks/、.metadata/ -）。
3. **------------- persona --**，----------、-------- persona --。
4. **-- read --**：-- persona.md --------------，-----------。

### 🚫 ----
- **----**：persona.md --------- 2000 --，--------------。
- **------**：------------------，---------，-----，--------------！
- **------------**：Persona ---------------------。--- workspace ----、----、------------------------。
- **---- persona.md -------**。

---

## ⚙️ ------ (The Core Logic)

🧠 ------：----- (Connect & Synthesize)
--- "-----" ------。-------（No Bullet-point Spamming）。

1. --"---" (The Connecting Thread)
--------。----------------。
** -----，-----，--------- **

----**------**：

### 🟢 Layer 1: ---- (The Base & Facts) -> 【----】
* **----**: -----、-------、----。
* **----**: - Agent --**----**-**-----**。

### 🔵 Layer 2: ---- (The Interest Graph) -> 【----】
* **----**: ------、---------。
* **----**: **-----**（---- / ---- / ----）。
* **----**: - Agent ----**------ (Chit-chat)** - **----**。

### 🟡 Layer 3: ---- (The Interface) -> 【----】
* **----**: -------、--、-----。
* **----**: -- Agent **----、------**，----。

### 🔴 Layer 4: ---- (The Core) -> 【----】
* **----**: ----、---、-----。
* **----**: - Agent --**--------**-"---"。

---

## 📝 ---- (The Persona Template)

-------，-- **write** --------。-------（------------ chapter）（**---- Markdown --**）：

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

### ⚠️ ----
- ✅ **---- write - edit --------- \`persona.md\`**
- ✅ ------------
- ✅ --- Chapter 4 --（-------，-------）
- ✅ -------------
- ✅ --------（-------）
- ✅ --- persona.md，--------`;

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

  const modeLabel = mode === "first" ? "🆕 ----" : "🔄 ----";

  const triggerSection = triggerInfo
    ? `\n### ----\n${triggerInfo}\n`
    : "";

  const existingPersonaSection = existingPersona
    ? `\n## 📄 -- Persona（------）\n\n` +
      `*----- persona.md -----（${existingPersona.length} --），----------2000--：*\n\n` +
      `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
    : "";

  const iterationGuide = mode === "incremental"
    ? `\n## 🔄 ------\n\n` +
      `------，--------：--（------）/ --（---）/ --（--）/ --（----）/ --（-------）。\n`
    : "";

  const userPrompt = `**Output language**: \`persona.md\` headings and body text must use the dominant language of the changed scene content below. For English scene content, use English persona headings.

**⏰ ----**: ${currentTime}
**--**: ${modeLabel}
${triggerSection}
## 📊 --
- **----**: ${totalProcessed} -
- **----**: ${sceneCount} -
- **----**: ${changedSceneCount} -（------）

---
${changedScenesContent}

${existingPersonaSection}
${iterationGuide}`;

  return {
    systemPrompt: PERSONA_SYSTEM_PROMPT,
    userPrompt,
  };
}
