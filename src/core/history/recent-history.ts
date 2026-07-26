/**
 * Recent History — Circular buffer for the most recent N conversation turns.
 *
 * Stores pure conversation (User / Assistant messages) with NO injected
 * content.  When the buffer reaches capacity, the oldest turns are evicted
 * and should be compressed into the stable history before eviction.
 *
 * The content produced by `getContent()` is placed AFTER CACHE_BOUNDARY
 * (in `prependContext`) so it doesn't occlude the stable prefix.
 */

export interface TurnEntry {
  role: "user" | "assistant";
  content: string;
}

export interface RecentHistoryConfig {
  /** Maximum number of turns to keep (default: 8). */
  maxTurns: number;
}

export class RecentHistory {
  private buffer: TurnEntry[] = [];
  private maxTurns: number;

  constructor(config: RecentHistoryConfig) {
    this.maxTurns = Math.max(1, config.maxTurns);
  }

  /** Add a turn. If buffer is full, evicts the oldest entry. */
  addTurn(role: "user" | "assistant", content: string): TurnEntry | undefined {
    let evicted: TurnEntry | undefined;
    if (this.buffer.length >= this.maxTurns) {
      evicted = this.buffer.shift();
    }
    this.buffer.push({ role, content });
    return evicted;
  }

  /** Whether the buffer has reached capacity. */
  isFull(): boolean {
    return this.buffer.length >= this.maxTurns;
  }

  /** Current number of turns in the buffer. */
  size(): number {
    return this.buffer.length;
  }

  /** Maximum capacity. */
  capacity(): number {
    return this.maxTurns;
  }

  /**
   * Get the formatted recent conversation block.
   *
   * Format:
   *   <recent-conversation>
   *   ## 最近的对话（最新在前）
   *   [用户] ...
   *   [助手] ...
   *   </recent-conversation>
   */
  getContent(): string {
    if (this.buffer.length === 0) return "";

    const parts: string[] = [];
    parts.push("<recent-conversation>");
    parts.push("## 最近的对话（最新在前）");

    // Reverse so newest turns appear first (stable sorting for cache)
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const turn = this.buffer[i];
      const roleLabel = turn.role === "user" ? "用户" : "助手";
      const truncated = truncateContent(turn.content, 500);
      parts.push(`[${roleLabel}] ${truncated}`);
    }

    parts.push("</recent-conversation>");
    return parts.join("\n");
  }

  /** Get all turns currently in the buffer (oldest first). */
  getTurns(): TurnEntry[] {
    return [...this.buffer];
  }

  /** Clear all turns. */
  clear(): void {
    this.buffer = [];
  }

  /** Update max capacity (truncates from front if new capacity is smaller). */
  resize(newMax: number): void {
    this.maxTurns = Math.max(1, newMax);
    while (this.buffer.length > this.maxTurns) {
      this.buffer.shift();
    }
  }
}

function truncateContent(content: string, maxChars: number): string {
  if (!content) return "";
  const cps = Array.from(content);
  if (cps.length <= maxChars) return content;
  return cps.slice(0, maxChars - 3).join("") + "...";
}
