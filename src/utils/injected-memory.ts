const RELEVANT_MEMORIES_RE = /<relevant-memories\b[^>]*>[\s\S]*?<\/relevant-memories>\s*/gi;

type MessageContent = string | Array<Record<string, unknown>> | unknown;

export interface InjectedHistoryEstimate {
  beforeChars: number;
  afterChars: number;
  removedChars: number;
  removedBlocks: number;
}

export interface PrefixReuseEstimate {
  prefixChars: number;
  comparableChars: number;
  reuseRatio: number;
}

export function stripInjectedRelevantMemoriesFromText(text: string): string {
  return text.replace(RELEVANT_MEMORIES_RE, "").trim();
}

export function stripInjectedRelevantMemoriesFromContent(content: MessageContent): MessageContent {
  if (typeof content === "string") {
    if (!hasInjectedRelevantMemories(content)) return content;
    return stripInjectedRelevantMemoriesFromText(content);
  }

  if (!Array.isArray(content)) return content;

  let changed = false;
  const cleanedParts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      cleanedParts.push(part);
      continue;
    }
    if (part.type !== "text" || typeof part.text !== "string") {
      cleanedParts.push(part);
      continue;
    }
    if (!hasInjectedRelevantMemories(part.text)) {
      cleanedParts.push(part);
      continue;
    }

    changed = true;
    const cleanedText = stripInjectedRelevantMemoriesFromText(part.text);
    if (cleanedText.length > 0) {
      cleanedParts.push({ ...part, text: cleanedText });
    }
  }

  return changed ? cleanedParts : content;
}

export function hasInjectedRelevantMemories(text: string): boolean {
  RELEVANT_MEMORIES_RE.lastIndex = 0;
  return RELEVANT_MEMORIES_RE.test(text);
}

export function countInjectedRelevantMemoryBlocks(text: string): number {
  RELEVANT_MEMORIES_RE.lastIndex = 0;
  return [...text.matchAll(RELEVANT_MEMORIES_RE)].length;
}

export function estimateInjectedHistoryChars(messages: Array<{ role?: unknown; content?: unknown }>): InjectedHistoryEstimate {
  let beforeChars = 0;
  let afterChars = 0;
  let removedBlocks = 0;

  for (const message of messages) {
    const before = contentToText(message.content);
    if (!before) continue;
    beforeChars += before.length;

    if (message.role === "user") {
      removedBlocks += countInjectedRelevantMemoryBlocks(before);
      const stripped = stripInjectedRelevantMemoriesFromContent(message.content);
      afterChars += contentToText(stripped).length;
    } else {
      afterChars += before.length;
    }
  }

  return {
    beforeChars,
    afterChars,
    removedChars: beforeChars - afterChars,
    removedBlocks,
  };
}

export function commonPrefixChars(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

export function estimatePrefixReuse(previousPrompt: string, currentPrompt: string): PrefixReuseEstimate {
  const comparableChars = Math.max(1, Math.min(previousPrompt.length, currentPrompt.length));
  const prefixChars = commonPrefixChars(previousPrompt, currentPrompt);
  return {
    prefixChars,
    comparableChars,
    reuseRatio: prefixChars / comparableChars,
  };
}

export function measureMessageContentChars(content: unknown): number {
  return contentToText(content).length;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      (part as Record<string, unknown>).type === "text" &&
      typeof (part as Record<string, unknown>).text === "string"
    ) {
      parts.push((part as Record<string, string>).text);
    }
  }
  return parts.join("\n");
}
