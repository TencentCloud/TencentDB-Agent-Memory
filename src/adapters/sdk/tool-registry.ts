/**
 * ToolRegistry — Manages tool registration and execution for TDAI memory tools.
 *
 * Features:
 * - Tool registration with metadata
 * - Tool execution with interceptors
 * - Version management
 * - Execution metrics
 */

import type { Logger } from "../../core/types.js";

// ============================
// Types
// ============================

export interface ToolDefinition {
  /** Unique tool name */
  name: string;
  /** Human-readable label */
  label: string;
  /** Tool description for LLM */
  description: string;
  /** JSON Schema for parameters */
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Tool version */
  version?: string;
  /** Whether the tool is enabled */
  enabled?: boolean;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

export interface ToolCallContext {
  /** Tool call ID */
  callId: string;
  /** Tool name */
  toolName: string;
  /** Parameters passed to the tool */
  params: Record<string, unknown>;
  /** Timestamp of the call */
  timestamp: number;
  /** Execution duration in ms */
  durationMs?: number;
  /** Whether the call succeeded */
  success?: boolean;
  /** Error message if failed */
  error?: string;
}

export interface ToolInterceptor {
  /** Called before tool execution */
  beforeExecute?: (context: ToolCallContext) => void | Promise<void>;
  /** Called after tool execution */
  afterExecute?: (context: ToolCallContext, result: unknown) => void | Promise<void>;
  /** Called on tool error */
  onError?: (context: ToolCallContext, error: Error) => void | Promise<void>;
}

export interface ToolRegistryOptions {
  /** Platform identifier for logging */
  platformId?: string;
  /** Logger instance */
  logger?: Logger;
  /** Maximum tool call history size */
  maxHistorySize?: number;
}

// ============================
// DefaultToolRegistry
// ============================

export class DefaultToolRegistry implements ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private executors = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  private interceptors: ToolInterceptor[] = [];
  private history: ToolCallContext[] = [];
  private platformId: string;
  private logger?: Logger;
  private maxHistorySize: number;
  private toolCallCounter = 0;

  constructor(opts: ToolRegistryOptions = {}) {
    this.platformId = opts.platformId ?? "unknown";
    this.logger = opts.logger;
    this.maxHistorySize = opts.maxHistorySize ?? 1000;
  }

  /** @implements ToolRegistry */
  register(name: string, definition: ToolDefinition): void {
    if (this.tools.has(name)) {
      this.logger?.warn?.(`Tool ${name} already registered, overwriting`);
    }

    this.tools.set(name, {
      version: "1.0.0",
      enabled: true,
      ...definition,
    });

    this.logger?.debug?.(`Tool registered: ${name}`);
  }

  /** @implements ToolRegistry */
  registerExecutor(name: string, executor: (params: Record<string, unknown>) => Promise<unknown>): void {
    if (!this.tools.has(name)) {
      this.logger?.warn?.(`Executor registered for unregistered tool: ${name}`);
    }

    this.executors.set(name, executor);
  }

  /** @implements ToolRegistry */
  unregister(name: string): boolean {
    const existed = this.tools.delete(name);
    this.executors.delete(name);

    if (existed) {
      this.logger?.debug?.(`Tool unregistered: ${name}`);
    }

    return existed;
  }

