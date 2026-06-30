/**
 * EventEmitter — Simple event system for adapter lifecycle and memory events.
 *
 * Features:
 * - Typed event names
 * - Handler removal via returned unsubscribe function
 * - Error handling in handlers
 * - Event history (optional)
 */

import type { Logger } from "../../core/types.js";

// ============================
// Types
// ============================

export interface EventHandler<T = Record<string, unknown>> {
  (data: T): void | Promise<void>;
}

export interface EventEmitterOptions {
  /** Maximum event history size (0 = disabled) */
  maxHistorySize?: number;
  /** Logger for error reporting */
  logger?: Logger;
}

// ============================
// DefaultEventEmitter
// ============================

export class DefaultEventEmitter {
  private handlers = new Map<string, Set<EventHandler>>();
  private history: Array<{ event: string; data: Record<string, unknown>; timestamp: number }> = [];
  private maxHistorySize: number;
  private logger?: Logger;

  constructor(opts: EventEmitterOptions = {}) {
    this.maxHistorySize = opts.maxHistorySize ?? 100;
    this.logger = opts.logger;
  }

  /**
   * Subscribe to an event.
   * @returns Unsubscribe function
   */
  on<T = Record<string, unknown>>(event: string, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler);

    // Return unsubscribe function
    return () => this.off(event, handler);
  }

  /**
   * Subscribe to an event once (auto-unsubscribe after first emit).
   */
  once<T = Record<string, unknown>>(event: string, handler: EventHandler<T>): () => void {
    const wrapper: EventHandler<T> = (data) => {
      this.off(event, wrapper);
      return handler(data);
    };
    return this.on(event, wrapper);
  }

  /**
   * Unsubscribe from an event.
   */
  off<T = Record<string, unknown>>(event: string, handler: EventHandler<T>): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      handlers.delete(handler as EventHandler);
      if (handlers.size === 0) {
        this.handlers.delete(event);
      }
    }
  }

  /**
   * Emit an event to all subscribers.
   */
  emit(event: string, data: Record<string, unknown> = {}): void {
    // Record in history
    if (this.maxHistorySize > 0) {
      this.history.push({ event, data, timestamp: Date.now() });
      if (this.history.length > this.maxHistorySize) {
        this.history.shift();
      }
    }

    // Notify handlers
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          const result = handler(data);
          // Handle async handlers
          if (result instanceof Promise) {
            result.catch((err) => {
              this.logger?.error?.(`Event handler error in ${event}: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
        } catch (err) {
          this.logger?.error?.(`Event handler error in ${event}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  /**
   * Remove all handlers for an event.
   */
  removeAllListeners(event?: string): void {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
  }

  /**
   * Get event history.
   */
  getHistory(): ReadonlyArray<{ event: string; data: Record<string, unknown>; timestamp: number }> {
    return this.history;
  }

  /**
   * Get the number of handlers for an event.
   */
  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  /**
   * Check if an event has handlers.
   */
  hasListeners(event: string): boolean {
    return this.listenerCount(event) > 0;
  }
}

// ============================
// Standard event types
// ============================

export const ADAPTER_EVENTS = {
  // Lifecycle events
  LIFECYCLE_INIT: "lifecycle:init",
  LIFECYCLE_DISPOSE: "lifecycle:dispose",
  LIFECYCLE_STATE_CHANGE: "lifecycle:stateChange",

  // Tool events
  TOOL_REGISTERED: "tool:registered",
  TOOL_UNREGISTERED: "tool:unregistered",
  TOOL_CALLED: "tool:called",
  TOOL_ERROR: "tool:error",

  // Memory events
  RECALL_START: "recall:start",
  RECALL_COMPLETE: "recall:complete",
  RECALL_ERROR: "recall:error",
  CAPTURE_START: "capture:start",
  CAPTURE_COMPLETE: "capture:complete",
  CAPTURE_ERROR: "capture:error",

  // Config events
  CONFIG_CHANGED: "config:changed",
  CONFIG_ERROR: "config:error",

  // Error events
  ERROR_UNHANDLED: "error:unhandled",
} as const;

export type AdapterEventType = typeof ADAPTER_EVENTS[keyof typeof ADAPTER_EVENTS];
