/**
 * PlatformAdapter — Unified interface for TDAI memory platform integrations.
 *
 * This interface defines the contract that all platform adapters must implement
 * to integrate with the TDAI memory system. New platforms (Claude Code, Codex,
 * Dify, etc.) only need to implement this interface to gain full memory
 * capabilities (L0 capture, L1-L3 pipeline, recall, search).
 *
 * Design goals:
 * 1. Minimal implementation burden — only 5 core methods required
 * 2. Host-neutral — no OpenClaw, Hermes, or Claude Code dependencies
 * 3. Lifecycle-aware — supports graceful install/uninstall/upgrade
 * 4. Tool registration — enables agent-callable memory tools
 * 5. Event-driven — hooks for before_prompt_build, agent_end, etc.
 *
 * Usage:
 * ```typescript
 * class MyPlatformAdapter implements PlatformAdapter {
 *   async initialize(): Promise<void> { /* platform-specific init *\/ }
 *   async registerTools(registry): Promise<void> { /* register tdai_memory_search, etc. *\/ }
 *   async handleBeforeRecall(params): Promise<RecallResult> { /* call core.handleBeforeRecall *\/ }
 *   async handleTurnCommitted(params): Promise<CaptureResult> { /* call core.handleTurnCommitted *\/ }
 *   async dispose(): Promise<void> { /* cleanup *\/ }
 * }
 * ```
 *
 * @example
 * // Quick start for new platform:
 * class ClaudeCodeAdapter extends BasePlatformAdapter {
 *   protected async doInstall(): Promise<void> {
 *     // Claude Code specific installation logic
 *   }
 *   protected async doUninstall(): Promise<void> {
 *     // Claude Code specific uninstallation logic
 *   }
 * }
 */

import type { RuntimeContext, Logger, LLMRunnerFactory } from "../core/types.js";
import type { RecallResult, CaptureResult, CompletedTurn, MemorySearchParams, ConversationSearchParams } from "../core/types.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { LifecycleManager } from "./lifecycle-manager.js";

// ============================
// Tool result types
// ============================

export interface MemorySearchResult {
  text: string;
  total: number;
  strategy: string;
}

export interface ConversationSearchResult {
  text: string;
  total: number;
}

// ============================
// Configuration types
// ============================

export interface AdapterConfig {
  /** Whether memory is enabled (default: true) */
  enabled?: boolean;
  /** Data directory for memory storage */
  dataDir?: string;
  /** Session filter patterns (agents to exclude) */
  excludeAgents?: string[];
  /** Custom configuration passed to TDAI core */
  [key: string]: unknown;
}

export interface InstallOptions {
  /** Dry run mode — validate but don't execute */
  dryRun?: boolean;
  /** Force reinstall even if already installed */
  force?: boolean;
  /** Custom data directory (default: platform-specific) */
  dataDir?: string;
  /** Skip health check after installation */
  skipHealthCheck?: boolean;
}

export interface DiagnosticExportOptions {
  /** Output directory for diagnostic files */
  outputDir?: string;
  /** Include sensitive configuration (API keys) */
  includeSensitive?: boolean;
  /** Include memory data (may be large) */
  includeMemoryData?: boolean;
  /** Export format: 'tar' or 'zip' */
  format?: "tar" | "zip";
}

// ============================
// Platform capability flags
// ============================

export interface PlatformCapabilities {
  /** Supports before_prompt_build hook */
  supportsRecall?: boolean;
  /** Supports agent_end hook */
  supportsCapture?: boolean;
  /** Supports tool registration */
  supportsTools?: boolean;
  /** Supports HTTP Gateway mode */
  supportsHttpGateway?: boolean;
  /** Supports CLI mode */
  supportsCli?: boolean;
  /** Supports data directory management */
  supportsDataDir?: boolean;
  /** Supports graceful shutdown hooks */
  supportsGracefulShutdown?: boolean;
}

// ============================
// PlatformAdapter interface
// ============================

export interface PlatformAdapter {
  /** Unique platform identifier (e.g., 'openclaw', 'hermes', 'claude-code') */
  readonly platformId: string;

  /** Human-readable platform name */
  readonly platformName: string;

  /** Platform version requirement (semver range) */
  readonly minVersion: string;

  /** Platform capabilities */
  readonly capabilities: PlatformCapabilities;

