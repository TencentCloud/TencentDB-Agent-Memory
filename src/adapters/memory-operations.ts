/**
 * MemoryOperations — transport-neutral facade over TdaiCore.
 *
 * Both McpServerBase (stdio JSON-RPC) and HttpServerBase (HTTP) expose the
 * same five memory operations. Only the wire format differs: MCP renders
 * markdown for an LLM to read, HTTP emits JSON for a program to parse.
 *
 * Everything that is *not* wire format — argument validation, the TdaiCore
 * call, timing logs — lives here so it is written once. Each transport takes
 * the structured result and formats it.
 *
 * Adding an operation here makes it available to every platform on both
 * transports, which is what keeps the two sides from drifting apart.
 */

import type { TdaiCore } from "../core/tdai-core.js";
import type { Logger, RecallResult, CaptureResult } from "../core/types.js";

// ============================
// Errors
// ============================

/**
 * A caller-fault error (missing/invalid argument).
 * HTTP maps this to 400; MCP renders it as tool error text.
 */
export class MemoryOperationError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "MemoryOperationError";
    this.statusCode = statusCode;
  }
}

/** Throw a 400 unless `value` is a non-empty string. */
function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MemoryOperationError(`Missing required field: ${field}`);
  }
  return value;
}

// ============================
// Parameter types
// ============================

export interface RecallParams {
  query: string;
  sessionKey: string;
}

export interface CaptureParams {
  userText: string;
  assistantText: string;
  sessionKey: string;
  sessionId?: string;
  /** Full message list. Defaults to a user/assistant pair built from the texts. */
  messages?: unknown[];
  startedAt?: number;
}

export interface SearchMemoriesParams {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

export interface SearchConversationsParams {
  query: string;
  limit?: number;
  sessionKey?: string;
}

export interface SearchResult {
  text: string;
  total: number;
}

export interface MemorySearchResult extends SearchResult {
  strategy: string;
}

// ============================
// MemoryOperations
// ============================

export class MemoryOperations {
  private readonly core: TdaiCore;
  private readonly logger: Logger;
  private readonly tag: string;

  constructor(core: TdaiCore, logger: Logger, tag = "[tdai]") {
    this.core = core;
    this.logger = logger;
    this.tag = tag;
  }

  async recall(params: RecallParams): Promise<RecallResult> {
    const query = requireText(params.query, "query");
    const sessionKey = requireText(params.sessionKey, "session_key");

    const startMs = Date.now();
    const result = await this.core.handleBeforeRecall(query, sessionKey);
    this.logger.info(
      `${this.tag} Recall completed in ${Date.now() - startMs}ms: ` +
        `context=${result.appendSystemContext?.length ?? 0} chars, ` +
        `memories=${result.recalledL1Memories?.length ?? 0}`,
    );
    return result;
  }

  async capture(params: CaptureParams): Promise<CaptureResult> {
    const userText = requireText(params.userText, "user_text");
    const assistantText = requireText(params.assistantText, "assistant_text");
    const sessionKey = requireText(params.sessionKey, "session_key");

    const startMs = Date.now();
    const result = await this.core.handleTurnCommitted({
      userText,
      assistantText,
      messages: params.messages ?? [
        { role: "user", content: userText },
        { role: "assistant", content: assistantText },
      ],
      sessionKey,
      sessionId: params.sessionId ?? sessionKey,
      startedAt: params.startedAt ?? Date.now(),
    });
    this.logger.info(
      `${this.tag} Capture completed in ${Date.now() - startMs}ms: l0=${result.l0RecordedCount}`,
    );
    return result;
  }

  async searchMemories(params: SearchMemoriesParams): Promise<MemorySearchResult> {
    const query = requireText(params.query, "query");
    return this.core.searchMemories({
      query,
      limit: params.limit,
      type: params.type,
      scene: params.scene,
    });
  }

  async searchConversations(params: SearchConversationsParams): Promise<SearchResult> {
    const query = requireText(params.query, "query");
    return this.core.searchConversations({
      query,
      limit: params.limit,
      sessionKey: params.sessionKey,
    });
  }

  async sessionEnd(sessionKey: string): Promise<void> {
    const key = requireText(sessionKey, "session_key");
    await this.core.handleSessionEnd(key);
    this.logger.info(`${this.tag} Session ended: ${key}`);
  }
}
