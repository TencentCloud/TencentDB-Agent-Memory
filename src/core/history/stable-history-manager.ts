/**
 * Stable History Manager — Append-only compressed summaries.
 *
 * Key design property: new `<epoch>` blocks are **appended** to the end;
 * existing content is **never rewritten**.  This keeps the prefix byte-
 * identical across turns, which is required for DeepSeek's byte-level
 * prefix-matching prompt cache.
 *
 * Additionally supports deduplication: before appending a high-frequency
 * L1 memory, `containsMemory()` / `appendMemoryIfNotExists()` ensure the
 * content isn't already present in the stable history.
 *
 * Layout (before CACHE_BOUNDARY → cached):
 *   <conversation-summaries>
 *   ## 早期对话摘要
 *   <epoch id="1" turns="1-8">summary text</epoch>
 *   <epoch id="2" turns="9-16">summary text</epoch>
 *   <!-- L1 memories persisted into stable history -->
 *   <persisted-memories>
 *   <memory>content</memory>
 *   </persisted-memories>
 *   </conversation-summaries>
 */

export interface StableHistoryManagerConfig {
  /** Maximum number of memory entries to persist (default: 20). */
  maxPersistedMemories?: number;
}

export class StableHistoryManager {
  private epochs: string[] = [];
  private persistedMemories: string[] = [];
  private epochCounter = 0;
  private maxPersistedMemories: number;

  constructor(config: StableHistoryManagerConfig = {}) {
    this.maxPersistedMemories = config.maxPersistedMemories ?? 20;
  }

  /** Get the full stable history content for system prompt injection. */
  getContent(): string {
    if (this.epochs.length === 0 && this.persistedMemories.length === 0) {
      return "";
    }

    const parts: string[] = [];
    parts.push("<conversation-summaries>");
    parts.push("## 早期对话摘要");

    for (const epoch of this.epochs) {
      parts.push(epoch);
    }

    if (this.persistedMemories.length > 0) {
      parts.push("<persisted-memories>");
      for (const mem of this.persistedMemories) {
        parts.push(`<memory>${mem}</memory>`);
      }
      parts.push("</persisted-memories>");
    }

    parts.push("</conversation-summaries>");
    return parts.join("\n");
  }

  /**
   * Append a new epoch summary.
   *
   * The epoch is tagged with an incrementing ID so it is always unique
   * on first write but byte-identical on subsequent reads.
   */
  appendEpoch(summary: string, turnRange?: { start: number; end: number }): void {
    this.epochCounter++;
    const range = turnRange
      ? ` turns="${turnRange.start}-${turnRange.end}"`
      : "";
    const epoch = `<epoch id="${this.epochCounter}"${range}>${summary}</epoch>`;
    this.epochs.push(epoch);
  }

  /** Number of epochs. */
  epochCount(): number {
    return this.epochs.length;
  }

  /** Check whether a memory content string already exists in persisted memories. */
  containsMemory(content: string): boolean {
    const normalized = content.trim();
    return this.persistedMemories.some((m) => m.trim() === normalized);
  }

  /**
   * Append a memory to the persisted-memories block if it doesn't already
   * exist. Returns true if appended, false if it was a duplicate.
   */
  appendMemoryIfNotExists(content: string): boolean {
    if (this.containsMemory(content)) return false;

    this.persistedMemories.push(content.trim());

    // Evict oldest if over capacity
    while (this.persistedMemories.length > this.maxPersistedMemories) {
      this.persistedMemories.shift();
    }

    return true;
  }

  /** Get the total character count of the stable history (for window calculation). */
  charCount(): number {
    return this.getContent().length;
  }

  /** Reset all state. */
  clear(): void {
    this.epochs = [];
    this.persistedMemories = [];
    this.epochCounter = 0;
  }
}

/**
 * Generate a summary prompt for a batch of conversation turns.
 * Callers with access to an LLM runner can use this to produce the
 * actual summary text, then call `appendEpoch()` with the result.
 */
export function buildCompressionPrompt(
  turns: Array<{ role: string; content: string }>,
): string {
  const lines = turns.map((t) => {
    const roleLabel = t.role === "user" ? "用户" : "助手";
    return `[${roleLabel}] ${truncateForSummary(t.content, 300)}`;
  });

  return [
    "请用1-2句话总结以下对话片段，保留关键信息（人物、事件、决定、偏好）：",
    "",
    lines.join("\n"),
    "",
    "总结：",
  ].join("\n");
}

function truncateForSummary(content: string, maxChars: number): string {
  if (!content) return "";
  const cps = Array.from(content);
  if (cps.length <= maxChars) return content;
  return cps.slice(0, maxChars - 3).join("") + "...";
}