  // ─────────────────────────────
  // Lifecycle methods
  // ─────────────────────────────

  /**
   * Initialize the adapter and connect to TDAI core.
   * Called once during platform startup.
   *
   * @param logger - Logger instance for diagnostic output
   * @param config - Adapter configuration
   * @returns Promise that resolves when initialization is complete
   */
  initialize(logger: Logger, config: AdapterConfig): Promise<void>;

  /**
   * Register memory tools with the platform's tool system.
   * Called during initialize() if supportsTools is true.
   *
   * @param registry - Tool registry for registering TDAI tools
   */
  registerTools(registry: ToolRegistry): Promise<void>;

  /**
   * Get the LLM runner factory for this platform.
   * Used by TDAI core for L1/L2/L3 extraction.
   *
   * @returns LLM runner factory instance
   */
  getLLMRunnerFactory(): LLMRunnerFactory;

  /**
   * Get the runtime context for the current session.
   * Called before each recall/capture operation.
   *
   * @returns Current session runtime context
   */
  getRuntimeContext(): RuntimeContext;

  /**
   * Dispose of adapter resources.
   * Called during platform shutdown.
   */
  dispose(): Promise<void>;

  // ─────────────────────────────
  // Memory capability methods
  // ─────────────────────────────

  /**
   * Handle recall (memory retrieval) before an LLM turn.
   * Maps to: before_prompt_build hook.
   *
   * @param userText - User's current message
   * @param sessionKey - Unique session identifier
   * @returns Recall result with context to inject
   */
  handleBeforeRecall(userText: string, sessionKey: string): Promise<RecallResult>;

  /**
   * Handle turn commitment (conversation capture + pipeline trigger).
   * Maps to: agent_end hook.
   *
   * @param turn - Completed conversation turn
   * @returns Capture result
   */
  handleTurnCommitted(turn: CompletedTurn): Promise<CaptureResult>;

  /**
   * Search L1 structured memories.
   * Maps to: tdai_memory_search tool.
   *
   * @param params - Search parameters
   * @returns Formatted search results
   */
  searchMemories(params: MemorySearchParams): Promise<MemorySearchResult>;

  /**
   * Search L0 raw conversations.
   * Maps to: tdai_conversation_search tool.
   *
   * @param params - Search parameters
   * @returns Formatted search results
   */
  searchConversations(params: ConversationSearchParams): Promise<ConversationSearchResult>;

  // ─────────────────────────────
  // SKILL methods (optional)
  // ─────────────────────────────

  /**
   * Check environment requirements.
   * @returns Object with check results
   */
  checkEnvironment?(): Promise<{
    passed: boolean;
    issues: Array<{ code: string; message: string; severity: "error" | "warn" }>;
  }>;

  /**
   * Install the plugin to the platform.
   * @param options - Installation options
   */
  install?(options?: InstallOptions): Promise<{ success: boolean; message?: string }>;

  /**
   * Uninstall the plugin from the platform.
   */
  uninstall?(): Promise<{ success: boolean; message?: string }>;

  /**
   * Migrate from old plugin version.
   * @param oldVersion - Version to migrate from
   */
  migrate?(oldVersion: string): Promise<{ success: boolean; message?: string }>;

  /**
   * Export diagnostic data for troubleshooting.
   * @param options - Export options
   */
  exportDiagnostic?(options?: DiagnosticExportOptions): Promise<{
    success: boolean;
    outputPath?: string;
    files?: string[];
  }>;

  /**
   * Validate adapter configuration.
   * @param config - Configuration to validate
   * @returns Validation result
   */
  validateConfig?(config: AdapterConfig): Promise<{
    valid: boolean;
    errors: Array<{ field: string; message: string }>;
    warnings: Array<{ field: string; message: string }>;
  }>;

  /**
   * Get adapter health status.
   */
  getHealthStatus?(): Promise<{
    healthy: boolean;
    details: Record<string, unknown>;
  }>;

  /**
   * Get the lifecycle manager for advanced control.
   */
  getLifecycleManager?(): LifecycleManager | undefined;
}

// ============================
// Type exports for consumers
// ============================

export type {
  AdapterConfig,
  InstallOptions,
  DiagnosticExportOptions,
  PlatformCapabilities,
  MemorySearchResult,
  ConversationSearchResult,
} from "./types.js";
