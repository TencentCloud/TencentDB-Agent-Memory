/**
 * TDAI Platform Adapter SDK
 *
 * A unified SDK for integrating TDAI memory capabilities with any Agent platform.
 * New platforms only need to implement the PlatformAdapter interface.
 *
 * @example
 * ```typescript
 * import { BasePlatformAdapter } from "./base-adapter.js";
 *
 * class MyPlatformAdapter extends BasePlatformAdapter {
 *   readonly platformId = "my-platform";
 *   readonly platformName = "My Platform";
 *
 *   protected createLLMRunnerFactory() {
 *     return new MyPlatformLLMFactory();
 *   }
 *
 *   protected createRuntimeContext() {
 *     return { /* platform-specific context */ };
 *   }
 * }
 * ```
 */

// Core interfaces and base classes
export { PlatformAdapter } from "./platform-adapter.interface.js";
export type {
  AdapterConfig,
  InstallOptions,
  DiagnosticExportOptions,
  PlatformCapabilities,
  MemorySearchResult,
  ConversationSearchResult,
} from "./platform-adapter.interface.js";

export { BasePlatformAdapter, AdapterLifecycleState } from "./base-adapter.js";
export type { BasePlatformAdapterOptions, RetryOptions } from "./base-adapter.js";

// Tool registry
export { DefaultToolRegistry } from "./tool-registry.js";
export type {
  ToolDefinition,
  ToolCallContext,
  ToolInterceptor,
  ToolRegistryOptions,
} from "./tool-registry.js";
export interface ToolRegistry {
  register(name: string, definition: ToolDefinition): void;
  registerExecutor(name: string, executor: (params: Record<string, unknown>) => Promise<unknown>): void;
  unregister(name: string): boolean;
  get(name: string): ToolDefinition | undefined;
  getAll(): ToolDefinition[];
  getEnabled(): ToolDefinition[];
  isRegistered(name: string): boolean;
  isEnabled(name: string): boolean;
  enable(name: string): void;
  disable(name: string): void;
  execute(callId: string, name: string, params: Record<string, unknown>): Promise<unknown>;
  addInterceptor(interceptor: ToolInterceptor): () => void;
  getHistory(): ToolCallContext[];
  getMetrics(): {
    totalCalls: number;
    successCount: number;
    errorCount: number;
    averageDurationMs: number;
    toolCallCounts: Record<string, number>;
  };
  clearHistory(): void;
  generateCallId(): string;
}

// Lifecycle manager
export { DefaultLifecycleManager, LifecycleState } from "./lifecycle-manager.js";
export type {
  HealthCheckResult,
  HealthCheck,
  LifecycleHooks,
  LifecycleManagerOptions,
} from "./lifecycle-manager.js";
export interface LifecycleManager {
  getState(): LifecycleState;
  getVersion(): string | undefined;
  setVersion(version: string): void;
  getPreviousState(): LifecycleState | undefined;
  isInState(...states: LifecycleState[]): boolean;
  canTransitionTo(targetState: LifecycleState): boolean;
  install(): Promise<boolean>;
  uninstall(): Promise<boolean>;
  start(): Promise<boolean>;
  stop(): Promise<boolean>;
  upgrade(fromVersion: string, toVersion: string): Promise<boolean>;
  registerHealthCheck(check: HealthCheck): void;
  unregisterHealthCheck(name: string): boolean;
  runHealthChecks(): Promise<HealthCheckResult[]>;
  getLastHealthCheck(): ReadonlyArray<HealthCheckResult>;
  isHealthy(): boolean;
  setHooks(hooks: Partial<LifecycleHooks>): void;
  clearHooks(): void;
  dispose(): void;
}

// Event emitter
export { DefaultEventEmitter, ADAPTER_EVENTS } from "./event-emitter.js";
export type {
  EventHandler,
  EventEmitterOptions,
  AdapterEventType,
} from "./event-emitter.js";

// Config validator
export { DefaultConfigValidator } from "./config-validator.js";
export type {
  ValidationRule,
  ValidationError,
  ValidationWarning,
  ValidationResult,
  ConfigValidatorOptions,
} from "./config-validator.js";
export interface ConfigValidator {
  validate(config: unknown, schema?: Record<string, unknown>): Promise<ValidationResult>;
  validateSync(config: unknown, schema?: Record<string, unknown>): ValidationResult;
  addRule(rule: ValidationRule): void;
  removeRule(path: string): void;
  getRules(): ValidationRule[];
}

// Error handler
export { DefaultErrorHandler, TdaiAdapterError, ERROR_CODES } from "./error-handler.js";
export type {
  ErrorCode,
  RetryConfig,
  ErrorHandlerOptions,
} from "./error-handler.js";
export interface ErrorHandler {
  createError(code: ErrorCode, message: string, options?: { originalError?: Error; context?: Record<string, unknown> }): TdaiAdapterError;
  wrapError(error: unknown, code: ErrorCode, message: string, context?: Record<string, unknown>): TdaiAdapterError;
  formatError(error: unknown): string;
  isRetryable(error: unknown): boolean;
  withRetry<T>(operation: () => Promise<T>, options?: Partial<RetryConfig>): Promise<T>;
  handleError(error: unknown, context?: Record<string, unknown>): TdaiAdapterError;
  getErrorCode(error: unknown): ErrorCode | undefined;
}
