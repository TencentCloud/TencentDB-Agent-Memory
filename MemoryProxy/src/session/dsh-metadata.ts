/**
 * Returns whether content is metadata injected by DeepSeek Harness (dsh).
 *
 * dsh sends these blocks as role=user messages alongside the user's first
 * prompt. They must not be treated as conversation history by session-init
 * recovery, or a brand-new session is incorrectly bypassed.
 */
export function isDshMetadataContent(content: unknown): boolean {
  if (typeof content !== "string") return false;

  return (
    content.startsWith("<system-reminder>") ||
    content.startsWith("Current runtime context.") ||
    content.startsWith("<skill_content")
  );
}
