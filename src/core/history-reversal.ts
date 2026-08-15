/**
 * History Reversal & Progressive Compression
 *
 * For long conversations, the framework's own history rendering grows large
 * enough to trigger tool-result truncation. Truncation shifts every turn,
 * which changes the prompt prefix → DeepSeek prefix cache always misses.
 *
 * This module builds a two-part conversation-history block:
 *
 *   summaryBlock (→ prependSystemContext, BEFORE CACHE_BOUNDARY → CACHED):
 *     Compressed summaries of older messages. These are stable between
 *     compression events (every chunkSize turns), so they stay in the
 *     prompt-cache region and contribute to cache hit tokens.
 *
 *   recentBlock (→ prependContext, at end of user message → not cached):
 *     Most recent N messages, newest first. Changes per-turn but placed
 *     at the tail where it doesn't affect the prefix cache.
 *
 * Key insight (from exp-readme.md §2.3 "遮挡效应"):
 *   Cache hit rate = (bytes before first per-turn diff) / total bytes.
 *   Putting stable summaries BEFORE the volatile tail (in the system prompt)
 *   makes them visible to the cache engine. Putting dynamic recent messages
 *   AFTER the volatile tail (in the user message) keeps them from occluding
 *   the stable prefix.
 */

export interface HistoryReversalConfig {
  /** Feature toggle (default: false for backward compatibility). */
  enabled: boolean;
  /**
   * Number of recent messages to keep verbatim, counting from the most
   * recent backward. These form the stable cache prefix. (Default: 15)
   */
  keepRecent: number;
  /**
   * Trigger compression when the total message count exceeds this
   * threshold. (Default: 30)
   */
  compressAfter: number;
  /**
   * Number of messages per compression chunk when building summaries.
   * (Default: 10)
   */
  chunkSize: number;
  /**
   * Maximum token budget per compressed summary chunk. Actual
   * implementation may estimate via character count. (Default: 300)
   */
  maxSummaryTokens: number;
}

/** A minimal message representation for history building. */
export interface ConversationMessage {
  role: string;
  content: string;
  timestamp?: number;
  /** Optional tool call / tool result metadata for richer summaries. */
  toolCallId?: string;
  toolName?: string;
}

export interface ReversedHistoryResult {
  /**
   * Stable summary block for prependSystemContext (before CACHE_BOUNDARY).
   * Contains only compressed summaries of older messages — changes only on
   * compression events (every chunkSize turns). Placed in the system prompt
   * to stay in the cached region.
   */
  summaryBlock: string;
  /**
   * Dynamic recent-messages block for prependContext (at end of user message).
   * Most recent N messages, newest first. Changes per-turn but placed at the
   * prompt tail so it doesn't occlude the stable prefix.
   */
  recentBlock: string;
  /**
   * Combined history block (summaryBlock + recentBlock) for backward compat.
   * @deprecated Prefer using summaryBlock + recentBlock separately.
   */
  historyBlock: string;
  /** Number of messages compressed in this turn. */
  compressedCount: number;
  /** Total messages processed. */
  totalMessages: number;
  /** Whether compression was triggered. */
  didCompress: boolean;
}

/**
 * Build a reversed-history block from conversation messages.
 *
 * Layout (summaries FIRST for cache, recent messages LAST for dynamism):
 *   <conversation-history>
 *   ## 早期对话摘要
 *   <summary>...</summary>
 *   ...
 *   ## 最近的对话（最新在前）
 *   [Turn N] ...
 *   [Turn N-1] ...
 *   </conversation-history>
 *
 * The summary section is stable between compression events and can be
 * placed in prependSystemContext for caching. The recent section changes
 * per-turn and belongs in prependContext at the prompt tail.
 */
