const RELEVANT_MEMORIES_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g;

export type MessageWithContent = {
  role?: string;
  content?: unknown;
};

/**
 * Remove auto-recall prompt artifacts before user messages are persisted.
 * The current LLM turn has already seen the injected context; this keeps
 * historical transcripts clean unless recall.showInjected is enabled.
 */
export function stripInjectedRecallFromMessage<T extends MessageWithContent>(
  message: T,
): { message: T; strippedChars: number } | undefined {
  if (message.role !== "user") return undefined;

  if (typeof message.content === "string") {
    const cleaned = stripInjectedRecallText(message.content);
    if (cleaned === message.content) return undefined;
    return {
      message: { ...message, content: cleaned },
      strippedChars: message.content.length - cleaned.length,
    };
  }

  if (!Array.isArray(message.content)) return undefined;

  let strippedChars = 0;
  const cleanedParts = (message.content as Array<Record<string, unknown>>).map((part) => {
    if (part.type !== "text" || typeof part.text !== "string") return part;
    const cleaned = stripInjectedRecallText(part.text);
    strippedChars += part.text.length - cleaned.length;
    return cleaned === part.text ? part : { ...part, text: cleaned };
  });

  if (strippedChars === 0) return undefined;
  return {
    message: { ...message, content: cleanedParts },
    strippedChars,
  };
}

export function stripInjectedRecallText(text: string): string {
  if (!text.includes("<relevant-memories>")) return text;
  return text.replace(RELEVANT_MEMORIES_RE, "").trim();
}
