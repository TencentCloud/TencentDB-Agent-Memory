/**
 * MemoryPlugin — SDK class that wraps GatewayMemoryClient for high-level access.
 *
 * ─── Architecture (Gateway mode) ────────────────────────────────────────────
 *
 *   Platform hooks               SDK handles              Gateway
 *   ───────────────              ───────────              ────────
 *   beforePrompt  ──────────►  plugin.recall()  ────►  POST /recall
 *   afterTurn     ──────────►  plugin.capture() ─────►  POST /capture
 *   tool call     ──────────►  plugin.search*()  ───►  POST /search/*
 *   shutdown      ──────────►  plugin.destroy() ─────
 *
 * MemoryPlugin no longer embeds TdaiCore in-process. Instead, it delegates
 * all operations to the TDAI Gateway via GatewayMemoryClient (HTTP). This
 * aligns with the maintainer-vetted architecture in PR #316.
 *
 * ─── Usage ─────────────────────────────────────────────────────────────────
 *
 * ```ts
 * const plugin = new MemoryPlugin({
 *   gatewayUrl: "http://127.0.0.1:8420",
 *   apiKey: "optional-key",
 * });
 *
 * await plugin.initialize();
 *
 * // Before LLM turn:
 * const recall = await plugin.recall(userText, sessionKey);
 *
 * // After LLM turn:
 * await plugin.capture({ userText, assistantText, messages, sessionKey });
 *
 * // Shutdown:
 * await plugin.destroy();
 * ```
 *
 * The public API is intentionally identical to the old process-embedded
 * version so existing consumers do not need to change their call sites.
 *
 * @see GatewayMemoryClient — the underlying HTTP client
 * @see createGatewayPlatformAdapter — lifecycle helper for direct use
 */

import { GatewayMemoryClient } from "../adapters/gateway-client/index.js";
import type { Logger } from "../core/types.js";

import type {
  PromptContext,
  TurnContext,
} from "./adapter.js";

const TAG = "[memory-sdk]";

// ============================
// MemoryPlugin
// ============================

export class MemoryPlugin {
  // ── Configuration ──
  readonly gatewayUrl: string;
  readonly apiKey?: string;

  // ── Internal state ──
  private client: GatewayMemoryClient | null = null;
  private initialized = false;
  private _logger: Logger;

  constructor(opts: {
    /**
     * TDAI Gateway URL (default: http://127.0.0.1:8420).
     */
    gatewayUrl?: string;
    /**
     * Gateway API key for authenticated access.
     */
    apiKey?: string;
    /**
     * Logger override (defaults to console).
     */
    logger?: Logger;
  }) {
    this.gatewayUrl = opts.gatewayUrl ?? process.env.TDAI_GATEWAY_URL ?? "http://127.0.0.1:8420";
    this.apiKey = opts.apiKey ?? process.env.TDAI_GATEWAY_API_KEY;
    this._logger = opts.logger ?? createDefaultLogger();
  }

  // ============================
  // Lifecycle
  // ============================

  /**
   * Initialize the memory plugin.
   *
   * Creates a GatewayMemoryClient and verifies Gateway connectivity.
   * Does NOT start TdaiCore — that runs in the Gateway process.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      this._logger.warn?.("MemoryPlugin already initialized; skipping");
      return;
    }

    this.client = new GatewayMemoryClient({
      baseUrl: this.gatewayUrl,
      apiKey: this.apiKey,
    });

    // Quick health check — non-fatal, logs a warning if Gateway is unreachable
    try {
      const health = await Promise.race([
        this.client.health(),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error("health check timed out")), 3000),
        ),
      ]);
      this._logger.info?.(`${TAG} Gateway healthy: ${JSON.stringify(health)}`);
    } catch (err) {
      this._logger.warn?.(
        `${TAG} Gateway health check failed — will retry on first operation: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      // Continue — the Gateway may start later
    }

    this.initialized = true;
    this._logger.info?.(`${TAG} MemoryPlugin initialized (gateway=${this.gatewayUrl})`);
  }

  /**
   * Destroy the plugin and release resources.
   */
  async destroy(): Promise<void> {
    if (!this.initialized) return;
    this._logger.debug?.(`${TAG} Destroying MemoryPlugin...`);
    this.client = null;
    this.initialized = false;
    this._logger.info?.(`${TAG} MemoryPlugin destroyed`);
  }

  // ============================
  // Core operations
  // ============================

