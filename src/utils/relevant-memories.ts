/**
 * Helpers for stripping <relevant-memories>...</relevant-memories> blocks
 * from user messages before they are persisted, so recalled-memory injections
 * don't bloat the frozen conversation history (which would push prefix-matching
 * caches toward more truncation jitter).
 */

// /g is used only with String.replace (which resets lastIndex); never call
// .test/.exec on this instance.
const RELEVANT_MEMORIES_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g;

/** Remove all <relevant-memories> blocks (and trailing whitespace), then trim. */
export function stripRelevantMemories(text: string): string {
  return text.replace(RELEVANT_MEMORIES_RE, "").trim();
}

/** Quick check so callers can skip when there is nothing to strip. */
export function hasRelevantMemories(text: string): boolean {
  return text.includes("<relevant-memories>");
}
