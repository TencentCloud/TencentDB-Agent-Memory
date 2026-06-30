/**
 * ErrorHandler — Unified error handling with error codes and retry support.
 *
 * Features:
 * - Error code system for programmatic error handling
 * - Retry strategy configuration
 * - Error wrapping with context
 * - Formatted error messages
 */

import type { Logger } from "../../core/types.js";

// ============================
// Error codes
// ============================

export const ERROR_CODES = {
  // Lifecycle errors (1000-1099)
  ADAPTER_NOT_INITIALIZED: "E1000",
  ADAPTER_ALREADY_INITIALIZED: "E1001",
  ADAPTER_INITIALIZATION_FAILED: "E1002",
  ADAPTER_DISPOSE_FAILED: "E1003",

  // Configuration errors (2000-2099)
  CONFIG_INVALID: "E2000",
  CONFIG_MISSING_REQUIRED: "E2001",
  CONFIG_TYPE_MISMATCH: "E2002",

  // Memory errors (3000-3099)
  MEMORY_STORE_ERROR: "E3000",
  MEMORY_SEARCH_ERROR: "E3001",
  MEMORY_CAPTURE_ERROR: "E3002",
  MEMORY_RECALL_ERROR: "E3003",

  // Tool errors (4000-4099)
  TOOL_NOT_FOUND: "E4000",
  TOOL_EXECUTION_ERROR: "E4001",
  TOOL_REGISTRATION_ERROR: "E4002",

  // Network errors (5000-5099)
  NETWORK_ERROR: "E5000",
  NETWORK_TIMEOUT: "E5001",
  NETWORK_CONNECTION_REFUSED: "E5002",

  // Platform errors (9000-9099)
  PLATFORM_NOT_SUPPORTED: "E9000",
  PLATFORM_VERSION_MISMATCH: "E9001",
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

// ============================
// TdaiAdapterError
// ============================

export class TdaiAdapterError extends Error {
  public readonly code: ErrorCode;
  public readonly originalError?: Error;
  public readonly context: Record<string, unknown>;
  public readonly timestamp: number;

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      originalError?: Error;
      context?: Record<string, unknown>;
    }
  ) {
    super(message);
    this.name = "TdaiAdapterError";
    this.code = code;
    this.originalError = options?.originalError;
    this.context = options?.context ?? {};
    this.timestamp = Date.now();

    // Capture stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TdaiAdapterError);
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      originalError: this.originalError?.message,
      context: this.context,
      timestamp: this.timestamp,
      stack: this.stack,
    };
  }
}

// ============================
// Retry configuration
// ============================

export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Initial delay in milliseconds */
  initialDelayMs: number;
  /** Maximum delay in milliseconds */
  maxDelayMs: number;
  /** Backoff multiplier */
  backoffMultiplier: number;
  /** Jitter factor (0-1) */
  jitterFactor?: number;
  /** Error codes that should trigger retry */
  retryableCodes?: ErrorCode[];
  /** Error patterns that should trigger retry */
  retryablePatterns?: RegExp[];
}

export interface ErrorHandlerOptions {
  /** Logger instance */
  logger?: Logger;
  /** Default retry configuration */
  retryConfig?: Partial<RetryConfig>;
  /** Whether to log errors */
  logErrors?: boolean;
}

// ============================
// DefaultErrorHandler
// ============================

export class DefaultErrorHandler implements ErrorHandler {
  private logger?: Logger;
  private retryConfig: RetryConfig;
  private logErrors: boolean;

  constructor(opts: ErrorHandlerOptions = {}) {
    this.logger = opts.logger;
    this.logErrors = opts.logErrors ?? true;
    this.retryConfig = {
      maxRetries: 3,
      initialDelayMs: 100,
      maxDelayMs: 5000,
      backoffMultiplier: 2,
      jitterFactor: 0.1,
      retryableCodes: [
        ERROR_CODES.NETWORK_ERROR,
        ERROR_CODES.NETWORK_TIMEOUT,
        ERROR_CODES.NETWORK_CONNECTION_REFUSED,
      ],
      retryablePatterns: [/ECONNREFUSED/i, /ETIMEDOUT/i, /network/i],
      ...opts.retryConfig,
    };
  }

