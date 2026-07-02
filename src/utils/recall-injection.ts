/**
 * recall-injection.ts
 *
 * Pure functions for handling TencentDB-generated recall injection content
 * in user messages. Extracted from index.ts for testability.
 *
 * These helpers:
 * - stripRecallFromUserMessage: removes <relevant-memories> blocks from
 *   user messages before they are persisted to session JSONL
 * - hasRecallInjection: checks whether a message contains injected recall content
 */

/** Regex matching TencentDB-generated <relevant-memories> blocks. */
const RECALL_STRIP_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g;

/** TencentDB's standard recall preamble — used to distinguish generated content from user-authored examples. */
const TENCENTDB_RECALL_PREAMBLE = "以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：";

/**
 * Strip TencentDB-generated <relevant-memories> blocks from a user message.
 *
 * Only blocks containing the TencentDB standard preamble are removed;
 * user-authored <relevant-memories> examples (without the preamble) are preserved.
 *
 * Supports both string content and ContentPart[] arrays (OpenClaw user message format).
 *
 * @returns The cleaned content (same type as input), or the original if no changes were made.
 */
export function stripRecallFromUserMessage(
  content: string | Array<{ type: string; text?: string }>,
): string | Array<{ type: string; text?: string }> {
  if (typeof content === "string") {
    if (!content.includes(TENCENTDB_RECALL_PREAMBLE)) return content;

    // Strip only blocks containing the TencentDB preamble
    const blockRe = /<relevant-memories>[\s\S]*?<\/relevant-memories>/g;
    let cleaned = content;
    let changed = false;
    let match: RegExpExecArray | null;
    while ((match = blockRe.exec(content)) !== null) {
      if (match[0].includes(TENCENTDB_RECALL_PREAMBLE)) {
        cleaned = cleaned.replace(match[0] + "\n", "").replace(match[0], "");
        changed = true;
      }
    }
    if (!changed) return content;
    return cleaned.trim();
  }

  if (Array.isArray(content)) {
    let totalStripped = 0;
    const cleanedParts = content.map((part) => {
      if (part.type !== "text" || typeof part.text !== "string") return part;
      if (!(part.text as string).includes(TENCENTDB_RECALL_PREAMBLE)) return part;

      const blockRe = /<relevant-memories>[\s\S]*?<\/relevant-memories>/g;
      let text = part.text as string;
      let changed = false;
      let match: RegExpExecArray | null;
      while ((match = blockRe.exec(part.text as string)) !== null) {
        if (match[0].includes(TENCENTDB_RECALL_PREAMBLE)) {
          text = text.replace(match[0] + "\n", "").replace(match[0], "");
          changed = true;
        }
      }
      if (changed) {
        totalStripped += (part.text as string).length - text.length;
        return { ...part, text: text.trim() };
      }
      return part;
    });
    if (totalStripped === 0) return content;
    return cleanedParts;
  }

  return content;
}

/**
 * Check whether a user message contains TencentDB-injected recall content.
 *
 * @returns true if the message contains <relevant-memories> with the standard preamble.
 */
export function hasRecallInjection(
  content: string | Array<{ type: string; text?: string }>,
): boolean {
  if (typeof content === "string") {
    return content.includes("<relevant-memories>") && content.includes(TENCENTDB_RECALL_PREAMBLE);
  }

  if (Array.isArray(content)) {
    return content.some(
      (part) =>
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.includes("<relevant-memories>") &&
        part.text.includes(TENCENTDB_RECALL_PREAMBLE),
    );
  }

  return false;
}
