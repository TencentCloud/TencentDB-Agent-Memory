/**
 * Utilities for keeping memory-injected prompts friendly to provider prefix
 * caches. Dynamic L1 recall belongs in the current user turn, but historical
 * copies of that recall block should collapse to a stable marker.
 */

export const MEMORY_OMITTED_MARKER = '<memory-omitted reason="prevent_context_bloat" />';

const RELEVANT_MEMORIES_BLOCK_RE = /<relevant-memories\b[^>]*>[\s\S]*?<\/relevant-memories>\s*/gi;

export interface PromptCacheMessage {
  role?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

export interface CompactTextResult {
  text: string;
  changed: boolean;
  removedChars: number;
}

export interface CompactMessageResult<T extends PromptCacheMessage> {
  message: T;
  changed: boolean;
  textPartsChanged: number;
  removedChars: number;
}

export interface PromptCachePreparation<T extends PromptCacheMessage> {
  messages: T[];
  compacted: {
    messagesChanged: number;
    textPartsChanged: number;
    removedChars: number;
  };
  dedupedSystemMessages: number;
}

export function compactRelevantMemoriesText(
  text: string,
  marker = MEMORY_OMITTED_MARKER,
): CompactTextResult {
  if (!/<relevant-memories\b/i.test(text)) {
    return { text, changed: false, removedChars: 0 };
  }

  const compacted = text
    .replace(RELEVANT_MEMORIES_BLOCK_RE, `${marker}\n`)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    text: compacted,
    changed: compacted !== text,
    removedChars: Math.max(0, text.length - compacted.length),
  };
}

export function compactRelevantMemoriesInMessage<T extends PromptCacheMessage>(
  message: T,
  marker = MEMORY_OMITTED_MARKER,
): CompactMessageResult<T> {
  const content = message.content;

  if (typeof content === "string") {
    const result = compactRelevantMemoriesText(content, marker);
    if (!result.changed) {
      return { message, changed: false, textPartsChanged: 0, removedChars: 0 };
    }
    return {
      message: { ...message, content: result.text } as T,
      changed: true,
      textPartsChanged: 1,
      removedChars: result.removedChars,
    };
  }

  if (!Array.isArray(content)) {
    return { message, changed: false, textPartsChanged: 0, removedChars: 0 };
  }

  let changed = false;
  let textPartsChanged = 0;
  let removedChars = 0;
  const compactedParts = content.map((part) => {
    if (!isTextPart(part)) return part;
    const result = compactRelevantMemoriesText(part.text, marker);
    if (!result.changed) return part;

    changed = true;
    textPartsChanged += 1;
    removedChars += result.removedChars;
    return { ...part, text: result.text };
  });

  if (!changed) {
    return { message, changed: false, textPartsChanged: 0, removedChars: 0 };
  }

  return {
    message: { ...message, content: compactedParts } as T,
    changed: true,
    textPartsChanged,
    removedChars,
  };
}

export function prepareMessagesForPromptCache<T extends PromptCacheMessage>(
  messages: readonly T[],
): PromptCachePreparation<T> {
  let messagesChanged = 0;
  let textPartsChanged = 0;
  let removedChars = 0;

  const compactedMessages = messages.map((message) => {
    const result = compactRelevantMemoriesInMessage(message);
    if (result.changed) {
      messagesChanged += 1;
      textPartsChanged += result.textPartsChanged;
      removedChars += result.removedChars;
    }
    return result.message;
  });

  const dedupedMessages = dedupeSystemMessages(compactedMessages);

  return {
    messages: dedupedMessages.messages,
    compacted: { messagesChanged, textPartsChanged, removedChars },
    dedupedSystemMessages: dedupedMessages.removed,
  };
}

function dedupeSystemMessages<T extends PromptCacheMessage>(
  messages: readonly T[],
): { messages: T[]; removed: number } {
  const seen = new Set<string>();
  const deduped: T[] = [];
  let removed = 0;

  for (const message of messages) {
    if (message.role !== "system") {
      deduped.push(message);
      continue;
    }

    const fingerprint = systemMessageFingerprint(message.content);
    if (!fingerprint) {
      deduped.push(message);
      continue;
    }

    if (seen.has(fingerprint)) {
      removed += 1;
      continue;
    }

    seen.add(fingerprint);
    deduped.push(message);
  }

  return { messages: deduped, removed };
}

function systemMessageFingerprint(content: unknown): string | undefined {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed ? trimmed : undefined;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .filter(isTextPart)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n");

  return text || undefined;
}

function isTextPart(part: unknown): part is { type: "text"; text: string; [key: string]: unknown } {
  return Boolean(
    part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string",
  );
}
