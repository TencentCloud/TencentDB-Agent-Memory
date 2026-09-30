/**
 * InProcessMemoryAdapter — a `MemoryAdapter` that wraps a live `TdaiCore`
 * instance in the same Node process.
 *
 * This is the adapter for embedded hosts and for transports that run
 * alongside the core (the MCP server in `src/adapters/mcp/`, a CLI, or a
 * platform whose runtime is Node). There is no network hop: calls go straight
 * to `TdaiCore`'s public methods.
 *
 * It also serves as the reference for how a custom adapter maps the
 * `MemoryAdapter` contract onto `TdaiCore` — a platform with a bespoke
 * transport can copy this file and swap the call targets.
 */

import type { TdaiCore } from "../../core/tdai-core.js";
import type {
  CaptureResult,
  ConversationSearchParams,
  MemorySearchParams,
  RecallResult,
} from "../../core/types.js";
import type { CompletedTurn } from "../../core/types.js";
import type {
  CaptureTurn,
  ConversationSearchOutcome,
  HealthCheckResult,
  MemoryAdapter,
  MemorySearchOutcome,
} from "./types.js";
import { MemoryAdapterError } from "./types.js";

/**
 * The subset of `TdaiCore` this adapter depends on. Declared as an interface
 * so tests can pass a stub without spinning up a real core (which needs
 * sqlite-vec, embedding services, …).
 */
export interface TdaiCoreLike {
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  handleBeforeRecall(userText: string, sessionKey: string): Promise<RecallResult>;
  handleTurnCommitted(turn: CompletedTurn): Promise<CaptureResult>;
  searchMemories(
    params: MemorySearchParams,
  ): Promise<{ text: string; total: number; strategy: string }>;
  searchConversations(
    params: ConversationSearchParams,
  ): Promise<{ text: string; total: number }>;
  handleSessionEnd(sessionKey: string): Promise<void>;
  getVectorStore?(): unknown;
  getEmbeddingService?(): unknown;
}

export interface InProcessMemoryAdapterOptions {
  /** A constructed (not yet initialised) TdaiCore, or a stub. */
  core: TdaiCoreLike;
  /**
   * When true (default), `initialize()` calls `core.initialize()`.
   * Set false if the core was already initialised by the host.
   */
  ownsLifecycle?: boolean;
}

export class InProcessMemoryAdapter implements MemoryAdapter {
  readonly kind = "in-process";

  private readonly core: TdaiCoreLike;
  private readonly ownsLifecycle: boolean;
  private initialized = false;

  constructor(opts: InProcessMemoryAdapterOptions) {
    if (!opts || !opts.core) {
      throw new MemoryAdapterError("InProcessMemoryAdapter requires `core`", {
        code: "BAD_CONFIG",
      });
    }
    this.core = opts.core;
    this.ownsLifecycle = opts.ownsLifecycle ?? true;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.ownsLifecycle) {
      try {
        await this.core.initialize();
      } catch (err) {
        throw new MemoryAdapterError(
          `InProcessMemoryAdapter initialize failed: ${err instanceof Error ? err.message : String(err)}`,
          { code: "INIT_FAILED", cause: err },
        );
      }
    }
    this.initialized = true;
  }

  async destroy(): Promise<void> {
    if (this.ownsLifecycle) {
      try {
        await this.core.destroy();
      } catch (err) {
        throw new MemoryAdapterError(
          `InProcessMemoryAdapter destroy failed: ${err instanceof Error ? err.message : String(err)}`,
          { code: "DESTROY_FAILED", cause: err },
        );
      }
    }
    this.initialized = false;
  }

  async recall(query: string, sessionKey: string): Promise<RecallResult> {
    return this.core.handleBeforeRecall(query, sessionKey);
  }

  async capture(turn: CaptureTurn): Promise<CaptureResult> {
    if (!turn || !turn.sessionKey) {
      throw new MemoryAdapterError("capture requires `sessionKey`", {
        code: "BAD_ARGS",
      });
    }
    // Reconstruct the core CompletedTurn from the platform CaptureTurn.
    const messages =
      turn.messages ??
      [
        { role: "user", content: turn.userText ?? "" },
        { role: "assistant", content: turn.assistantText ?? "" },
      ];
    const completed: CompletedTurn = {
      userText: turn.userText ?? "",
      assistantText: turn.assistantText ?? "",
      messages,
      sessionKey: turn.sessionKey,
      ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
      ...(turn.startedAt != null ? { startedAt: turn.startedAt } : {}),
    };
    return this.core.handleTurnCommitted(completed);
  }

  async searchMemories(params: MemorySearchParams): Promise<MemorySearchOutcome> {
    return this.core.searchMemories(params);
  }

  async searchConversations(
    params: ConversationSearchParams,
  ): Promise<ConversationSearchOutcome> {
    return this.core.searchConversations(params);
  }

  async endSession(sessionKey: string): Promise<void> {
    if (!sessionKey) return;
    await this.core.handleSessionEnd(sessionKey);
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const vs = this.core.getVectorStore?.();
    const es = this.core.getEmbeddingService?.();
    return {
      ok: !!vs,
      detail: {
        vectorStore: !!vs,
        embeddingService: !!es,
        transport: "in-process",
      },
    };
  }
}

/**
 * Convenience: build an in-process adapter directly from a `TdaiCore`.
 * Re-exported so callers don't have to know the option shape.
 */
export function fromCore(
  core: TdaiCoreLike,
  ownsLifecycle = true,
): InProcessMemoryAdapter {
  return new InProcessMemoryAdapter({ core, ownsLifecycle });
}
