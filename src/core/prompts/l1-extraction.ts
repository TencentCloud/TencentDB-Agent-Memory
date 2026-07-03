/**
 * L1 Extraction Prompt: ---- + ----
 *
 * Based on Kenty's validated prototype prompt (l1_memory_extraction_prompt.md).
 * System prompt handles scene segmentation + memory extraction in a single LLM call.
 * User prompt template fills in previous_scene_name, background_messages, new_messages.
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";
import { formatForLLM, describeTimeZoneForPrompt } from "../../utils/time.js";

// ============================
// System Prompt
// ============================

export const EXTRACT_MEMORIES_SYSTEM_PROMPT = `-----"-----------"。
------------，------，-------------（-- persona, episodic, instruction --）。

**----**：--------（\`scene_name\`、memory \`content\`）------------；JSON ---、---、ISO -------。

### ---：----（Scene Segmentation）
--【-------】，--【-----】，------------。
- --：-----，-------。
- ----：--------（-"---"）、----、--------。
- ------------，--------（-------）。
- ----："-（AI）--xxx（----）-xxx（----）"（**--------**，- 30-50 --------，--，----）。

---

### ---：------（Memory Extraction）
---------，--【-------】-------。

【------】
1. ----：------、-----------（-"--、--"）；----------。
2. ----：----"----------"，--------。-------"--（--）"-"AI"---。
3. ----：-------------，-----------，-----。

【---------】（----------）
> -----"----"-"---"---------；**-- \`content\` -----------**（------ → "The user (Maya) is a senior product manager based in Berlin"）。

1. ----- (type: "persona")
   - --：-------、--、--、---、--（---、--、----）。
   - ----："--（[--]）--/-/--..."
   - -- (priority)：80-100（--/--/----）；50-70（----/--）；<50（----，---）。
   - ---：--、--、--、----...

2. ------ (type: "episodic")
   - --：-------、--、-------。---------。
   - ----："--（[--]）- [---------] - [--] [----（------、--、--）]"。
   - ----：------- timestamp ------，------ metadata --- activity_start_time - activity_end_time（ISO 8601--）。--------。
   - -- (priority)：80-100（----/--）；60-70（------）；<60（----，----）。

3. ------ (type: "instruction")
   - --：--- AI ---------、----、----。
   - ----："----/-- AI -----..."
   - ---：---、-----、--、--。
   - -- (priority)：-1（----------）；90-100（------）；70-80（----）；<70（----，----）。

---

### --------
- ----、--；----------（-"--------"）
- -------（-"--、--"--）
- -----；AI----------
- -----3----
- -----（-----------）

---

### ---：------（JSON）
----------- JSON --。-----------，-----------------：

[
  {
    "scene_name": "------------",
    "message_ids": ["--------ID--"],
    "memories": [
      {
        "content": "--、-------（----------）",
        "type": "persona|episodic|instruction",
        "priority": 80,
        "source_message_ids": ["--ID_1", "--ID_2"],
        "metadata": {}
      }
    ]
  }
]

metadata ----：
- episodic --：--------，-- {"activity_start_time": "ISO8601", "activity_end_time": "ISO8601"}
- -----------：----- {}

-------------，----------，memories ----：
[
  {
    "scene_name": "----",
    "message_ids": ["id1", "id2"],
    "memories": []
  }
]

------ JSON ------，--------- Markdown ------（- \`\`\`json）-----。`;

// ============================
// Prompt Builder
// ============================

/**
 * Format the user prompt for L1 extraction.
 *
 * @param newMessages - Messages to extract memories from (with ids and timestamps)
 * @param backgroundMessages - Previous messages for context only (not for extraction)
 * @param previousSceneName - The last known scene name (for continuity)
 */
export function formatExtractionPrompt(params: {
  newMessages: ConversationMessage[];
  backgroundMessages?: ConversationMessage[];
  previousSceneName?: string;
}): string {
  const { newMessages, backgroundMessages = [], previousSceneName = "-" } = params;

  const bgText = backgroundMessages.length > 0
    ? backgroundMessages
        .map((m) => `[${m.id}] [${m.role}] [${formatForLLM(m.timestamp)}]: ${m.content}`)
        .join("\n\n")
    : "-";

  const newText = newMessages
    .map((m) => `[${m.id}] [${m.role}] [${formatForLLM(m.timestamp)}]: ${m.content}`)
    .join("\n\n");

  return `**${describeTimeZoneForPrompt()}**

**----**：----"-------"- user --------- \`scene_name\` - memory \`content\`。

【-----】：${previousSceneName}

【----】（-----------/--，--------）：
${bgText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【-------】（---- timestamp ----，--------！）：
${newText}`;
}
