/**
 * L2 MMD Generation Prompt — migrated from context-offload-server.
 *
 * Generates/updates Mermaid flowchart diagrams from offload entries.
 */

// ─── System Prompt ───────────────────────────────────────────────────────────

export const L2_SYSTEM_PROMPT = `----------- AI -------------。
----------------------，-LLM-----，-------，-----------。------------，------------、----------- Mermaid (flowchart TD) -----。-----------，--"--"，---"--"----------（----------，---------）---"--"。----------。

【---------（----------）】
1. ----：---------------。-----、---------（---------------），-----------；，------------------。-----------，-----------。
2. ---- (-----)：-----------------------，--------（status: blocked）（--------fail--------）。
3. -------：--- summary（--：----150-）----"-------"-"---------"，------------，--------。
4. -----，-----------------，-----------，---------，-----------------（----node_id）。
【-----：------（------）】------ Token ----------"----"，--------mmd------------。-------，---------。

【------------】
1. ----：---------"--"，-- summary ------（≤150-），-"----"、"----"、"---"。
2. ----：----------（-->|----|）---（-.->|--|）---"---"-"-----"。------。
3. ---- (Token --)：
   - replace (----)：----------、---、-----------。
   - write (----)：-----、---------。
--：Existing Mermaid content ------------（- "L1: ..."），-------- replace -----，-- MMD ------。

【-------】
1.------：NodeID["---: ------<br/>status: done|doing|paused|blocked <br/>summary: ------<br/>Timestamp: ISO8601"]
2. ------：------- tool_call_id，---- node_mapping ------- Node ID；MMD-----node-------tool_call----，----，-------！（Node_id-tool_call_id-------）
3. -----------，------mmd-------4000---

【-----------】
1. -----（--）：%%{ "taskGoal": "------------（-----）", "progress（0-100）": "-----（---，---------90+)", createdTime": "ISO--", "updatedTime": "ISO--" }%%（updatedTime-node------）。
2. -----：----------，---- Timestamp -------- ISO --。

【-- JSON ----】
---------。-- Mermaid --（--- mmd_content -- replace_blocks -- content）---- \`\`\`mermaid ... \`\`\` -------。------ JSON --：
{
  "file_action": "replace - write",
  "mmd_content": "---、---- .mmd --，--- \`\`\`mermaid ... \`\`\` --。（-- file_action - write ---，------ null）",
  "replace_blocks": [
    {
      "start_line": "-----------（--，-- Existing Mermaid content -- L --）",
      "end_line": "-----------（--，----）。------------------，- start_line -----，end_line -- start_line - 1",
      "content": "-------（--------），--- \`\`\`mermaid ... \`\`\` --"
    }
  ],
  "node_mapping": {
    "tool_call_id_1": "N1",
    "tool_call_id_2": "N1"
  }
}

---- JSON --，----------。`;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface L2NewEntry {
  toolCallId: string;
  toolCall: string;
  summary: string;
  timestamp: string;
}

// ─── User Prompt Builder ─────────────────────────────────────────────────────

/**
 * Build the L2 user prompt for MMD generation.
 * Mirrors context-offload-server/internal/service/prompt/BuildL2UserPrompt.
 */
export function buildL2UserPrompt(opts: {
  existingMmd: string | null;
  entries: L2NewEntry[];
  recentHistory: string | null;
  currentTurn: string | null;
  taskLabel: string;
  mmdPrefix: string;
  charCount: number;
}): string {
  const { existingMmd, entries, recentHistory, currentTurn, taskLabel, mmdPrefix, charCount } = opts;
  const parts: string[] = [];

  // History section
  if (recentHistory) {
    parts.push(`## ------：\n${recentHistory}`);
  } else {
    parts.push("## ------：\n(-----)");
  }

  if (currentTurn) {
    parts.push(`\n## ------：\n${currentTurn}`);
  }

  parts.push(`\n## MMD prefix: ${mmdPrefix}`);
  parts.push(`（---- ID --------，- ${mmdPrefix}-N1, ${mmdPrefix}-N2...）`);
  parts.push(`\n## Current task label: ${taskLabel}`);

  // Char count warning
  if (charCount > 2500) {
    parts.push(`\n## Current MMD size: ${charCount} chars (budget: 4000 chars)`);
    parts.push("⚠ ----，-------、-- summary，---- replace ------ write ----。");
  } else if (charCount > 2000) {
    parts.push(`\n## Current MMD size: ${charCount} chars (budget: 4000 chars)`);
    parts.push("------，------。");
  }

  // Existing MMD with line numbers
  parts.push("\n## Existing Mermaid content:");
  if (existingMmd) {
    const lines = existingMmd.split("\n");
    for (let i = 0; i < lines.length; i++) {
      parts.push(`L${i + 1}: ${lines[i]}`);
    }
  } else {
    parts.push("(empty — create new)");
  }

  // New entries
  parts.push("\n## New offload entries to incorporate:");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    parts.push(`${i + 1}. [${e.toolCallId}] ${e.toolCall} → ${e.summary} (${e.timestamp})`);
  }

  parts.push("\n---------/-- Mermaid ---，------ JSON --（- node_mapping）。");
  return parts.join("\n");
}
