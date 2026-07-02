/**
 * recall-injection: utilities for managing injected <relevant-memories>
 * content in persisted conversation history.
 *
 * When prependContextEnabled is true, recalled L1 memories are injected into
 * the user message as a <relevant-memories> block.  This module provides
 * a type-safe function to strip that block before messages are written to
 * session storage, keeping historical transcripts clean and prompt-cache
 * prefixes stable across turns.
 */

// Regex matches the <relevant-memories> tag, any content (lazy), the close tag,
// and any trailing whitespace — all in one pass to minimize string operations.
const RELEVANT_MEMORIES_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g;

/** Minimal shape of a message we can operate on. */
export interface MessageLike {
  role?: string;
  content?: unknown;
}

/**
 * Strip injected <relevant-memories> blocks from a user message.
 *
 * Returns a shallow copy of the message with `content` cleaned, or `undefined`
 * when no stripping was needed (message is not a user role, or content does
 * not contain a <relevant-memories> tag).
 *
 * Handles two content shapes:
 * - **string**: direct text content — run a global replace.
 * - **TextContent[]**: array of typed parts — only `{ type: "text", text }`
 *   parts are scanned; image/content parts pass through untouched.
 *
 * @example
 * const cleaned = stripInjectedRecallFromMessage(rawMsg);
 * if (cleaned) { /* write cleaned instead of rawMsg *\/ }
 */
export function stripInjectedRecallFromMessage<T extends MessageLike>(
  msg: T,
): T | undefined {
  // Only user messages carry injected recall content.
  if (msg.role !== "user") return undefined;

  const content = msg.content;

  // ── String content ──
  if (typeof content === "string") {
    // Fast path: avoid regex when no tag is present.
    if (!content.includes("<relevant-memories>")) return undefined;

    const cleaned = content.replace(RELEVANT_MEMORIES_RE, "").trim();
    if (cleaned === content) return undefined;

    return { ...msg, content: cleaned };
  }

  // ── Part-based content (TextContent[], ImageContent[], etc.) ──
  if (Array.isArray(content)) {
    let totalStripped = 0;
    const cleanedParts = content.map((part) => {
      // Only process text parts — skip images, tool results, etc.
      if (typeof part !== "object" || part === null) return part;
      const typedPart = part as Record<string, unknown>;
      if (typedPart.type !== "text") return part;

      const text = typedPart.text;
      if (typeof text !== "string") return part;
      if (!text.includes("<relevant-memories>")) return part;

      const cleaned = text.replace(RELEVANT_MEMORIES_RE, "").trim();
      totalStripped += text.length - cleaned.length;
      return { ...typedPart, text: cleaned } as unknown as typeof part;
    });

    if (totalStripped === 0) return undefined;

    return { ...msg, content: cleanedParts };
  }

  // Unknown content type — leave untouched.
  return undefined;
}

/**
 * Low-level helper: strip <relevant-memories> from a plain text string.
 *
 * Useful when you already have the text content extracted and just need
 * the replacement, without going through the full MessageLike interface.
 *
 * @example
 * const clean = stripInjectedRecallText("...<relevant-memories>...</> hello");
 * // Returns "hello"
 */
export function stripInjectedRecallText(text: string): string {
  if (!text.includes("<relevant-memories>")) return text;
  return text.replace(RELEVANT_MEMORIES_RE, "").trim();
}