export function buildReversedHistory(
  messages: ConversationMessage[],
  config: HistoryReversalConfig,
  existingSummaries?: string[],
): ReversedHistoryResult {
  const emptyResult: ReversedHistoryResult = {
    summaryBlock: "", recentBlock: "", historyBlock: "",
    compressedCount: 0, totalMessages: messages.length, didCompress: false,
  };

  if (!config.enabled || messages.length === 0) return emptyResult;

  // Defense in depth: strip any <conversation-history> blocks that may have
  // leaked into persisted messages (e.g. from a prior turn without stripping).
  // This prevents recursive nesting and exponential inflation.
  const HISTORY_RE = /<conversation-history>[\s\S]*?<\/conversation-history>\s*/g;
  const cleanMessages = messages.map((m) => ({
    ...m,
    content: typeof m.content === "string" ? m.content.replace(HISTORY_RE, "").trim() : m.content,
  }));

  const totalMessages = cleanMessages.length;
  const keepRecent = Math.max(1, config.keepRecent);
  const compressAfter = Math.max(keepRecent + 1, config.compressAfter);

  // Determine split point: messages to keep verbatim vs messages to compress
  const needsCompression = totalMessages > compressAfter;

  // Recent messages: the last `keepRecent` messages, reversed (newest first)
  const recentStart = Math.max(0, totalMessages - keepRecent);
  const recentMessages = cleanMessages.slice(recentStart).reverse();

  // Older messages: everything before the recent window
  const olderMessages = needsCompression
    ? cleanMessages.slice(0, recentStart)
    : [];

  // Compress older messages into summaries
  const summaries = needsCompression && olderMessages.length > 0
    ? (existingSummaries && existingSummaries.length > 0
        ? existingSummaries
        : compressMessages(olderMessages, config))
    : [];

  // ── Build summaryBlock (stable, for prependSystemContext) ──
  let summaryBlock = "";
  if (summaries.length > 0) {
    const summaryParts: string[] = [];
    summaryParts.push("<conversation-summaries>");
    summaryParts.push("## 早期对话摘要");
    for (const summary of summaries) {
      summaryParts.push(`<summary>${summary}</summary>`);
    }
    summaryParts.push("</conversation-summaries>");
    summaryBlock = summaryParts.join("\n");
  }

  // ── Build recentBlock (dynamic, for prependContext) ──
  let recentBlock = "";
  if (recentMessages.length > 0) {
    const recentParts: string[] = [];
    recentParts.push("<recent-conversation>");
    recentParts.push("## 最近的对话（最新在前）");
    for (const msg of recentMessages) {
      const roleLabel = roleDisplayName(msg.role);
      const content = truncateContent(msg.content, 500);
      recentParts.push(`[${roleLabel}] ${content}`);
    }
    recentParts.push("</recent-conversation>");
    recentBlock = recentParts.join("\n");
  }

  // ── Build combined historyBlock (backward compat) ──
  const combinedParts: string[] = [];
  combinedParts.push("<conversation-history>");
  if (summaryBlock) {
    // Extract inner content from summaryBlock (strip outer wrapper)
    const inner = summaryBlock
      .replace(/^<conversation-summaries>\n?/, "")
      .replace(/\n?<\/conversation-summaries>$/, "");
    combinedParts.push(inner);
  }
  if (recentBlock) {
    // Extract inner content from recentBlock (strip outer wrapper)
    const inner = recentBlock
      .replace(/^<recent-conversation>\n?/, "")
      .replace(/\n?<\/recent-conversation>$/, "");
    if (summaryBlock) combinedParts.push("");
    combinedParts.push(inner);
  }
  combinedParts.push("</conversation-history>");
  const historyBlock = combinedParts.join("\n");

  const compressedCount = needsCompression ? olderMessages.length : 0;

  return {
    summaryBlock,
    recentBlock,
    historyBlock,
    compressedCount,
    totalMessages,
    didCompress: needsCompression,
  };
}

/**
 * Compress a list of messages into summary chunks.
 *
 * Current implementation: simple concatenation with truncation.
 * Future: LLM-based summarization via the provided llm callback.
 */
function compressMessages(
  messages: ConversationMessage[],
  config: HistoryReversalConfig,
): string[] {
  const chunkSize = Math.max(1, config.chunkSize);
  const maxChars = config.maxSummaryTokens * 3; // Rough char estimate per token
  const summaries: string[] = [];

  for (let i = 0; i < messages.length; i += chunkSize) {
    const chunk = messages.slice(i, i + chunkSize);
    const lines = chunk.map((m) => {
      const role = roleDisplayName(m.role);
      const content = truncateContent(m.content, 200);
      return `[${role}] ${content}`;
    });
    const combined = lines.join("; ");
    summaries.push(`[Turns ${i + 1}-${Math.min(i + chunkSize, messages.length)}]: ${truncateContent(combined, maxChars)}`);
  }

  return summaries;
}

/**
 * Build an LLM-friendly summarization prompt for a chunk of messages.
 * Can be used by callers that have access to an LLM runner.
 */
export function buildSummaryPrompt(messages: ConversationMessage[]): string {
  const lines = messages.map((m) => {
    const role = roleDisplayName(m.role);
    return `[${role}] ${truncateContent(m.content, 300)}`;
  });
  return [
    "请用1-2句话总结以下对话片段，保留关键信息（人物、事件、决定、偏好）：",
    "",
    lines.join("\n"),
    "",
    "总结：",
  ].join("\n");
}

function roleDisplayName(role: string): string {
  switch (role) {
    case "user": return "用户";
    case "assistant": return "助手";
    case "tool": return "工具";
    case "system": return "系统";
    default: return role;
  }
}

function truncateContent(content: string, maxChars: number): string {
  if (!content) return "";
  const cps = Array.from(content);
  if (cps.length <= maxChars) return content;
  return cps.slice(0, maxChars - 3).join("") + "...";
}