  /**
   * Perform memory recall for a user message.
   *
   * Delegates to `POST /recall` on the Gateway. The Gateway handles caching
   * and memory retrieval.
   *
   * @param userText   – The user's raw input text.
   * @param sessionKey – Opaque session identifier.
   * @returns Context to inject, or an empty object if no relevant memories.
   */
  async recall(
    userText: string,
    sessionKey: string,
  ): Promise<{ prependContext?: string; appendSystemContext?: string; strategy?: string }> {
    if (!userText || !sessionKey) return {};
    if (!this.initialized || !this.client) {
      this._logger.warn?.(`${TAG} [recall] Plugin not initialized, skipping`);
      return {};
    }

    try {
      const result = await this.client.recall({
        query: userText,
        session_key: sessionKey,
      });

      this._logger.info?.(
        `${TAG} [recall] ${result.context?.length ?? 0} chars, ` +
        `strategy=${result.strategy ?? "none"}, ` +
        `memories=${result.memory_count ?? 0}`,
      );

      // Gateway returns context as a single string; the SDK re-exports it
      // as prependContext for backward compatibility with existing consumers.
      return {
        prependContext: result.context,
        strategy: result.strategy,
      };
    } catch (err) {
      this._logger.error(`${TAG} [recall] Failed: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }

  /**
   * Capture a completed conversation turn.
   *
   * Delegates to `POST /capture` on the Gateway.
   */
  async capture(turn: {
    userText: string;
    assistantText: string;
    messages: unknown[];
    sessionKey: string;
    sessionId?: string;
    success?: boolean;
  }): Promise<void> {
    if (!turn.sessionKey || turn.success === false) return;
    if (!this.initialized || !this.client) {
      this._logger.warn?.(`${TAG} [capture] Plugin not initialized, skipping`);
      return;
    }

    try {
      const result = await this.client.capture({
        user_content: turn.userText,
        assistant_content: turn.assistantText,
        messages: turn.messages,
        session_key: turn.sessionKey,
        session_id: turn.sessionId,
      });

      this._logger.info?.(
        `${TAG} [capture] l0Recorded=${result.l0_recorded}, ` +
        `schedulerNotified=${result.scheduler_notified}`,
      );
    } catch (err) {
      this._logger.error(`${TAG} [capture] Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Search L1 structured memories.
   */
  async searchMemories(params: {
    query: string;
    limit?: number;
    type?: string;
    scene?: string;
  }): Promise<{ text: string; total: number }> {
    if (!this.initialized || !this.client) {
      this._logger.warn?.(`${TAG} [searchMemories] Plugin not initialized`);
      return { text: "", total: 0 };
    }

    try {
      const result = await this.client.searchMemories({
        query: params.query,
        limit: params.limit,
        type: params.type,
        scene: params.scene,
      });
      return { text: result.results, total: result.total };
    } catch (err) {
      this._logger.error(`${TAG} [searchMemories] Failed: ${err instanceof Error ? err.message : String(err)}`);
      return { text: "", total: 0 };
    }
  }

  /**
   * Search L0 raw conversations.
   */
  async searchConversations(params: {
    query: string;
    limit?: number;
    sessionKey?: string;
  }): Promise<{ text: string; total: number }> {
    if (!this.initialized || !this.client) {
      this._logger.warn?.(`${TAG} [searchConversations] Plugin not initialized`);
      return { text: "", total: 0 };
    }

    try {
      const result = await this.client.searchConversations({
        query: params.query,
        limit: params.limit,
        session_key: params.sessionKey,
      });
      return { text: result.results, total: result.total };
    } catch (err) {
      this._logger.error(`${TAG} [searchConversations] Failed: ${err instanceof Error ? err.message : String(err)}`);
      return { text: "", total: 0 };
    }
  }

  /**
   * End a session and flush buffered state.
   */
  async sessionEnd(sessionKey: string): Promise<void> {
    if (!sessionKey) return;
    if (!this.initialized || !this.client) {
      this._logger.warn?.(`${TAG} [sessionEnd] Plugin not initialized, skipping`);
      return;
    }

    try {
      await this.client.endSession({ session_key: sessionKey });
      this._logger.info?.(`${TAG} [sessionEnd] Session ended: ${sessionKey}`);
    } catch (err) {
      this._logger.error(`${TAG} [sessionEnd] Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ============================
// Default logger
// ============================

function createDefaultLogger(): Logger {
  return {
    debug: (msg: string) => process.env.DEBUG?.includes("memory") && console.error(`${TAG} ${msg}`),
    info: (msg: string) => console.error(`${TAG} ${msg}`),
    warn: (msg: string) => console.error(`${TAG} ${msg}`),
    error: (msg: string) => console.error(`${TAG} ${msg}`),
  };
}
