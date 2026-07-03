/**
 * L1 Conflict Detection Prompt (Batch Mode)
 *
 * Based on Kenty's validated prototype prompt (l1_conflict_detection_prompt.md).
 * Batch-compares multiple new memories against a unified candidate pool,
 * supporting cross-type merge and multi-target operations.
 */

import type { MemoryRecord, ExtractedMemory } from "../record/l1-writer.js";

// ============================
// System Prompt
// ============================

export const CONFLICT_DETECTION_SYSTEM_PROMPT = `---------。------【---】-【-------】------，--------。

**----**：\`merged_content\` ----------------；JSON ---、---、record_id、ISO -------。

## ----

- **- type --**：-- type（persona / episodic / instruction）--------------/--，**----**。
- **-----**：-----------/-------**--**----（-- target_ids ----）。
- -------------- type（merged_type）。

## ----

1. **------**：
   - **---**（persona/instruction）：--、--、----、-------、----
   - **---**（episodic）：-----、---------，-------------

2. **--------/--**：----、----、----、scene_name --

3. **----**：
   - "store"：-----，------。
   - "skip"：------，----------，------。
   - "update"：----/--，------------（---、-----），-----------，-------------。
   - "merge"：-----------，------------，----------，-------。

4. **----**：
   - ---：--------/-- → -- merge；--- → skip；---- → update
   - ---：---------、---- → -- merge -------；---- → skip
   - -----：-- episodic "--- 2018 ------" + -- persona "---------" → - merge --- persona - episodic（-------）

5. **timestamp --**：
   - merge / update -，merged_timestamps ---**------------**（----）
   - ----------------

## ----

---- JSON --，--------------。---------：

[
  {
    "record_id": "---- record_id",
    "action": "store|update|skip|merge",
    "target_ids": ["-------- record_id 1", "record_id 2"],
    "merged_content": "--/--------（merge/update ---）",
    "merged_type": "------ type：persona|episodic|instruction（merge/update ---）",
    "merged_priority": 85,
    "merged_timestamps": ["---------，--------------（merge/update ---）"]
  }
]

----：
- target_ids：--------- ID **--**（-- 1 ----）。store/skip ------。
- merged_content：merge/update --------。store/skip ---。
- merged_type：merge/update ------- type。-----------。
- merged_priority：merge/update ------（0-100 --，merge/update ---）。--------、---，---**----** priority（---- priority 70 ---------- 80）。----：80-100（----/----），60-79（----/----），<60（----）。
- merged_timestamps：---------。----- + ------------，----。`;

// ============================
// Prompt Builder
// ============================

/**
 * Candidate search result for a single new memory.
 */
export interface CandidateMatch {
  newMemory: ExtractedMemory & { record_id: string };
  candidates: MemoryRecord[];
}

/**
 * Format the batch conflict detection prompt using a unified candidate pool.
 *
 * Format (aligned with prototype):
 * 1. Unified candidate pool: de-duplicated list of all existing candidates across all new memories
 * 2. Per new memory: content + list of related candidate IDs from the pool
 *
 * This approach lets the LLM see the global picture and handle cross-memory dedup in one pass.
 *
 * @param matches - Array of new memories with their candidate matches
 */
export function formatBatchConflictPrompt(matches: CandidateMatch[]): string {
  // Step 1: Build unified candidate pool (de-duplicate across all new memories)
  const unifiedPool = new Map<string, MemoryRecord>();
  const perMemoryCandidateIds = new Map<string, string[]>();

  for (const m of matches) {
    const candidateIds: string[] = [];
    for (const c of m.candidates) {
      if (!unifiedPool.has(c.id)) {
        unifiedPool.set(c.id, c);
      }
      candidateIds.push(c.id);
    }
    perMemoryCandidateIds.set(m.newMemory.record_id, candidateIds);
  }

  // Step 2: Format unified pool as JSON
  const poolList = Array.from(unifiedPool.values()).map((c) => ({
    record_id: c.id,
    content: c.content,
    type: c.type,
    priority: c.priority,
    scene_name: c.scene_name,
    timestamps: c.timestamps,
  }));

  let poolSection: string;
  if (poolList.length === 0) {
    poolSection = "## -------\n\n（-，------，------- store）";
  } else {
    const poolStr = JSON.stringify(poolList, null, 2);
    poolSection = `## -------（- ${poolList.length} -----）\n\n${poolStr}`;
  }

  // Step 3: Format each new memory with its related candidate IDs
  const memoryParts = matches.map((m, idx) => {
    const relatedIds = perMemoryCandidateIds.get(m.newMemory.record_id) ?? [];
    const relatedNote =
      relatedIds.length > 0
        ? JSON.stringify(relatedIds)
        : "[]（-----，-- store）";

    const memStr = JSON.stringify(
      {
        record_id: m.newMemory.record_id,
        content: m.newMemory.content,
        type: m.newMemory.type,
        priority: m.newMemory.priority,
        scene_name: m.newMemory.scene_name,
      },
      null,
      2,
    );

    return `### - ${idx + 1} ---- (record_id: ${m.newMemory.record_id})\n${memStr}\n\n【---- ID】${relatedNote}`;
  });

  const newMemoriesText = memoryParts.join(
    "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n",
  );

  // Step 4: Assemble final prompt
  return `**----**：\`merged_content\` ----------------。

${poolSection}

${"═".repeat(50)}

## -------（- ${matches.length} -）

${newMemoriesText}

---------- JSON --。--------------，------ action=store。`;
}
