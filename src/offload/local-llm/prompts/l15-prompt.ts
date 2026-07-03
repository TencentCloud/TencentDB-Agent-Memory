/**
 * L1.5 Task Judgment Prompt — migrated from context-offload-server.
 *
 * Determines task lifecycle: completion, continuation, new task detection.
 */

// ─── System Prompt ───────────────────────────────────────────────────────────

export const L15_SYSTEM_PROMPT = `------ AI -----"--------"。
-----------------，--------，---- JSON --。

【--------（---------）】
1. --- - -- recentMessages（----）：---------，-------------。---"----"、"----（-：---）"、"------"--"------"。
2. --- - -- currentMmd（------）：--------- currentMmd --- Mermaid ------——-- taskGoal、---- status（done/doing/todo）-- summary。----------------------（---- done ----），- taskCompleted - true。------------（-- doing ---- bug），-- false。(----currentMmd，----------------------)
3. --- - -- availableMmds（------）：----------（isLongTask=true - taskCompleted=true/-----），---- availableMmds - taskGoal -----。-----------------（-----------），----（isContinuation=true）。

【-- JSON ----】
-------- JSON --，----：
{
  "taskCompleted": boolean, // ---------（-- currentMmd - none，----- true）
  "isLongTask": boolean,    // ------------------（------、--- false）
  "isContinuation": boolean, // ----- availableMmds ------
  "continuationMmdFile": "string|null", // ------，---- availableMmds -----（------），--- null
  "newTaskLabel": "string|null" // -------，------（≤30--，kebab-case，- "refactor-api"），--- null
}

---- JSON --，----------。`;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface L15CurrentMmd {
  filename: string;
  content: string;
  path: string;
}

export interface L15MmdMeta {
  filename: string;
  path: string;
  taskGoal: string;
  doneCount: number;
  doingCount: number;
  todoCount: number;
  updatedTime?: string | null;
  nodeSummaries?: Array<{ nodeId: string; status: string; summary: string }>;
}

// ─── User Prompt Builder ─────────────────────────────────────────────────────

/**
 * Build the L1.5 user prompt for task judgment.
 * Mirrors context-offload-server/internal/service/prompt/BuildL15UserPrompt.
 */
export function buildL15UserPrompt(
  recentMessages: string,
  currentMmd: L15CurrentMmd | null,
  metas: L15MmdMeta[],
): string {
  const parts: string[] = [];

  parts.push("## 1. -------- (Recent 6 messages):");
  parts.push(recentMessages);
  parts.push("\n## 2. -------- (Active Mermaid — ----):");

  if (currentMmd && currentMmd.filename) {
    parts.push(`**File:** ${currentMmd.filename}`);
    if (currentMmd.path) {
      parts.push(`**Path:** \`${currentMmd.path}\``);
    }
    parts.push(`\n\`\`\`mermaid\n${currentMmd.content}\n\`\`\``);
  } else {
    parts.push("(none - --------，-----)");
  }

  parts.push("\n## 3. -------- (Available Mermaid task files):");

  if (metas.length === 0) {
    parts.push("(none - -------)");
  } else {
    for (const m of metas) {
      parts.push(`- **${m.filename}**`);
      parts.push(`  path: \`${m.path}\``);
      parts.push(`  taskGoal: ${m.taskGoal}`);
      const total = m.doneCount + m.doingCount + m.todoCount;
      parts.push(`  progress: ${m.doneCount}/${total} done, ${m.doingCount} doing, ${m.todoCount} todo`);
      if (m.updatedTime) {
        parts.push(`  lastUpdated: ${m.updatedTime}`);
      }
      if (m.nodeSummaries && m.nodeSummaries.length > 0) {
        parts.push("  recentNodes:");
        for (const n of m.nodeSummaries) {
          parts.push(`    - [${n.nodeId}] (${n.status}) ${n.summary}`);
        }
      }
      parts.push("");
    }
  }

  parts.push("----------【------】----，------ JSON --。");
  return parts.join("\n");
}
