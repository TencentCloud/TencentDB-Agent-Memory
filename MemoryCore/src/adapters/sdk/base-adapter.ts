/**
 * MemoryAdapterBase — Abstract base class for all platform adapters.
 *
 * New platforms extend this class and implement only 4 abstract methods:
 *
 *   1. `formatRecallResult(result)` — Format memory recall output for the
 *      platform's prompt injection convention.
 *   2. `getToolDefinitions()` — Return tool schemas the platform registers
 *      with its LLM.
 *   3. `formatToolResult(toolName, rawResult)` — Format tool call output
 *      for the platform's expected response format.
 *   4. `normalizeMessages(rawMessages)` — Convert platform-specific message
 *      format into the standard `ConversationMessage[]`.
 *
 * The base class handles:
 *   - Gateway connection and health checking
 *   - Circuit breaker (pauses calls after N consecutive failures)
 *   - Recall (parallel L1 + L3 + L2 fetch via GatewayClient)
 *   - Capture (conversation add via GatewayClient)
 *   - Search (memory + conversation search via GatewayClient)
 *   - Session management
 *
 * Usage:
 *   ```typescript
 *   class ClaudeCodeAdapter extends MemoryAdapterBase {
 *     readonly platformName = "claude-code";
 *     // implement 4 abstract methods...
 *   }
 *
 *   const adapter = new ClaudeCodeAdapter();
 *   await adapter.initialize({ gateway: { endpoint: "http://127.0.0.1:8420" } });
 *   const recall = await adapter.recall("user query", "session-1");
 *   await adapter.capture(messages, "session-1");
 *   ```
 */

import { MemoryGatewayClient } from "./gateway-client.js";
import type {
  AdapterConfig,
  ConversationMessage,
  IPlatformAdapter,
  RecallResult,
  CaptureResult,
  SearchResult,
  ToolDefinition,
  TenancyConfig,
} from "./types.js";

// ============================
// Circuit breaker constants
// ============================

export const BREAKER_THRESHOLD = 5;
export const BREAKER_COOLDOWN_MS = 60_000;

// ============================
// Default tool definitions
// ============================

/** Default memory search tool definition. Platforms can customize. */
export const DEFAULT_MEMORY_SEARCH_TOOL: ToolDefinition = {
  name: "tdai_memory_search",
  label: "Memory Search",
  description:
    "Search structured memories (L1). Returns relevant memory fragments about " +
    "user preferences, past events, rules, and facts.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query text (natural language)." },
      limit: { type: "number", description: "Max results to return (default: 5)." },
      type: { type: "string", description: "Filter by memory type." },
    },
    required: ["query"],
  },
};

/** Default conversation search tool definition. */
export const DEFAULT_CONVERSATION_SEARCH_TOOL: ToolDefinition = {
  name: "tdai_conversation_search",
  label: "Conversation Search",
  description:
    "Search raw conversation history (L0). Returns original messages with timestamps.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query text." },
      limit: { type: "number", description: "Max results (default: 5)." },
      session_key: { type: "string", description: "Filter by session ID." },
    },
    required: ["query"],
  },
};

/** Default scene read tool definition. */
export const DEFAULT_READ_SCENE_TOOL: ToolDefinition = {
  name: "tdai_read_scene",
  label: "Read Scene",
  description:
    "Read a scene block's full content by its name. " +
    "Use when you see a scene listed in Scene Navigation.",
  parameters: {
    type: "object",
    properties: {
      scene_id: { type: "string", description: "Scene file name (e.g. 'travel-plan.md')." },
    },
    required: ["scene_id"],
  },
};

// ============================
// MemoryAdapterBase
// ============================

export abstract class MemoryAdapterBase implements IPlatformAdapter {
  abstract readonly platformName: string;

  protected client!: MemoryGatewayClient;
  protected config!: AdapterConfig;
  protected tenancy!: Required<TenancyConfig>;
  protected sessionId: string = "";

  // Circuit breaker state
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;

  // ============================
  // Properties
  // ============================

  /** Whether `initialize()` has been called successfully. */
  get isInitialized(): boolean {
    return this.client !== undefined;
  }

  /** The current session ID for capture operations. */
  get currentSessionId(): string {
    return this.sessionId;
  }

  // ============================
  // Lifecycle
  // ============================

