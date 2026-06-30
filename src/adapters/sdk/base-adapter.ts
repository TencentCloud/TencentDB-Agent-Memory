/**
 * BasePlatformAdapter — Abstract base class for platform adapters.
 *
 * Provides 80% of common functionality so platform adapters only need to
 * implement platform-specific logic. Subclasses override hook methods to
 * customize behavior.
 *
 * Features implemented:
 * - Unified logging with consistent prefix
 * - Configuration validation and merging
 * - Error handling with retry logic
 * - Lifecycle state machine
 * - Event emission for observability
 * - Health check framework
 *
 * Usage:
 * ```typescript
 * class MyPlatformAdapter extends BasePlatformAdapter {
 *   protected async doInitialize(): Promise<void> {
 *     // Platform-specific initialization
 *   }
 *   protected async doDispose(): Promise<void> {
 *     // Platform-specific cleanup
 *   }
 *   protected createLLMRunnerFactory(): LLMRunnerFactory {
 *     return new MyPlatformLLMFactory();
 *   }
 *   protected createRuntimeContext(): RuntimeContext {
 *     return { /* platform-specific context */ };
 *   }
 * }
 * ```
 */

import type {
  PlatformAdapter,
  AdapterConfig,
  PlatformCapabilities,
  MemorySearchResult,
  ConversationSearchResult,
  DiagnosticExportOptions,
} from "./platform-adapter.interface.js";
import type { RuntimeContext, Logger, LLMRunnerFactory, RecallResult, CaptureResult, CompletedTurn, MemorySearchParams, ConversationSearchParams } from "../../core/types.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { LifecycleManager } from "../lifecycle-manager.js";
import type { EventEmitter } from "../event-emitter.js";
import type { ConfigValidator } from "../config-validator.js";
import type { ErrorHandler } from "../error-handler.js";
import { DefaultEventEmitter } from "../event-emitter.js";
import { DefaultConfigValidator } from "../config-validator.js";
import { DefaultErrorHandler } from "../error-handler.js";
import { DefaultToolRegistry } from "../tool-registry.js";
import { DefaultLifecycleManager } from "../lifecycle-manager.js";

// ============================
// Lifecycle states
// ============================

export enum AdapterLifecycleState {
  /** Adapter created but not initialized */
  CREATED = "created",
  /** Initialization in progress */
  INITIALIZING = "initializing",
  /** Fully initialized and ready */
  READY = "ready",
  /** Shutdown in progress */
  DISPOSING = "disposing",
  /** Fully disposed */
  DISPOSED = "disposed",
}

// ============================
// Base adapter options
// ============================

export interface BasePlatformAdapterOptions {
  /** Platform identifier (e.g., 'openclaw', 'hermes') */
  platformId: string;
  /** Human-readable platform name */
  platformName: string;
  /** Minimum supported platform version */
  minVersion?: string;
  /** Platform capabilities (defaults to all true) */
  capabilities?: Partial<PlatformCapabilities>;
  /** Default configuration */
  defaultConfig?: AdapterConfig;
  /** Custom event emitter */
  eventEmitter?: EventEmitter;
  /** Custom config validator */
  configValidator?: ConfigValidator;
  /** Custom error handler */
  errorHandler?: ErrorHandler;
  /** Custom tool registry */
  toolRegistry?: ToolRegistry;
  /** Custom lifecycle manager */
  lifecycleManager?: LifecycleManager;
  /** Lifecycle state change callback */
  onStateChange?: (state: AdapterLifecycleState) => void;
}

// ============================
// Retry options
// ============================

export interface RetryOptions {
  /** Maximum number of retries */
  maxRetries?: number;
  /** Initial delay in ms */
  initialDelayMs?: number;
  /** Maximum delay in ms */
  maxDelayMs?: number;
  /** Backoff multiplier */
  backoffMultiplier?: number;
  /** Whether to retry on specific errors */
  retryableErrors?: (string | RegExp)[];
}

// ============================
// BasePlatformAdapter
// ============================

export abstract class BasePlatformAdapter implements PlatformAdapter {
  /** @implements PlatformAdapter */
  abstract readonly platformId: string;

  /** @implements PlatformAdapter */
  abstract readonly platformName: string;

  /** @implements PlatformAdapter */
  readonly minVersion: string;

  /** @implements PlatformAdapter */
  readonly capabilities: PlatformCapabilities;

  // ─────────────────────────────
  // Internal state
  // ─────────────────────────────

  protected logger: Logger | undefined;
  protected config: AdapterConfig;
  protected runtimeContext: RuntimeContext | undefined;
  protected llmRunnerFactory: LLMRunnerFactory | undefined;
  protected lifecycleState: AdapterLifecycleState = AdapterLifecycleState.CREATED;

  // ─────────────────────────────
  // Injected dependencies
  // ─────────────────────────────

  protected eventEmitter: EventEmitter;
  protected configValidator: ConfigValidator;
  protected errorHandler: ErrorHandler;
  protected toolRegistry: ToolRegistry;
  protected lifecycleManager: LifecycleManager;

  // ─────────────────────────────
  // Callbacks
  // ─────────────────────────────

  protected readonly onStateChange?: (state: AdapterLifecycleState) => void;

  // ─────────────────────────────
  // Constants
  // ─────────────────────────────

  protected readonly LOG_PREFIX: string;
  protected readonly DEFAULT_RETRY_OPTIONS: Required<RetryOptions>;

  constructor(opts: BasePlatformAdapterOptions) {
    this.minVersion = opts.minVersion ?? "1.0.0";
    this.capabilities = {
      supportsRecall: true,
      supportsCapture: true,
      supportsTools: true,
      supportsHttpGateway: false,
      supportsCli: false,
      supportsDataDir: true,
      supportsGracefulShutdown: true,
      ...opts.capabilities,
    };

    this.config = {
      enabled: true,
      ...opts.defaultConfig,
    };

    this.LOG_PREFIX = `[memory-tdai] [adapter:${opts.platformId}]`;

    this.eventEmitter = opts.eventEmitter ?? new DefaultEventEmitter();
    this.configValidator = opts.configValidator ?? new DefaultConfigValidator();
    this.errorHandler = opts.errorHandler ?? new DefaultErrorHandler({ logger: this.getDefaultLogger() });
    this.toolRegistry = opts.toolRegistry ?? new DefaultToolRegistry({ platformId: opts.platformId });
    this.lifecycleManager = opts.lifecycleManager ?? new DefaultLifecycleManager({ platformId: opts.platformId });
    this.onStateChange = opts.onStateChange;

    this.DEFAULT_RETRY_OPTIONS = {
      maxRetries: 3,
      initialDelayMs: 100,
      maxDelayMs: 5000,
      backoffMultiplier: 2,
      retryableErrors: [/network/i, /timeout/i, /ECONNREFUSED/i],
    };
  }

  // ============================
  // PlatformAdapter implementation
  // ============================

  /** @implements PlatformAdapter */
  async initialize(logger: Logger, config: AdapterConfig): Promise<void> {
    if (this.lifecycleState !== AdapterLifecycleState.CREATED) {
      this.warn(`initialize() called in state ${this.lifecycleState}, ignoring`);
      return;
    }

    this.setState(AdapterLifecycleState.INITIALIZING);
    this.logger = this.wrapLogger(logger);
    this.config = this.mergeConfig(this.config, config);

    this.info("Initializing adapter...");

    try {
      // Validate configuration
      const validation = await this.configValidator.validate(this.config, this.getConfigSchema());
      if (!validation.valid) {
        throw new Error(`Configuration validation failed: ${validation.errors.map(e => e.message).join(", ")}`);
      }
      if (validation.warnings.length > 0) {
        this.warn(`Configuration warnings: ${validation.warnings.map(w => w.message).join(", ")}`);
      }

      // Create LLM runner factory
      this.llmRunnerFactory = this.createLLMRunnerFactory();

      // Create runtime context
      this.runtimeContext = this.createRuntimeContext();

      // Run platform-specific initialization
      await this.withErrorHandling("doInitialize", () => this.doInitialize());

      // Register default tools
      if (this.capabilities.supportsTools) {
        await this.registerTools(this.toolRegistry);
      }

      this.setState(AdapterLifecycleState.READY);
      this.info("Adapter initialized successfully");

      this.emit("lifecycle:init", { platformId: this.platformId, timestamp: Date.now() });
    } catch (error) {
      this.setState(AdapterLifecycleState.CREATED);
      this.error(`Initialization failed: ${this.errorHandler.formatError(error)}`);
      throw error;
    }
  }

  /** @implements PlatformAdapter */
  async registerTools(_registry: ToolRegistry): Promise<void> {
    // Default implementation: register standard TDAI tools
    this.toolRegistry.register("tdai_memory_search", {
      name: "tdai_memory_search",
      label: "Memory Search",
      description: "Search through the user's long-term memories",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Max results" },
          type: { type: "string", description: "Memory type filter" },
          scene: { type: "string", description: "Scene filter" },
        },
        required: ["query"],
      },
    });

    this.toolRegistry.register("tdai_conversation_search", {
      name: "tdai_conversation_search",
      label: "Conversation Search",
      description: "Search through past conversation history",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Max results" },
          session_key: { type: "string", description: "Session filter" },
        },
        required: ["query"],
      },
    });
  }

  /** @implements PlatformAdapter */
  getLLMRunnerFactory(): LLMRunnerFactory {
    if (!this.llmRunnerFactory) {
      throw new Error("Adapter not initialized. Call initialize() first.");
    }
    return this.llmRunnerFactory;
  }

  /** @implements PlatformAdapter */
  getRuntimeContext(): RuntimeContext {
    if (!this.runtimeContext) {
      throw new Error("Adapter not initialized. Call initialize() first.");
    }
    return this.runtimeContext;
  }

  /** @implements PlatformAdapter */
  async dispose(): Promise<void> {
    if (this.lifecycleState === AdapterLifecycleState.DISPOSED) {
      this.debug("dispose() called when already disposed, ignoring");
      return;
    }

    if (this.lifecycleState !== AdapterLifecycleState.READY) {
      this.warn(`dispose() called in state ${this.lifecycleState}, forcing disposal`);
    }

    this.setState(AdapterLifecycleState.DISPOSING);
    this.info("Disposing adapter...");

    try {
      await this.withErrorHandling("doDispose", () => this.doDispose());

      this.setState(AdapterLifecycleState.DISPOSED);
      this.info("Adapter disposed successfully");

      this.emit("lifecycle:dispose", { platformId: this.platformId, timestamp: Date.now() });
    } catch (error) {
      this.setState(AdapterLifecycleState.DISPOSED);
      this.error(`Disposal completed with errors: ${this.errorHandler.formatError(error)}`);
    }
  }

  // ─────────────────────────────
  // Memory capability stubs (override in subclass or via TDAI core)
  // ─────────────────────────────

  /** @implements PlatformAdapter */
  async handleBeforeRecall(_userText: string, _sessionKey: string): Promise<RecallResult> {
    this.warn("handleBeforeRecall not implemented - override or connect to TDAI core");
    return {};
  }

  /** @implements PlatformAdapter */
  async handleTurnCommitted(_turn: CompletedTurn): Promise<CaptureResult> {
    this.warn("handleTurnCommitted not implemented - override or connect to TDAI core");
    return { l0RecordedCount: 0, schedulerNotified: false, l0VectorsWritten: 0, filteredMessages: [] };
  }

  /** @implements PlatformAdapter */
  async searchMemories(_params: MemorySearchParams): Promise<MemorySearchResult> {
    this.warn("searchMemories not implemented - override or connect to TDAI core");
    return { text: "Memory search not available", total: 0, strategy: "none" };
  }

  /** @implements PlatformAdapter */
  async searchConversations(_params: ConversationSearchParams): Promise<ConversationSearchResult> {
    this.warn("searchConversations not implemented - override or connect to TDAI core");
    return { text: "Conversation search not available", total: 0 };
  }

  // ─────────────────────────────
  // SKILL methods (optional implementations)
  // ─────────────────────────────

  /** @implements PlatformAdapter */
  async checkEnvironment(): Promise<{
    passed: boolean;
    issues: Array<{ code: string; message: string; severity: "error" | "warn" }>;
  }> {
    const issues: Array<{ code: string; message: string; severity: "error" | "warn" }> = [];

    // Check Node.js version
    const nodeVersion = process.version;
    const minNodeVersion = "22.16.0";
    if (this.compareVersions(nodeVersion, minNodeVersion) < 0) {
      issues.push({
        code: "NODE_VERSION",
        message: `Node.js ${minNodeVersion}+ required, found ${nodeVersion}`,
        severity: "error",
      });
    }

    return {
      passed: issues.filter(i => i.severity === "error").length === 0,
      issues,
    };
  }

  /** @implements PlatformAdapter */
  async validateConfig(config: AdapterConfig): Promise<{
    valid: boolean;
    errors: Array<{ field: string; message: string }>;
    warnings: Array<{ field: string; message: string }>;
  }> {
    return this.configValidator.validate(config, this.getConfigSchema());
  }

  /** @implements PlatformAdapter */
  getHealthStatus(): Promise<{
    healthy: boolean;
    details: Record<string, unknown>;
  }> {
    return Promise.resolve({
      healthy: this.lifecycleState === AdapterLifecycleState.READY,
      details: {
        state: this.lifecycleState,
        platformId: this.platformId,
        version: this.minVersion,
      },
    });
  }

  /** @implements PlatformAdapter */
  getLifecycleManager(): LifecycleManager {
    return this.lifecycleManager;
  }

  // ============================
  // Protected hook methods (override in subclass)
  // ============================

  /**
   * Platform-specific initialization logic.
   * Called during initialize() after basic setup is complete.
   */
  protected async doInitialize(): Promise<void> {
    // Default: no-op
  }

  /**
   * Platform-specific disposal logic.
   * Called during dispose() before cleanup.
   */
  protected async doDispose(): Promise<void> {
    // Default: no-op
  }

  /**
   * Create the LLM runner factory for this platform.
   * Must be implemented by subclass.
   */
  protected abstract createLLMRunnerFactory(): LLMRunnerFactory;

  /**
   * Create the runtime context for this platform.
   * Must be implemented by subclass.
   */
  protected abstract createRuntimeContext(): RuntimeContext;

  /**
   * Get the configuration schema for validation.
   * Override to provide custom validation rules.
   */
  protected getConfigSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        dataDir: { type: "string" },
        excludeAgents: { type: "array", items: { type: "string" } },
      },
    };
  }

  // ============================
  // Utility methods
  // ============================

  /**
   * Execute an operation with error handling and optional retry.
   */
  protected async withErrorHandling<T>(
    operationName: string,
    operation: () => Promise<T>,
    options?: RetryOptions
  ): Promise<T> {
    const opts = { ...this.DEFAULT_RETRY_OPTIONS, ...options };
    let lastError: unknown;
    let delay = opts.initialDelayMs;

    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const errorMsg = error instanceof Error ? error.message : String(error);
        const isRetryable = opts.retryableErrors.some(pattern =>
          pattern instanceof RegExp ? pattern.test(errorMsg) : errorMsg.includes(pattern)
        );

        if (attempt < opts.maxRetries && isRetryable) {
          this.warn(`${operationName} failed (attempt ${attempt + 1}/${opts.maxRetries + 1}): ${errorMsg}, retrying in ${delay}ms`);
          await this.sleep(delay);
          delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelayMs);
        } else {
          this.error(`${operationName} failed: ${errorMsg}`);
          throw error;
        }
      }
    }

    throw lastError;
  }

  /**
   * Emit an event through the event emitter.
   */
  protected emit(event: string, data?: Record<string, unknown>): void {
    this.eventEmitter.emit(event, data);
  }

  /**
   * Subscribe to an event.
   */
  protected on(event: string, handler: (data: Record<string, unknown>) => void): () => void {
    return this.eventEmitter.on(event, handler);
  }

  /**
   * Wrap the provided logger with consistent prefix.
   */
  protected wrapLogger(logger: Logger): Logger {
    const prefix = this.LOG_PREFIX;
    return {
      debug: logger.debug ? (msg: string) => logger.debug!(`${prefix} ${msg}`) : undefined,
      info: (msg: string) => logger.info(`${prefix} ${msg}`),
      warn: (msg: string) => logger.warn(`${prefix} ${msg}`),
      error: (msg: string) => logger.error(`${prefix} ${msg}`),
    };
  }

  /**
   * Get a default logger for internal use.
   */
  protected getDefaultLogger(): Logger {
    return {
      info: (msg: string) => console.log(`${this.LOG_PREFIX} ${msg}`),
      warn: (msg: string) => console.warn(`${this.LOG_PREFIX} ${msg}`),
      error: (msg: string) => console.error(`${this.LOG_PREFIX} ${msg}`),
    };
  }

  // ─────────────────────────────
  // Logging shortcuts
  // ─────────────────────────────

  protected debug(msg: string): void {
    this.logger?.debug?.(msg);
  }

  protected info(msg: string): void {
    this.logger?.info(msg);
  }

  protected warn(msg: string): void {
    this.logger?.warn(msg);
  }

  protected error(msg: string): void {
    this.logger?.error(msg);
  }

  // ─────────────────────────────
  // Internal helpers
  // ─────────────────────────────

  private setState(state: AdapterLifecycleState): void {
    this.lifecycleState = state;
    this.onStateChange?.(state);
    this.emit("lifecycle:stateChange", { state, platformId: this.platformId });
  }

  private mergeConfig(base: AdapterConfig, overrides: AdapterConfig): AdapterConfig {
    return {
      ...base,
      ...overrides,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private compareVersions(v1: string, v2: string): number {
    const parts1 = v1.replace(/^v/, "").split(".").map(Number);
    const parts2 = v2.replace(/^v/, "").split(".").map(Number);
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const p1 = parts1[i] ?? 0;
      const p2 = parts2[i] ?? 0;
      if (p1 > p2) return 1;
      if (p1 < p2) return -1;
    }
    return 0;
  }
}
