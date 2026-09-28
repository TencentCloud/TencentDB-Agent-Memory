/**
 * Pure helpers for the Pi adapter — kept dependency-free so they can be
 * unit-tested without the Pi runtime (`@earendil-works/pi-coding-agent`
 * and `typebox` are provided by Pi when the extension is loaded, and are
 * intentionally not dependencies of this repository).
 */

/** Minimal structural view of a Pi AgentMessage for capture purposes. */
export interface MessageLike {
  role?: string;
  content?: unknown;
}

/** Flatten a message content field (string or content-block array) to plain text. */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        return (block as { text?: string }).text ?? "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Extract the round to capture from an `agent_end` messages array:
 * the last real user message and every assistant text after it.
 *
 * Custom messages (role "custom", e.g. the adapter's own recall injection)
 * and toolResult messages are excluded — the Gateway's L1 extraction works
 * on the dialogue itself, and echoing recalled memories back into /capture
 * would create feedback loops.
 */
export function extractRound(messages: MessageLike[]): {
  userContent: string;
  assistantContent: string;
} {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex === -1) return { userContent: "", assistantContent: "" };

  const userContent = contentToText(messages[lastUserIndex]?.content);
  const assistantParts: string[] = [];
  for (let i = lastUserIndex + 1; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role === "assistant") {
      const text = contentToText(message.content);
      if (text) assistantParts.push(text);
    }
  }
  return { userContent, assistantContent: assistantParts.join("\n") };
}