  /** @implements ToolRegistry */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** @implements ToolRegistry */
  getAll(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** @implements ToolRegistry */
  getEnabled(): ToolDefinition[] {
    return this.getAll().filter(t => t.enabled !== false);
  }

  /** @implements ToolRegistry */
  isRegistered(name: string): boolean {
    return this.tools.has(name);
  }

  /** @implements ToolRegistry */
  isEnabled(name: string): boolean {
    const tool = this.tools.get(name);
    return tool?.enabled ?? false;
  }

  /** @implements ToolRegistry */
  enable(name: string): void {
    const tool = this.tools.get(name);
    if (tool) {
      tool.enabled = true;
      this.logger?.debug?.(`Tool enabled: ${name}`);
    }
  }

  /** @implements ToolRegistry */
  disable(name: string): void {
    const tool = this.tools.get(name);
    if (tool) {
      tool.enabled = false;
      this.logger?.debug?.(`Tool disabled: ${name}`);
    }
  }

  /** @implements ToolRegistry */
  async execute(callId: string, name: string, params: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    if (tool.enabled === false) {
      throw new Error(`Tool disabled: ${name}`);
    }

    const executor = this.executors.get(name);
    if (!executor) {
      throw new Error(`No executor registered for tool: ${name}`);
    }

    const context: ToolCallContext = {
      callId,
      toolName: name,
      params,
      timestamp: Date.now(),
    };

    // Before interceptors
    for (const interceptor of this.interceptors) {
      await interceptor.beforeExecute?.(context);
    }

    // Execute
    let result: unknown;
    try {
      result = await executor(params);

      context.success = true;
      context.durationMs = Date.now() - context.timestamp;

      // After interceptors
      for (const interceptor of this.interceptors) {
        await interceptor.afterExecute?.(context, result);
      }

      return result;
    } catch (error) {
      context.success = false;
      context.error = error instanceof Error ? error.message : String(error);
      context.durationMs = Date.now() - context.timestamp;

      // Error interceptors
      for (const interceptor of this.interceptors) {
        await interceptor.onError?.(context, error instanceof Error ? error : new Error(String(error)));
      }

      throw error;
    } finally {
      this.addToHistory(context);
    }
  }

  /** @implements ToolRegistry */
  addInterceptor(interceptor: ToolInterceptor): () => void {
    this.interceptors.push(interceptor);
    return () => {
      const index = this.interceptors.indexOf(interceptor);
      if (index !== -1) {
        this.interceptors.splice(index, 1);
      }
    };
  }

  /** @implements ToolRegistry */
  getHistory(): ToolCallContext[] {
    return [...this.history];
  }

  /** @implements ToolRegistry */
  getMetrics(): {
    totalCalls: number;
    successCount: number;
    errorCount: number;
    averageDurationMs: number;
    toolCallCounts: Record<string, number>;
  } {
    const calls = this.history;
    const successCount = calls.filter(c => c.success).length;
    const errorCount = calls.filter(c => !c.success).length;
    const totalDuration = calls.reduce((sum, c) => sum + (c.durationMs ?? 0), 0);
    const toolCallCounts: Record<string, number> = {};

    for (const call of calls) {
      toolCallCounts[call.toolName] = (toolCallCounts[call.toolName] ?? 0) + 1;
    }

    return {
      totalCalls: calls.length,
      successCount,
      errorCount,
      averageDurationMs: calls.length > 0 ? totalDuration / calls.length : 0,
      toolCallCounts,
    };
  }

  /** @implements ToolRegistry */
  clearHistory(): void {
    this.history = [];
    this.logger?.debug?.("Tool call history cleared");
  }

  /** @implements ToolRegistry */
  generateCallId(): string {
    return `${this.platformId}-${Date.now()}-${++this.toolCallCounter}`;
  }

  // ============================
  // Private helpers
  // ============================

  private addToHistory(context: ToolCallContext): void {
    this.history.push(context);
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }
  }
}

// ============================
// ToolRegistry interface
// ============================

export interface ToolRegistry {
  /**
   * Register a tool with its definition.
   */
  register(name: string, definition: ToolDefinition): void;

  /**
   * Register an executor function for a tool.
   */
  registerExecutor(name: string, executor: (params: Record<string, unknown>) => Promise<unknown>): void;

  /**
   * Unregister a tool.
   */
  unregister(name: string): boolean;

  /**
   * Get a tool's definition.
   */
  get(name: string): ToolDefinition | undefined;

  /**
   * Get all registered tools.
   */
  getAll(): ToolDefinition[];

  /**
   * Get all enabled tools.
   */
  getEnabled(): ToolDefinition[];

  /**
   * Check if a tool is registered.
   */
  isRegistered(name: string): boolean;

  /**
   * Check if a tool is enabled.
   */
  isEnabled(name: string): boolean;

  /**
   * Enable a tool.
   */
  enable(name: string): void;

  /**
   * Disable a tool.
   */
  disable(name: string): void;

  /**
   * Execute a tool.
   */
  execute(callId: string, name: string, params: Record<string, unknown>): Promise<unknown>;

  /**
   * Add an interceptor for tool execution.
   */
  addInterceptor(interceptor: ToolInterceptor): () => void;

  /**
   * Get tool call history.
   */
  getHistory(): ToolCallContext[];

  /**
   * Get execution metrics.
   */
  getMetrics(): {
    totalCalls: number;
    successCount: number;
    errorCount: number;
    averageDurationMs: number;
    toolCallCounts: Record<string, number>;
  };

  /**
   * Clear tool call history.
   */
  clearHistory(): void;

  /**
   * Generate a unique call ID.
   */
  generateCallId(): string;
}
