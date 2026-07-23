export const GENERATED_RECALL_MARKER =
  "以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：";

const RELEVANT_MEMORIES_OPEN = "<relevant-memories>";
const RELEVANT_MEMORIES_CLOSE = "</relevant-memories>";
const INJECTED_SEPARATOR = "\n\n";
const INJECTED_SEPARATOR_CRLF = "\r\n\r\n";
const GENERATED_RECALL_PREFIX = `${RELEVANT_MEMORIES_OPEN}\n${GENERATED_RECALL_MARKER}`;

function escapeRecallDelimiters(value: string): string {
  return value
    .replaceAll(RELEVANT_MEMORIES_OPEN, "&lt;relevant-memories&gt;")
    .replaceAll(RELEVANT_MEMORIES_CLOSE, "&lt;/relevant-memories&gt;");
}

export function buildGeneratedRecallContext(memoryLines: readonly string[]): string | undefined {
  if (memoryLines.length === 0) return undefined;
  const escapedLines = memoryLines.map(escapeRecallDelimiters);
  return `${RELEVANT_MEMORIES_OPEN}\n${GENERATED_RECALL_MARKER}\n\n${escapedLines.join("\n")}\n${RELEVANT_MEMORIES_CLOSE}`;
}

export interface StripInjectedRecallTextResult {
  text: string;
  strippedChars: number;
}

export type GeneratedRecallPlacement = "prepend" | "append";

function stripExactGeneratedRecallText(
  text: string,
  generatedContext: string,
  placement: GeneratedRecallPlacement,
): StripInjectedRecallTextResult | undefined {
  if (!generatedContext) return undefined;

  let removeStart = placement === "prepend"
    ? text.indexOf(generatedContext)
    : text.lastIndexOf(generatedContext);
  if (removeStart < 0) return undefined;

  let removeEnd = removeStart + generatedContext.length;
  if (placement === "prepend") {
    if (text.startsWith(INJECTED_SEPARATOR_CRLF, removeEnd)) {
      removeEnd += INJECTED_SEPARATOR_CRLF.length;
    } else if (text.startsWith(INJECTED_SEPARATOR, removeEnd)) {
      removeEnd += INJECTED_SEPARATOR.length;
    }
  } else if (
    text.slice(removeStart - INJECTED_SEPARATOR_CRLF.length, removeStart) ===
    INJECTED_SEPARATOR_CRLF
  ) {
    removeStart -= INJECTED_SEPARATOR_CRLF.length;
  } else if (
    text.slice(removeStart - INJECTED_SEPARATOR.length, removeStart) === INJECTED_SEPARATOR
  ) {
    removeStart -= INJECTED_SEPARATOR.length;
  }

  const cleaned = `${text.slice(0, removeStart)}${text.slice(removeEnd)}`;
  return {
    text: cleaned,
    strippedChars: text.length - cleaned.length,
  };
}

export function stripInjectedRecallText(
  text: string,
  placement: GeneratedRecallPlacement = "prepend",
  generatedContext?: string,
): StripInjectedRecallTextResult | undefined {
  if (generatedContext) {
    return stripExactGeneratedRecallText(text, generatedContext, placement);
  }

  let removeStart: number;
  if (placement === "prepend") {
    if (!text.startsWith(GENERATED_RECALL_PREFIX)) return undefined;
    removeStart = 0;
  } else {
    removeStart = text.lastIndexOf(GENERATED_RECALL_PREFIX);
    if (removeStart < 0) return undefined;
  }

  const closingIndex = text.indexOf(RELEVANT_MEMORIES_CLOSE, removeStart + GENERATED_RECALL_PREFIX.length);
  if (closingIndex < 0) return undefined;

  let removeEnd = closingIndex + RELEVANT_MEMORIES_CLOSE.length;
  if (placement === "append" && removeEnd !== text.length) return undefined;

  if (placement === "prepend") {
    if (text.startsWith(INJECTED_SEPARATOR_CRLF, removeEnd)) {
      removeEnd += INJECTED_SEPARATOR_CRLF.length;
    } else if (text.startsWith(INJECTED_SEPARATOR, removeEnd)) {
      removeEnd += INJECTED_SEPARATOR.length;
    }
  } else if (
    text.slice(removeStart - INJECTED_SEPARATOR_CRLF.length, removeStart) ===
    INJECTED_SEPARATOR_CRLF
  ) {
    removeStart -= INJECTED_SEPARATOR_CRLF.length;
  } else if (
    text.slice(removeStart - INJECTED_SEPARATOR.length, removeStart) === INJECTED_SEPARATOR
  ) {
    removeStart -= INJECTED_SEPARATOR.length;
  }

  const cleaned = `${text.slice(0, removeStart)}${text.slice(removeEnd)}`;
  return {
    text: cleaned,
    strippedChars: text.length - cleaned.length,
  };
}

export interface StripInjectedRecallMessageResult<
  TMessage extends { role?: string; content?: unknown },
> {
  message: TMessage;
  strippedChars: number;
  contentType: "string" | "parts";
}

export function stripInjectedRecallFromMessage<
  TMessage extends { role?: string; content?: unknown },
>(
  message: TMessage,
  options: {
    generatedContext?: string;
    showInjected?: boolean;
    placement?: GeneratedRecallPlacement;
  } = {},
): StripInjectedRecallMessageResult<TMessage> | undefined {
  if (options.showInjected || message.role !== "user") return undefined;

  if (typeof message.content === "string") {
    const stripped = stripInjectedRecallText(
      message.content,
      options.placement,
      options.generatedContext,
    );
    if (!stripped) return undefined;
    return {
      message: { ...message, content: stripped.text } as TMessage,
      strippedChars: stripped.strippedChars,
      contentType: "string",
    };
  }

  if (!Array.isArray(message.content)) return undefined;

  let strippedChars = 0;
  const cleanedParts = message.content.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const part = item as Record<string, unknown>;
    if (part.type !== "text" || typeof part.text !== "string") return item;
    const stripped = stripInjectedRecallText(
      part.text,
      options.placement,
      options.generatedContext,
    );
    if (!stripped) return item;
    strippedChars += stripped.strippedChars;
    return { ...part, text: stripped.text };
  });

  if (strippedChars === 0) return undefined;
  return {
    message: { ...message, content: cleanedParts } as TMessage,
    strippedChars,
    contentType: "parts",
  };
}
