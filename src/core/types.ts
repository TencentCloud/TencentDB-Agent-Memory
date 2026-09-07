/**
 * TDAI Core — Host-neutral type definitions and abstract interfaces.
 *
 * These types define the boundary between TDAI Core (memory algorithms)
 * and the host environment (OpenClaw, Hermes, standalone Gateway, etc.).
 *
 * Design principles:
 * 1. TDAI Core depends ONLY on these interfaces — never on a specific host.
 * 2. Each host provides its own implementation of HostAdapter + LLMRunnerFactory.
 * 3. RuntimeContext is the single source of truth for session/user identity.
 */

// ============================
// Logger (unified across all layers)
// ============================

/**
 * Canonical logger interface used across all TDAI modules.
 *
 * Named variants (StoreLogger, PluginLogger, etc.) are type aliases
 * of this interface, kept for backward compatibility.
 */
export interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

// ============================
// RuntimeContext
// ============================

/**
 * Unified runtime context — provides identity, scoping, and path information.
 *
 * In OpenClaw: populated from `pluginConfig`, `sessionKey`, `resolveStateDir()`.
 * In Hermes:   populated from `MemoryProvider.initialize()` kwargs.
 * In Gateway:  populated from HTTP request parameters.
 */
export interface RuntimeContext {
  /** User identifier (e.g. "default_user" for CLI, platform user ID for gateway). */
  userId: string;
  /** Session identifier (unique per conversation session). */
  sessionId: string;
  /** Session key (stable across reconnects, used for L0/L1 grouping). */
  sessionKey: string;
  /** Host platform identifier. */
  platform: "openclaw" | "hermes" | "cli" | "gateway" | string;
  /** Agent identity / profile name (optional). */
  agentIdentity?: string;
  /** Agent execution context — primary agent, subagent, cron job, or flush task. */
  agentContext?: "primary" | "subagent" | "cron" | "flush";
  /** Workspace directory (for tool sandbox, if applicable). */
  workspaceDir: string;
  /** Plugin/provider data directory (L0, records, scene_blocks, etc.). */
  dataDir: string;
}

// ============================
// LLMRunner
// ============================

/** Parameters for a single LLM execution. */
export interface LLMRunParams {
  /** User-facing prompt (or combined prompt if no systemPrompt). */
  prompt: string;
  /** Optional system prompt. When provided, `prompt` is used as the user message. */
  systemPrompt?: string;
  /** Unique task identifier for logging and metrics. */
  taskId: string;
  /** Execution timeout in milliseconds (default: 120_000). */
  timeoutMs?: number;
  /** Max output tokens (optional — defaults to model catalog value). */
  maxTokens?: number;
  /**
   * Working directory for tool-enabled runs.
   * When `enableTools` is true, the LLM's file tools resolve paths relative to this dir.
   * When omitted, a clean empty workspace is used.
   */
  workspaceDir?: string;
  /** Plugin instance ID for metric reporting (optional). */
  instanceId?: string;
}

/**
 * Unified LLM execution interface.
 *
 * Replaces direct usage of `CleanContextRunner` throughout TDAI Core.
 *
 * Implementations:
 * - `OpenClawLLMRunner`: wraps `CleanContextRunner` / `runEmbeddedPiAgent` (OpenClaw host)
 * - `StandaloneLLMRunner`: direct OpenAI-compatible HTTP calls (Gateway / Hermes host)
 */
export interface LLMRunner {
  /**
   * Execute a prompt and return the LLM's text output.
   *
   * Behavior depends on the factory configuration:
   * - `enableTools: false` → pure text output (used by L1 extraction, L1 dedup)
   * - `enableTools: true`  → LLM may call file tools (used by L2 scene, L3 persona)
   *
   * @returns The LLM's text response. Empty string if the LLM produces no output.
   * @throws On timeout, network errors, or unrecoverable LLM failures.
   */
  run(params: LLMRunParams): Promise<string>;
}

// ============================
// LLMRunnerFactory
// ============================

