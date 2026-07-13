/**
 * TDAI Memory SDK — shared type definitions.
 *
 * These types define the boundary between the cross-platform MemoryPlugin
 * SDK and individual platform adapters. They are deliberately kept
 * abstract so any host (Claude Code, Codex, Dify, custom CLI) can
 * implement the contract without leaking platform-specific APIs.
 *
 * @see MemoryPlatformAdapter — the interface all platforms implement
 * @see MemoryPlugin — the SDK class that consumes an adapter or Gateway
 */

// ============================
// Platform identity
// ============================

/**
 * Well-known platform identifiers that the SDK recognises.
 * Custom platforms can use any unique string.
 */
export type PlatformKind = "openclaw" | "hermes" | "standalone" | "claude-code" | "codex" | "dify" | (string & {});

// ============================
// Tool registration
// ============================

/**
 * A tool descriptor that the platform's LLM can invoke.
 *
 * In Gateway mode, tools are registered on the MCP server or Gateway side.
 * This type is retained for backward compatibility with legacy adapters.
 *
 * @deprecated New platform adapters should expose tools through the MCP
 *   server (see `src/adapters/mcp/`) rather than implementing ToolRegistration.
 */
export interface ToolRegistration {
  /** Canonical tool name (e.g. "tdai_memory_search"). */
  name: string;
  /** Human-readable label for UI display. */
  label: string;
  /** Description that the LLM sees when deciding to call this tool. */
  description: string;
  /** JSON Schema for the tool's parameters. */
  parameters: Record<string, unknown>;
  /** Execute handler — returns a plain-text result string. */
  execute: (params: Record<string, unknown>) => Promise<string>;
}

// ============================
// Standalone LLM config
// ============================

/**
 * Optional LLM configuration for running L1/L2/L3 extraction via
 * direct OpenAI-compatible HTTP calls instead of the platform's own LLM.
 *
 * In Gateway mode, LLM configuration is managed by the Gateway process.
 * This type is retained for backward compatibility.
 *
 * @deprecated LLM configuration should be managed on the Gateway side.
 */
export interface ResolvedLLMConfig {
  /** OpenAI-compatible API base URL. */
  baseUrl: string;
  /** API key. */
  apiKey: string;
  /** Model identifier (e.g. "gpt-4o", "deepseek-v3"). */
  model: string;
  /** Max output tokens. */
  maxTokens?: number;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Disable reasoning/thinking output strategy. */
  disableThinking?: boolean | string;
}

// ============================
// Lifecycle events
// ============================

/** Context extracted from a "before prompt" lifecycle event. */
export interface PromptContext {
  /** The user's raw input text for this turn. */
  userText: string;
  /** Opaque session key identifying the conversation. */
  sessionKey: string;
}

/** Context extracted from an "after turn" lifecycle event. */
export interface TurnContext {
  /** All messages in the turn (user + assistant + tool results). */
  messages: unknown[];
  /** Opaque session key identifying the conversation. */
  sessionKey: string;
  /** Optional sub-session identifier. */
  sessionId?: string;
  /** Whether the turn completed successfully. */
  success: boolean;
}

// ============================
// Runtime context (from adapter → MemoryPlugin)
// ============================

/**
 * Minimal runtime identity the SDK needs from the adapter at boot time.
 * Session-level overrides (userId, sessionId, sessionKey) are resolved
 * per-hook from PromptContext / TurnContext.
 */
export interface PluginRuntimeIdentity {
  /** Default user identifier (e.g. "default_user"). */
  userId?: string;
  /** Agent identity or profile name (optional). */
  agentIdentity?: string;
  /** Agent execution context. */
  agentContext?: "primary" | "subagent" | "cron" | "flush";
}
