const RELEVANT_MEMORIES_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g;

export function stripRelevantMemoriesFromText(text: string): string {
  if (!text.includes("<relevant-memories>")) return text;
  return text.replace(RELEVANT_MEMORIES_RE, "").trim();
}

export function stripRelevantMemoriesFromContentParts<T extends Record<string, unknown>>(
  parts: T[],
): { parts: T[]; strippedChars: number } {
  let strippedChars = 0;
  const cleanedParts = parts.map((part) => {
    if (part.type !== "text" || typeof part.text !== "string") return part;
    const original = part.text;
    const cleaned = stripRelevantMemoriesFromText(original);
    strippedChars += original.length - cleaned.length;
    return cleaned === original ? part : { ...part, text: cleaned };
  });
  return { parts: cleanedParts, strippedChars };
}
