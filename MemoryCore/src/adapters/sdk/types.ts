/**
 * Unified Adapter SDK — Type definitions.
 *
 * These types define the contract between any Agent platform and the
 * TDAI memory engine. A new platform only needs to implement the
 * `MemoryPlatformAdapter` abstract class; all Gateway communication,
 * health checking, circuit breaking, and error handling are handled
 * by the SDK base class.
 *
 * Design goals:
 * 1. Platform-agnostic — no dependency on OpenClaw, Hermes, MCP, or any
 *    specific agent framework.
 * 2. Minimal surface area — platforms implement 4 abstract methods.
 * 3. Graceful degradation — every method returns empty results on failure
 *    rather than throwing, so the host agent never crashes.
 */

// ============================
// Configuration
// ============================

/** Connection configuration for the TDAI Gateway. */
export interface GatewayConnectionConfig {
  /** Gateway base URL (e.g. "http://127.0.0.1:8420"). */
  endpoint: string;
  /** Optional Bearer API key for authentication. */
  apiKey?: string;
  /** Instance / service ID for multi-tenant routing. */
  serviceId?: string;
  /** Request timeout in milliseconds (default: 10_000). */
  timeoutMs?: number;
  /** Whether to reject unauthorized TLS certificates (default: true). */
  rejectUnauthorized?: boolean;
}

/** Tenancy identifiers for v3 API isolation. */
export interface TenancyConfig {
  teamId?: string;
  agentId?: string;
  userId?: string;
}

/** Full adapter configuration passed to `initialize()`. */
export interface AdapterConfig {
  /** Gateway connection settings. */
  gateway: GatewayConnectionConfig;
  /** Tenancy isolation (all default to "default"). */
  tenancy?: TenancyConfig;
  /** Maximum L1 memories to recall per turn (default: 5). */
  recallMaxResults?: number;
  /** Whether to include L3 persona in recall results (default: true). */
  recallIncludePersona?: boolean;
  /** Whether to include L2 scene navigation in recall results (default: true). */
  recallIncludeSceneNav?: boolean;
  /** Whether conversation capture is enabled (default: true). */
  captureEnabled?: boolean;
}

// ============================
// Memory data types
// ============================

/** A single message in a conversation. */
export interface ConversationMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** ISO 8601 timestamp. */
  timestamp?: string;
}

/** An L1 structured memory item. */
export interface MemoryItem {
  /** Memory type (e.g. "persona", "episodic", "instruction"). */
  type: string;
  /** Memory content text. */
  content: string;
  /** Relevance score (0..1). */
  score?: number;
  /** Optional metadata. */
  metadata?: Record<string, unknown>;
}

/** L3 persona / user core content. */
export interface PersonaContent {
  content: string;
  updatedAt?: string;
}

/** L2 scene navigation entry. */
export interface SceneEntry {
  /** Scene file path (e.g. "scene_blocks/travel.md"). */
  path: string;
  /** Scene summary. */
  summary?: string;
  /** Heat score (access frequency). */
  heat?: number;
}

// ============================
// Result types
// ============================

/** Result of a recall (prefetch) operation. */
export interface RecallResult {
  /** Text to prepend to the user's prompt (L1 memories). */
  prependContext: string;
  /** Text to append to the system prompt (persona, scene nav, tool guide). */
  appendSystemContext: string;
  /** Raw L1 memory items (for platform-specific formatting). */
  memories: MemoryItem[];
  /** Raw L3 persona content (if available). */
  persona: PersonaContent | null;
  /** Raw L2 scene entries (if available). */
  scenes: SceneEntry[];
  /** Recall latency in milliseconds. */
  latencyMs: number;
}

/** Result of a capture operation. */
export interface CaptureResult {
  /** Number of messages captured. */
  capturedCount: number;
  /** Whether the Gateway accepted the capture. */
  success: boolean;
  /** Error message on failure. */
  error?: string;
}

/** Result of a memory search operation. */
export interface SearchResult {
  /** Formatted text result for LLM consumption. */
  text: string;
  /** Total matching items. */
  total: number;
  /** Raw memory items (for platform-specific formatting). */
  items: MemoryItem[];
}

// ============================
// Tool definition (for platform tool registration)
// ============================

/** A tool definition that platforms register with their host. */
export interface ToolDefinition {
  /** Tool name (unique within the platform). */
  name: string;
  /** Human-readable label. */
  label?: string;
  /** Tool description for the LLM. */
  description: string;
  /** JSON Schema for tool parameters. */
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ============================
// Platform adapter interface
// ============================

/**
 * Abstract interface that each Agent platform must implement.
 *
 * The SDK base class (`MemoryAdapterBase`) handles all Gateway
 * communication. Platforms only override these methods to integrate
 * with their specific framework conventions.
 */
export interface IPlatformAdapter {
  /** Platform identifier (e.g. "claude-code", "codex", "dify"). */
  readonly platformName: string;

  /**
   * Format a recall result for this platform's prompt injection.
   *
   * Different platforms have different conventions for how memory
   * context is injected into prompts. This method lets each platform
   * control the exact format.
   */
  formatRecallResult(result: RecallResult): {
    prependContext?: string;
    appendSystemContext?: string;
  };

  /**
   * Return the tool definitions this platform exposes to the LLM.
   *
   * Platforms can customize tool names, descriptions, and schemas
   * to match their conventions.
   */
  getToolDefinitions(): ToolDefinition[];

  /**
   * Handle a tool call from the platform.
   *
   * The SDK provides the raw Gateway response; platforms can customize
   * the output format (e.g. JSON vs. plain text).
   */
  formatToolResult(
    toolName: string,
    rawResult: SearchResult | string,
  ): string;

  /**
   * Build a capture request from platform-specific message format.
   *
   * Different platforms represent conversations differently. This method
   * normalizes them into the standard `ConversationMessage[]` format.
   */
  normalizeMessages(
    rawMessages: unknown,
    context?: Record<string, unknown>,
  ): ConversationMessage[];
}
