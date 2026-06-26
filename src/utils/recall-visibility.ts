const RELEVANT_MEMORIES_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g;

export interface StripRelevantMemoriesOptions {
  showInjected: boolean;
}

export interface StripRelevantMemoriesResult<T = unknown> {
  content: T;
  changed: boolean;
  removedChars: number;
}

export function stripRelevantMemoriesFromContent<T>(
  content: T,
  options: StripRelevantMemoriesOptions,
): StripRelevantMemoriesResult<T> {
  if (options.showInjected) {
    return { content, changed: false, removedChars: 0 };
  }

  if (typeof content === "string") {
    if (!content.includes("<relevant-memories>")) {
      return { content, changed: false, removedChars: 0 };
    }
    const cleaned = content.replace(RELEVANT_MEMORIES_RE, "").trim();
    return {
      content: cleaned as T,
      changed: cleaned !== content,
      removedChars: content.length - cleaned.length,
    };
  }

  if (Array.isArray(content)) {
    let removedChars = 0;
    const cleanedParts = content.map((part) => {
      if (!isTextPart(part) || !part.text.includes("<relevant-memories>")) return part;
      const cleaned = part.text.replace(RELEVANT_MEMORIES_RE, "").trim();
      removedChars += part.text.length - cleaned.length;
      return { ...part, text: cleaned };
    });

    return {
      content: cleanedParts as T,
      changed: removedChars > 0,
      removedChars,
    };
  }

  return { content, changed: false, removedChars: 0 };
}

function isTextPart(part: unknown): part is { type: string; text: string } {
  return (
    !!part &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
  );
}
