const GENERATED_RECALL_MARKER = "以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：";
const GENERATED_RECALL_RE = new RegExp(
  `<relevant-memories>\\s*${escapeRegExp(GENERATED_RECALL_MARKER)}[\\s\\S]*?<\\/relevant-memories>\\s*`,
  "g",
);

export interface StripInjectedRecallOptions {
  showInjected?: boolean;
}

export interface StripInjectedRecallTextResult {
  text: string;
  strippedChars: number;
}

export interface StripInjectedRecallMessageResult<T> {
  message: T;
  strippedChars: number;
}

export function stripInjectedRecallText(text: string): StripInjectedRecallTextResult | undefined {
  if (!text.includes("<relevant-memories>") || !text.includes(GENERATED_RECALL_MARKER)) {
    return undefined;
  }

  const cleaned = text.replace(GENERATED_RECALL_RE, "").trim();
  if (cleaned === text) return undefined;
  return { text: cleaned, strippedChars: text.length - cleaned.length };
}

export function stripInjectedRecallFromMessage<T extends { role?: string; content?: unknown }>(
  message: T,
  options: StripInjectedRecallOptions = {},
): StripInjectedRecallMessageResult<T> | undefined {
  if (options.showInjected || message.role !== "user") return undefined;

  if (typeof message.content === "string") {
    const stripped = stripInjectedRecallText(message.content);
    if (!stripped) return undefined;
    return {
      message: { ...message, content: stripped.text } as T,
      strippedChars: stripped.strippedChars,
    };
  }

  if (!Array.isArray(message.content)) return undefined;

  let strippedChars = 0;
  const cleanedParts = message.content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const item = part as Record<string, unknown>;
    if (item.type !== "text" || typeof item.text !== "string") return part;

    const stripped = stripInjectedRecallText(item.text);
    if (!stripped) return part;
    strippedChars += stripped.strippedChars;
    return { ...item, text: stripped.text };
  });

  if (strippedChars === 0) return undefined;
  return {
    message: { ...message, content: cleanedParts } as T,
    strippedChars,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