  /**
   * Initialize the adapter with configuration.
   * Creates the Gateway client and performs a health check.
   */
  async initialize(config: AdapterConfig): Promise<void> {
    this.config = config;
    this.tenancy = {
      teamId: config.tenancy?.teamId ?? "default",
      agentId: config.tenancy?.agentId ?? "default",
      userId: config.tenancy?.userId ?? "default",
    };

    this.client = new MemoryGatewayClient({
      endpoint: config.gateway.endpoint,
      apiKey: config.gateway.apiKey,
      serviceId: config.gateway.serviceId,
      timeoutMs: config.gateway.timeoutMs,
      rejectUnauthorized: config.gateway.rejectUnauthorized,
    });

    // Best-effort health check (non-blocking on failure)
    const health = await this.client.health();
    if (health.status === "ok" || health.status === "degraded") {
      this.onGatewayReady();
    } else {
      // Don't throw — the Gateway might come up later
      this.onGatewayUnavailable(health.status);
    }
  }

  /**
   * Set the current session ID for capture operations.
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * Shutdown the adapter. Subclasses can override for cleanup.
   */
  async shutdown(): Promise<void> {
    // Base class has no persistent resources to close.
    // Subclasses can override for platform-specific cleanup.
  }

  // ============================
  // Core capabilities (implemented by base class)
  // ============================

  /**
   * Recall memories for the current user query.
   *
   * Performs parallel L1 (structured memories) + L3 (persona) + L2 (scene
   * navigation) fetch from the Gateway, then delegates formatting to the
   * platform-specific `formatRecallResult()` method.
   *
   * Returns empty strings on failure — never throws.
   */
  async recall(
    query: string,
    sessionId?: string,
  ): Promise<{ prependContext: string; appendSystemContext: string }> {
    if (!query || !this.client || this.isBreakerOpen()) {
      return { prependContext: "", appendSystemContext: "" };
    }

    const effectiveSession = sessionId ?? this.sessionId;
    const startMs = Date.now();

    try {
      const { memories, persona, scenes } = await this.client.recall(
        query,
        this.tenancy,
        {
          maxResults: this.config.recallMaxResults ?? 5,
          includePersona: this.config.recallIncludePersona ?? true,
          includeSceneNav: this.config.recallIncludeSceneNav ?? true,
        },
      );

      const latencyMs = Date.now() - startMs;
      const result: RecallResult = {
        prependContext: "",
        appendSystemContext: "",
        memories,
        persona,
        scenes,
        latencyMs,
      };

      this.recordSuccess();

      // Delegate formatting to the platform implementation
      const formatted = this.formatRecallResult(result);
      return {
        prependContext: formatted.prependContext ?? "",
        appendSystemContext: formatted.appendSystemContext ?? "",
      };
    } catch (err) {
      this.recordFailure();
      this.onRecallError(err instanceof Error ? err : new Error(String(err)));
      return { prependContext: "", appendSystemContext: "" };
    }
  }

  /**
   * Capture conversation messages.
   *
   * Normalizes platform-specific messages via `normalizeMessages()`, then
   * sends them to the Gateway for L0 recording.
   *
   * Returns failure result on error — never throws.
   */
  async capture(
    rawMessages: unknown,
    sessionId?: string,
    context?: Record<string, unknown>,
  ): Promise<CaptureResult> {
    if (!this.client || this.isBreakerOpen()) {
      return { capturedCount: 0, success: false, error: "circuit breaker open" };
    }

    if (!(this.config.captureEnabled ?? true)) {
      return { capturedCount: 0, success: true };
    }

    try {
      const messages = this.normalizeMessages(rawMessages, context);
      if (messages.length === 0) {
        return { capturedCount: 0, success: true };
      }

      const effectiveSession = sessionId ?? this.sessionId;
      const result = await this.client.capture(
        messages,
        effectiveSession,
        this.tenancy,
      );

      if (result.success) {
        this.recordSuccess();
      } else {
        this.recordFailure();
      }

      return {
        capturedCount: result.capturedCount,
        success: result.success,
      };
    } catch (err) {
      this.recordFailure();
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.onCaptureError(errorMsg);
      return { capturedCount: 0, success: false, error: errorMsg };
    }
  }

  /**
   * Search L1 structured memories.
   */
  async searchMemories(
    query: string,
    options?: { limit?: number; type?: string },
  ): Promise<SearchResult> {
    if (!query || !this.client || this.isBreakerOpen()) {
      return { text: "No results.", total: 0, items: [] };
    }

    try {
      const { items, total } = await this.client.searchMemories(
        query,
        this.tenancy,
        options,
      );
      this.recordSuccess();

      const text = items.length === 0
        ? "No memories found for this query."
        : items.map((m) => `- [${m.type}] ${m.content}`).join("\n");

      const result: SearchResult = { text, total, items };
      return result;
    } catch (err) {
      this.recordFailure();
      return { text: `Search failed: ${err instanceof Error ? err.message : String(err)}`, total: 0, items: [] };
    }
  }

