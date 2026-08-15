/**
 * Host-neutral helpers for <relevant-memories> injection blocks.
 * Used by before_message_write stripping and unit tests.
 */

const STRIP_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g;

export function hasRelevantMemories(text: string | undefined | null): boolean {
  return typeof text === "string" && text.includes("<relevant-memories>");
}

/** Strip all <relevant-memories>...</relevant-memories> blocks from a string. */
export function stripRelevantMemories(text: string): string {
  if (!hasRelevantMemories(text)) return text;
  return text.replace(STRIP_RE, "").trim();
}

/**
 * Strip relevant-memories from a user message content field
 * (string or OpenClaw multipart parts array).
 * Returns undefined if nothing changed.
 */
export function stripRelevantMemoriesFromContent(
  content: unknown,
): { content: unknown; strippedChars: number } | undefined {
  if (typeof content === "string") {
    if (!hasRelevantMemories(content)) return undefined;
    const cleaned = stripRelevantMemories(content);
    if (cleaned === content) return undefined;
    return { content: cleaned, strippedChars: content.length - cleaned.length };
  }

  if (Array.isArray(content)) {
    let total = 0;
    const parts = (content as Array<Record<string, unknown>>).map((part) => {
      if (part.type !== "text" || typeof part.text !== "string") return part;
      if (!hasRelevantMemories(part.text as string)) return part;
      const cleaned = stripRelevantMemories(part.text as string);
      total += (part.text as string).length - cleaned.length;
      return { ...part, text: cleaned };
    });
    if (total === 0) return undefined;
    return { content: parts, strippedChars: total };
  }

  return undefined;
}
