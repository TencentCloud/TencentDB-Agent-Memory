/**
 * ClaudeCodeAdapter — Gateway-based adapter for Claude Code integration.
 *
 * ─── Architecture ──────────────────────────────────────────────────────────
 *
 * Claude Code integrates with the memory system through:
 *
 *   1. **settings.json hooks** — preMessage / postMessage lifecycle hooks
 *      (short-lived subprocesses that call the Gateway over HTTP).
 *   2. **MCP servers** — long-lived processes that advertise tools to the LLM.
 *
 * This adapter is a thin convenience wrapper around GatewayMemoryClient.
 * The heavy lifting (TdaiCore, storage, extraction pipeline) lives in the
 * Gateway process.
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │  Claude Code                                               │
 *   │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
 *   │  │ preMessage   │  │ postMessage  │  │ MCP Server       │ │
 *   │  │ hook (recall)│  │ hook (capture)│  │ (tools)          │ │
 *   │  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘ │
 *   └─────────┼──────────────────┼───────────────────┼───────────┘
 *             │ subprocess       │ subprocess        │ persistent
 *             ▼                  ▼                   ▼
 *         GatewayMemoryClient  GatewayMemoryClient  GatewayMemoryClient
 *             │                  │                   │
 *             └──────────────────┼───────────────────┘
 *                                ▼
 *                         TDAI Gateway (daemon)
 *                         TdaiCore / SQLite / Pipeline
 *
 * ─── Usage ─────────────────────────────────────────────────────────────────
 *
 * ```ts
 * import { ClaudeCodeAdapter } from "./index.js";
 *
 * const adapter = new ClaudeCodeAdapter({
 *   gatewayUrl: "http://127.0.0.1:8420",
 * });
 *
 * const recall = await adapter.recall("user message", "session-key");
 * ```
 *
 * ─── Settings setup ────────────────────────────────────────────────────────
 *
 * Run `npx memory-tdai configure-claude-code` in your project to
 * automatically generate the settings.json hooks and MCP server config.
 *
 * @see GatewayMemoryClient — the underlying HTTP client
 */

import { GatewayMemoryClient } from "../gateway-client/index.js";
import type { Logger } from "../../core/types.js";

// ============================
// Defaults & env var keys
// ============================

/** Environment variable prefix for all memory-tdai config in Claude Code. */
const ENV_PREFIX = "MEMORY_TDAI_";

/** Gateway-related env vars. */
const GATEWAY_URL_ENV = "TDAI_GATEWAY_URL";
const GATEWAY_API_KEY_ENV = "TDAI_GATEWAY_API_KEY";

// ============================
// ClaudeCodeAdapter
// ============================

export class ClaudeCodeAdapter {
  readonly platform = "claude-code";
  readonly logger: Logger;

  /** The underlying Gateway HTTP client. */
  readonly client: GatewayMemoryClient;

  constructor(opts?: {
    /**
     * TDAI Gateway URL. Falls back to TDAI_GATEWAY_URL env var,
     * then http://127.0.0.1:8420.
     */
    gatewayUrl?: string;
    /** Gateway API key. Falls back to TDAI_GATEWAY_API_KEY env var. */
    apiKey?: string;
    /** Logger override. Falls back to default console logger. */
    logger?: Logger;
    /**
     * Custom fetch implementation for testing.
     * Defaults to global fetch.
     */
    fetchImpl?: typeof fetch;
    /**
     * Request timeout in milliseconds.
     * Defaults to GatewayMemoryClient default (10s).
     */
    timeoutMs?: number;
  }) {
    this.logger = opts?.logger ?? createClaudeCodeLogger();
    this.client = new GatewayMemoryClient({
      baseUrl: opts?.gatewayUrl ?? process.env[GATEWAY_URL_ENV] ?? "http://127.0.0.1:8420",
      apiKey: opts?.apiKey ?? process.env[GATEWAY_API_KEY_ENV],
      fetchImpl: opts?.fetchImpl,
      timeoutMs: opts?.timeoutMs,
    });
  }

  // ============================
  // Core operations
  // ============================