  /**
   * Search L0 raw conversations.
   */
  async searchConversations(
    query: string,
    options?: { limit?: number; sessionId?: string },
  ): Promise<SearchResult> {
    if (!query || !this.client || this.isBreakerOpen()) {
      return { text: "No results.", total: 0, items: [] };
    }

    try {
      const { items, total } = await this.client.searchConversations(
        query,
        this.tenancy,
        options,
      );
      this.recordSuccess();

      const text = items.length === 0
        ? "No conversations found for this query."
        : items.map((m) => `[${m.type}] ${m.content}`).join("\n");

      const result: SearchResult = { text, total, items };
      return result;
    } catch (err) {
      this.recordFailure();
      return { text: `Search failed: ${err instanceof Error ? err.message : String(err)}`, total: 0, items: [] };
    }
  }

  /**
   * Read a scene block by path.
   */
  async readScene(sceneId: string): Promise<string> {
    if (!sceneId || !this.client || this.isBreakerOpen()) {
      return "Scene not available.";
    }

    try {
      const path = sceneId.endsWith(".md") ? sceneId : `${sceneId}.md`;
      const content = await this.client.readScene(path, this.tenancy);
      this.recordSuccess();
      return content || `Scene '${sceneId}' is empty or not found.`;
    } catch (err) {
      this.recordFailure();
      return `Failed to read scene: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Handle a tool call by name. Dispatches to the appropriate method.
   */
  async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    try {
      let rawResult: SearchResult | string;

      switch (toolName) {
        case "tdai_memory_search":
        case "memory_tencentdb_memory_search": {
          rawResult = await this.searchMemories(
            String(args.query ?? ""),
            {
              limit: typeof args.limit === "number" ? args.limit : undefined,
              type: typeof args.type === "string" ? args.type : undefined,
            },
          );
          break;
        }
        case "tdai_conversation_search":
        case "memory_tencentdb_conversation_search": {
          rawResult = await this.searchConversations(
            String(args.query ?? ""),
            {
              limit: typeof args.limit === "number" ? args.limit : undefined,
              sessionId: typeof args.session_key === "string" ? args.session_key : undefined,
            },
          );
          break;
        }
        case "tdai_read_scene":
        case "memory_tencentdb_read_scene": {
          rawResult = await this.readScene(String(args.scene_id ?? ""));
          break;
        }
        default:
          return JSON.stringify({ error: `Unknown tool: ${toolName}` });
      }

      return this.formatToolResult(toolName, rawResult);
    } catch (err) {
      return JSON.stringify({
        error: `Tool call failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Get the default tool definitions (memory search, conversation search,
   * scene read). Platforms can override to customize.
   */
  getToolDefinitions(): ToolDefinition[] {
    return [
      DEFAULT_MEMORY_SEARCH_TOOL,
      DEFAULT_CONVERSATION_SEARCH_TOOL,
      DEFAULT_READ_SCENE_TOOL,
    ];
  }

  // ============================
  // Circuit breaker
  // ============================

  protected isBreakerOpen(): boolean {
    if (this.consecutiveFailures < BREAKER_THRESHOLD) return false;
    if (Date.now() >= this.breakerOpenUntil) {
      this.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  protected recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  protected recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= BREAKER_THRESHOLD) {
      this.breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
    }
  }

  // ============================
  // Overridable hooks (platform-specific)
  // ============================

  /** Called when the Gateway becomes reachable after initialize(). */
  protected onGatewayReady(): void {
    // Override in subclass for platform-specific logging
  }

  /** Called when the Gateway is not reachable at initialize(). */
  protected onGatewayUnavailable(_status: string): void {
    // Override in subclass for platform-specific fallback
  }

  /** Called when a recall operation fails. */
  protected onRecallError(_err: Error): void {
    // Override in subclass for platform-specific error handling
  }

  /** Called when a capture operation fails. */
  protected onCaptureError(_errorMsg: string): void {
    // Override in subclass for platform-specific error handling
  }

  // ============================
  // Abstract methods (must be implemented by each platform)
  // ============================

  abstract formatRecallResult(result: RecallResult): {
    prependContext?: string;
    appendSystemContext?: string;
  };

  abstract formatToolResult(
    toolName: string,
    rawResult: SearchResult | string,
  ): string;

  abstract normalizeMessages(
    rawMessages: unknown,
    context?: Record<string, unknown>,
  ): ConversationMessage[];
}