/** Options for creating an LLMRunner instance. */
export interface LLMRunnerCreateOptions {
  /**
   * Full "provider/model" string (e.g. "openai/gpt-4o").
   * Takes precedence over host default model.
   */
  modelRef?: string;
  /**
   * Whether the runner should allow tool calls (read_file, write_to_file, etc.).
   * Default: false (text-only output).
   */
  enableTools?: boolean;
}

/**
 * Factory for creating LLMRunner instances.
 *
 * Each host provides its own factory implementation that knows how to
 * configure runners with the correct model, API keys, and tool sandbox.
 */
export interface LLMRunnerFactory {
  createRunner(opts?: LLMRunnerCreateOptions): LLMRunner;
}

// ============================
// HostAdapter
// ============================

/**
 * Host adapter — translates host-specific events, context, and capabilities
 * into TDAI Core's unified interface.
 *
 * Each host environment provides exactly one HostAdapter implementation:
 * - OpenClaw:    `OpenClawHostAdapter` — wraps `OpenClawPluginApi`
 * - Hermes/GW:   `StandaloneHostAdapter` — wraps Gateway HTTP request context
 *
 * HostAdapter answers these questions for TDAI Core:
 * - "Who is the current user/session?" → `getRuntimeContext()`
 * - "How do I call an LLM?"           → `getLLMRunnerFactory()`
 * - "Where do I log?"                 → `getLogger()`
 */
export interface HostAdapter {
  /** Identifies the host type for conditional behavior (should be rare). */
  readonly hostType: "openclaw" | "hermes" | "standalone";

  /** Get the unified runtime context for the current session. */
  getRuntimeContext(): RuntimeContext;

  /** Get the logger instance provided by the host. */
  getLogger(): Logger;

  /** Get the LLM runner factory configured for this host. */
  getLLMRunnerFactory(): LLMRunnerFactory;
}

// ============================
// CompletedTurn — represents a finished conversation turn
// ============================

/** A completed conversation turn, ready for capture/storage. */
export interface CompletedTurn {
  /** The user's original message text. */
  userText: string;
  /** The assistant's response text. */
  assistantText: string;
  /** All messages in the turn (may include tool call results, etc.). */
  messages: unknown[];
  /** Session key for this turn. */
  sessionKey: string;
  /** Session ID within the session key (optional, for sub-session grouping). */
  sessionId?: string;
  /** Epoch ms when this turn started. */
  startedAt?: number;
  /**
   * Number of messages in the session at before_prompt_build time.
   * Used by l0-recorder to locate the exact user message that was
   * augmented by dynamic recall injection.
   */
  originalUserMessageCount?: number;
}

// ============================
// Core service result types
// ============================

/** Result from a recall (prefetch) operation. */
export interface RecalledMemory {
  content: string;
  score: number;
  type: string;
}

export interface RecallResult {
  /** Dynamic L1 recall content for the current turn. Placement is host-defined. */
  dynamicContext?: string;
  /** Stable recall content (persona, scene nav, tools guide). Placement is host-defined. */
  stableContext?: string;
  /** Recalled L1 memories with scores (for metrics). */
  recalledL1Memories?: RecalledMemory[];
  /** L3 Persona content (for metrics). */
  recalledL3Persona?: string | null;
  /** Search strategy used. */
  recallStrategy?: string;
}

/** Result from a capture (sync_turn) operation. */
export interface CaptureResult {
  /** Number of L0 messages recorded. */
  l0RecordedCount: number;
  /** Whether the pipeline scheduler was notified. */
  schedulerNotified: boolean;
  /** Number of L0 vectors written. */
  l0VectorsWritten: number;
  /** Filtered messages that were captured. */
  filteredMessages: Array<{
    role: string;
    content: string;
    timestamp: number;
  }>;
}

/** Search parameters for L1 memory search. */
export interface MemorySearchParams {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

/** Search parameters for L0 conversation search. */
export interface ConversationSearchParams {
  query: string;
  limit?: number;
  sessionKey?: string;
}
