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
 * Strip markdown code fences that wrap TencentDB recall blocks.
 *
 * Some LLM providers or agent frameworks may wrap injected XML content in
 * markdown code blocks (e.g. ```xml\n<relevant-memories>...\n```).
 * This helper detects and removes such wrapping so the inner XML can be
 * processed by the standard XML stripping logic.
 *
 * Handles:
 * - Fenced code blocks with optional language tag (```xml, ```)
 * - Inline code-wrapped blocks (`...`)
 * - Bold-wrapped blocks (**...**)
 *
 * Only strips when the content inside contains the TencentDB preamble.
 *
 * @returns The cleaned text, or the original if no markdown-wrapped recall was found.
 */
function stripMarkdownWrappedRecall(text: string): string {
  let cleaned = text;
  let changed = false;

  // 1. Strip fenced code blocks that contain TencentDB recall
  //    Matches ```lang? newline ... recall_content ... newline ```
  //    Uses a two-pass approach: first find fenced blocks, then check content.
  const fencedRe = /```[a-z]*\s*\n([\s\S]*?)```/g;
  const toStrip: string[] = [];
  let fencedMatch: RegExpExecArray | null;
  // Collect matches first to avoid index shifting during replacement
  while ((fencedMatch = fencedRe.exec(text)) !== null) {
    if (
      fencedMatch[1].includes("<relevant-memories>") &&
      fencedMatch[1].includes(TENCENTDB_RECALL_PREAMBLE)
    ) {
      toStrip.push(fencedMatch[0]);
    }
  }
  for (const block of toStrip) {
    cleaned = cleaned.replace(block, "");
    changed = true;
  }

  // 2. Strip inline code-wrapped recall blocks: `...<relevant-memories>...`
  //    These are single-backtick wrapped, not multi-line fenced blocks.
  const inlineRe = /`(<relevant-memories>[\s\S]*?<\/relevant-memories>)`/g;
  let inlineMatch: RegExpExecArray | null;
  while ((inlineMatch = inlineRe.exec(cleaned)) !== null) {
    if (inlineMatch[1].includes(TENCENTDB_RECALL_PREAMBLE)) {
      cleaned = cleaned.replace(inlineMatch[0], "");
      changed = true;
    }
  }

  // 3. Strip bold-wrapped recall blocks: **<relevant-memories>...**
  const boldRe = /\*\*<relevant-memories>([\s\S]*?)<\/relevant-memories>\*\*/g;
  let boldMatch: RegExpExecArray | null;
  while ((boldMatch = boldRe.exec(cleaned)) !== null) {
    if (boldMatch[0].includes(TENCENTDB_RECALL_PREAMBLE)) {
      cleaned = cleaned.replace(boldMatch[0], "");
      changed = true;
    }
  }

  return changed ? cleaned.trim() : text;
}

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
    // Pre-process: strip markdown wrapping first (fenced code, inline code, bold)
    // so the standard XML stripping below can process the inner content
    content = stripMarkdownWrappedRecall(content);
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