  /** @implements ErrorHandler */
  createError(
    code: ErrorCode,
    message: string,
    options?: {
      originalError?: Error;
      context?: Record<string, unknown>;
    }
  ): TdaiAdapterError {
    return new TdaiAdapterError(code, message, options);
  }

  /** @implements ErrorHandler */
  wrapError(error: unknown, code: ErrorCode, message: string, context?: Record<string, unknown>): TdaiAdapterError {
    const originalError = error instanceof Error ? error : undefined;
    const finalMessage = originalError ? `${message}: ${originalError.message}` : message;
    return this.createError(code, finalMessage, { originalError, context });
  }

  /** @implements ErrorHandler */
  formatError(error: unknown): string {
    if (error instanceof TdaiAdapterError) {
      return `[${error.code}] ${error.message}`;
    }
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }
    return String(error);
  }

  /** @implements ErrorHandler */
  isRetryable(error: unknown): boolean {
    if (error instanceof TdaiAdapterError) {
      return this.retryConfig.retryableCodes?.includes(error.code) ?? false;
    }

    const errorMsg = error instanceof Error ? error.message : String(error);
    return this.retryConfig.retryablePatterns?.some(pattern => pattern.test(errorMsg)) ?? false;
  }

  /** @implements ErrorHandler */
  async withRetry<T>(
    operation: () => Promise<T>,
    options?: Partial<RetryConfig>
  ): Promise<T> {
    const config = { ...this.retryConfig, ...options };
    let lastError: unknown;
    let delay = config.initialDelayMs;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        if (attempt < config.maxRetries && this.isRetryable(error)) {
          // Add jitter
          const jitter = config.jitterFactor ? (Math.random() * 2 - 1) * config.jitterFactor * delay : 0;
          const actualDelay = Math.min(delay + jitter, config.maxDelayMs);

          this.logger?.warn?.(
            `Retry ${attempt + 1}/${config.maxRetries} after ${Math.round(actualDelay)}ms: ${this.formatError(error)}`
          );

          await this.sleep(actualDelay);
          delay = Math.min(delay * config.backoffMultiplier, config.maxDelayMs);
        } else {
          throw error;
        }
      }
    }

    throw lastError;
  }

  /** @implements ErrorHandler */
  handleError(error: unknown, context?: Record<string, unknown>): TdaiAdapterError {
    if (this.logErrors) {
      const message = this.formatError(error);
      if (error instanceof TdaiAdapterError) {
        this.logger?.error(`[${error.code}] ${error.message}`);
      } else {
        this.logger?.error(message);
      }
    }

    if (error instanceof TdaiAdapterError) {
      return error;
    }

    return this.wrapError(
      error,
      ERROR_CODES.MEMORY_STORE_ERROR,
      "An unexpected error occurred",
      context
    );
  }

  /** @implements ErrorHandler */
  getErrorCode(error: unknown): ErrorCode | undefined {
    if (error instanceof TdaiAdapterError) {
      return error.code;
    }
    return undefined;
  }

  /** @implements ErrorHandler */
  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  // ============================
  // Private helpers
  // ============================

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================
// ErrorHandler interface
// ============================

export interface ErrorHandler {
  /**
   * Create a typed adapter error.
   */
  createError(
    code: ErrorCode,
    message: string,
    options?: {
      originalError?: Error;
      context?: Record<string, unknown>;
    }
  ): TdaiAdapterError;

  /**
   * Wrap an existing error with a typed adapter error.
   */
  wrapError(
    error: unknown,
    code: ErrorCode,
    message: string,
    context?: Record<string, unknown>
  ): TdaiAdapterError;

  /**
   * Format an error for display.
   */
  formatError(error: unknown): string;

  /**
   * Check if an error is retryable.
   */
  isRetryable(error: unknown): boolean;

  /**
   * Execute an operation with retry logic.
   */
  withRetry<T>(operation: () => Promise<T>, options?: Partial<RetryConfig>): Promise<T>;

  /**
   * Handle an error (log + wrap).
   */
  handleError(error: unknown, context?: Record<string, unknown>): TdaiAdapterError;

  /**
   * Get the error code from an error.
   */
  getErrorCode(error: unknown): ErrorCode | undefined;
}