  /**
   * Perform memory recall for a user message.
   * Delegates to POST /recall on the Gateway.
   */
  async recall(
    userText: string,
    sessionKey: string,
  ): Promise<{ prependContext?: string; strategy?: string }> {
    if (!userText || !sessionKey) return {};

    try {
      const result = await this.client.recall({ query: userText, session_key: sessionKey });
      return {
        prependContext: result.context,
        strategy: result.strategy,
      };
    } catch (err) {
      this.logger.error(`[claude-code] Recall failed: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }

  /**
   * Capture a completed conversation turn.
   * Delegates to POST /capture on the Gateway.
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

    try {
      const result = await this.client.capture({
        user_content: turn.userText,
        assistant_content: turn.assistantText,
        messages: turn.messages,
        session_key: turn.sessionKey,
        session_id: turn.sessionId,
      });
      this.logger.info?.(
        `[claude-code] Capture complete: l0Recorded=${result.l0_recorded}, ` +
        `schedulerNotified=${result.scheduler_notified}`,
      );
    } catch (err) {
      this.logger.error(`[claude-code] Capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Search L1 structured memories.
   * Delegates to POST /search/memories on the Gateway.
   */
  async searchMemories(params: {
    query: string;
    limit?: number;
    type?: string;
    scene?: string;
  }): Promise<{ text: string; total: number }> {
    try {
      const result = await this.client.searchMemories({
        query: params.query,
        limit: params.limit,
        type: params.type,
        scene: params.scene,
      });
      return { text: result.results, total: result.total };
    } catch (err) {
      this.logger.error(`[claude-code] searchMemories failed: ${err instanceof Error ? err.message : String(err)}`);
      return { text: "", total: 0 };
    }
  }

  /**
   * Search L0 raw conversations.
   * Delegates to POST /search/conversations on the Gateway.
   */
  async searchConversations(params: {
    query: string;
    limit?: number;
    sessionKey?: string;
  }): Promise<{ text: string; total: number }> {
    try {
      const result = await this.client.searchConversations({
        query: params.query,
        limit: params.limit,
        session_key: params.sessionKey,
      });
      return { text: result.results, total: result.total };
    } catch (err) {
      this.logger.error(`[claude-code] searchConversations failed: ${err instanceof Error ? err.message : String(err)}`);
      return { text: "", total: 0 };
    }
  }

  /**
   * End a session and flush buffered state.
   * Delegates to POST /session/end on the Gateway.
   */
  async sessionEnd(sessionKey: string): Promise<void> {
    if (!sessionKey) return;

    try {
      await this.client.endSession({ session_key: sessionKey });
      this.logger.info?.(`[claude-code] Session ended: ${sessionKey}`);
    } catch (err) {
      this.logger.error(`[claude-code] sessionEnd failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ============================
  // Settings generator
  // ============================

  /**
   * Generate the `.claude/settings.json` entries required to wire up
   * the memory plugin with Claude Code.
   *
   * @param opts - Configuration options
   * @returns A partial settings.json object to merge into the existing file.
   */
  static generateSettingsJson(opts?: {
    enableMcp?: boolean;
    runner?: string;
  }): Record<string, unknown> {
    const runner = opts?.runner ?? "npx";

    let cliPrefix: string;
    if (runner === "npx") {
      cliPrefix = "npx --package @tencentdb-agent-memory/memory-tencentdb";
    } else {
      cliPrefix = `${runner} memory-tdai`;
    }

    const settings: Record<string, unknown> = {
      hooks: {
        preMessage: [
          {
            matcher: "*",
            run: `${cliPrefix} claude-code-recall`,
          },
        ],
        postMessage: [
          {
            matcher: "*",
            run: `${cliPrefix} claude-code-capture`,
          },
        ],
      },
    };

    if (opts?.enableMcp ?? true) {
      (settings as Record<string, unknown>).mcpServers = {
        "memory-tdai": {
          command: "npx",
          args: [
            "--package", "@tencentdb-agent-memory/memory-tencentdb",
            "memory-tencentdb-mcp",
          ],
        },
      };
    }

    return settings;
  }
}

// ============================
// Utilities
// ============================

/** Create a simple console logger for Claude Code subprocess use. */
function createClaudeCodeLogger(): Logger {
  const isDebug = process.env[`${ENV_PREFIX}DEBUG`] === "1" || process.env.DEBUG?.includes("memory-tdai");
  return {
    debug: isDebug ? (msg: string) => console.error(`[memory-tdai] ${msg}`) : undefined,
    info: (msg: string) => console.error(`[memory-tdai] ${msg}`),
    warn: (msg: string) => console.error(`[memory-tdai] ${msg}`),
    error: (msg: string) => console.error(`[memory-tdai] ${msg}`),
  };
}
