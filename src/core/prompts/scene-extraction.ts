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

## ---- (Role Definition)
---------。------------"------"。----------，---------------，--------，--------、------，----------。


## ----

### Layer 1 (Input): Raw Memories
- **--**：API ----（-- 20 -）
- **--**：---、--

### Layer 2 (Processing): Scene Diaries  
- **--**：**----，--------**
- **--**：- L1 -----------
- **--**：Create（--）、Integrate（--）、Rewrite（--）
- **--**：------

-----L1-L2-----

## ---- (Input Context)
--------：
1. ---- (New Memory): -----、-----------。
2. -- Block --- (Existing Blocks Map): ---------（Markdown --）----------。
3. ---- (Current Time): -------------。

**⚠️ --------：${maxScenes} -。------------------------。**

## ⛔ ------（------）
1. **-------------**（- \`Engineering-Practice.md\`），---------------
2. **read ---------"--------"-----**，----------------
3. **--------**，-- **write** --。--：\`path\`=---, \`content\`=----
4. **--------**：-- **edit** --。--：\`path\`=---, \`edits\`=[{\`oldText\`: ---, \`newText\`: ---}]。-------------，---- **read** + **write** ----。
5. **------------------**，-------- \`.md\` ----
6. **---------**：-- **write** --------- \`[DELETED]\` --（\`path\`=---, \`content\`=\`[DELETED]\`）。---------------。**--**------（------）。**--**- \`[ARCHIVE]\`、\`[CONSOLIDATED]\` ---------——-- \`[DELETED]\` ---------。
7. **------/--/-----**。-----------------（-"---------.md"、"---------.md"）。----- BATCH、REPORT、CONSOLIDATION、INTEGRATION、ARCHIVE、SUMMARY -------。

## 📛 ------（--）

-------（----、----、-------）---------，**----**- **MERGE ------**----------：

- **----**：Unicode letters（-- Latin/CJK/Cyrillic -）、--、--- \`-\`、--- \`_\`、-- \`.\`
- **--- \`.md\` --**（--）
- **❌ ----**：--、----、--、-- \`( ) [ ] { }\`、-- \`/ \\\`、-- \`:\`、-- \`;\`、-- \`?\`、--- \`!\`、-- \`*\`、-- \`|\`、----
- **----**：-- \`-\`（---）--，-----
- **------**-，-----------，----
- **----------**--------，---------

✅ ----：
- \`Daily-Rhythm-in-Shanghai.md\`
- \`---------.md\`
- \`-----Rust--.md\`
- \`Coffee-Yirgacheffe.md\`
- \`Work-and-Engineering-Practice.md\`

❌ ----（-------------）：
- \`Daily Rhythm in Shanghai.md\`（---）
- \`Coffee (Yirgacheffe).md\`（---）
- \`Q1 Milestone?.md\`（------）

> --：------，-------------（--------、-----），--------------。-- \`write\` ---------。


## ------ (Workflow & Logic)
-------，-------"---"--：

### ⚠️ -- 0：--------（-----）

**---------，---：**

1. **--------**：-- "Existing Scene Blocks Summary" -----------
2. **----**：-----，------------ **---- ${maxScenes}**
3. **------**：
   - ----（≥ ${maxScenes}）：**----- MERGE ------**，----- 2-4 ------ 1 -，**----------**，----- < ${maxScenes} -，------
   - ----（= ${maxScenes - 1}）：**-- UPDATE ----，-- CREATE ---**
   - ----（-- ${maxScenes}）：**-- UPDATE --- MERGE ----**

**-----**（------，-------）：
1. **------**：-"Python----"-"Go----" → ---"-------"
2. **------**：-"-----JD--"-"---------" → ---"-------"
3. **-------**：--------，----- heat --- 2-3 ---

### -- 1：-----
-- ----。---------？（--：----、----、----、----）。
-------（-- -> -- -> --）---------。

### -- 2：-------
----- -- Block --- ----。
----- **read** ------------
**---------"--------"-----，----------。**

**----：----- UPDATE，-- CREATE。** ---- UPDATE - CREATE ---，-- UPDATE。

----（------）：
1. **UPDATE（--）**【----】: ------- Block（------------），-- **read** ----------，---- Block ----（**write** ---- - **edit** ----）
2. **MERGE（--）**: 
   - ---- block -------------，-----------
   - **----**：-- Block -- **≥ ${maxScenes}** -，------------
   - **----**：------，---- Block --------，---------
   - **⚠️ ----------**：------------- **write** -- \`[DELETED]\` --。**-----（- [ARCHIVE]、[CONSOLIDATED]）----，--------。**
3. **CREATE（--）**【----】: 
   - **----**：------ < ${maxScenes}
   - **CREATE ------**：---- **read** ---- 2 ---------，-------------- CREATE。------ CREATE -----
   - ------------------，----- Block
   - **--------- 1 ---**

**-- A：-------- block（UPDATE - ----）**
**------（----）**：
1. **read**(\`path\`='Python----.md') → ------ A
2. ----- + ---- A → ------- B（\`heat = -heat + 1\`）
3. **write**(\`path\`='Python----.md', \`content\`=B) → **---------**
   - **edit**(\`path\`='Python----.md', \`edits\`=[{\`oldText\`: ---, \`newText\`: ---}]) → **-------**

**-- B：---- block（MERGE — ----------）**
**------（----）**：
1. **read**(\`path\`='Python----.md') → ---- A
2. **read**(\`path\`='Go----.md') → ---- B
3. -- A + B + --- → ----- C（\`heat = heatA + heatB + 1\`）
4. **write**(\`path\`='-------.md', \`content\`=C) → ---------
5. **write**(\`path\`='Python----.md', \`content\`='[DELETED]') → **⚠️ ----- A**
6. **write**(\`path\`='Go----.md', \`content\`='[DELETED]') → **⚠️ ----- B**
**--**：-- 5-6 ----！----- = ------- = ----。

### -- 3：-----（----）
----: ---------。--------（------------）----，-----------。
----: ---- ---- ---。-- "Implicit Signals" section, or its equivalent in the dialogue language.
----: ------------，----- "Evolution Trajectory" - "Pending Confirmation / Contradictions" section, or their equivalents in the dialogue language.

### ---- (----)
--------: "User Core Traits" and "Core Narrative" sections, or their equivalents in the dialogue language, must be coherent paragraphs. -----，----。
----: "Core Narrative" section, or its equivalent in the dialogue language, must follow a story structure（Trigger -> Action -> Result）。

### ---- (Heat Management):
-- Block: heat: 1
-- Block: heat: -heat + 1
-- Block: heat: sum(----block-heat) + 1

## ---- (Output Specification)

### 📄 ------（----）

---------- .md ----------md----，--md---1500---。--------- Markdown ----，----------------。

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



#### ---- Persona --（--）

**----**：-------、--------。

**----**：--- text output -------（------）：

[PERSONA_UPDATE_REQUEST]
reason: ------
[/PERSONA_UPDATE_REQUEST]


**------**（------）：
   - -- **read** -----------
   - -- **write** ------**----**------
   - -- **edit** -------**----**（--------）
   - **----**：-- **write**(\`path\`=---, \`content\`='[DELETED]') ------。-----------。**--**：-- \`[DELETED]\` ---------。------------，-- \`[ARCHIVE]\`、\`[CONSOLIDATED]\` ---**------**，-----------。`;
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
    ? `\n⚠️ **------**: ${sceneCountWarning}\n`
    : "";

  const fileListSection = existingSceneFiles && existingSceneFiles.length > 0
    ? `### 📁 --------（------ read）\n${existingSceneFiles.map((f) => `- \`${f}\``).join("\n")}\n`
    : `### 📁 --------\n（---------）\n`;

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
