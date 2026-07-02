const RELEVANT_MEMORIES_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g;

type TextPart = Record<string, unknown> & { type?: unknown; text?: unknown };

export function stripRelevantMemoriesFromText(text: string): { text: string; removedChars: number } {
  if (!text.includes("<relevant-memories>")) {
    return { text, removedChars: 0 };
  }

  const cleaned = text.replace(RELEVANT_MEMORIES_RE, "").trim();
  return { text: cleaned, removedChars: text.length - cleaned.length };
}

export function stripRelevantMemoriesFromMessage<T extends { role?: string; content?: unknown }>(
  message: T,
): { message: T; removedChars: number } | undefined {
  if (message.role !== "user") return undefined;

  if (typeof message.content === "string") {
    const result = stripRelevantMemoriesFromText(message.content);
    if (result.removedChars <= 0 || result.text === message.content) return undefined;
    return {
      message: { ...message, content: result.text },
      removedChars: result.removedChars,
    };
  }

  if (!Array.isArray(message.content)) return undefined;

  let removedChars = 0;
  const cleanedParts = (message.content as TextPart[]).map((part) => {
    if (part.type !== "text" || typeof part.text !== "string") return part;
    const result = stripRelevantMemoriesFromText(part.text);
    if (result.removedChars <= 0) return part;
    removedChars += result.removedChars;
    return { ...part, text: result.text };
  });

  if (removedChars <= 0) return undefined;
  return {
    message: { ...message, content: cleanedParts },
    removedChars,
  };
}
