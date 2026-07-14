/**
 * BaseMemoryAdapter — abstract base class for MemoryAdapter implementations.
 *
 * TypeScript equivalent of bridge_adapter/base.py (TdaiAdapter ABC).
 * Provides:
 *   - Exponential backoff retry (3 attempts, 0.5s base + jitter)
 *   - Parameter sanitization (query length, limit clamping)
 *   - Graceful degradation (exceptions → safe defaults)
 *   - Session-level recall cache (SHA256 keyed, prevents prefix cache degradation)
 *   - Middleware hooks (before/after/onError)
 *   - Built-in metrics middleware
 *
 * Subclasses override the 4 `_impl` methods:
 *   _recallImpl, _captureImpl, _searchMemoryImpl, _searchConversationImpl
 */

import { createHash } from "node:crypto";
import type { MemoryAdapter } from "./types.js";
import { RateLimitGate } from "./gates/gate-rate-limit.js";
import { CircuitBreakerGate } from "./gates/gate-circuit-breaker.js";
import { AuditGate } from "./gates/gate-audit.js";

// ── Constants ──

const MAX_QUERY_LENGTH = 100_000;
const MAX_CONTENT_LENGTH = 1_000_000;
const MAX_LIMIT = 1000;
const MIN_LIMIT = 1;
const DEFAULT_LIMIT = 5;

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 10_000;

// ── Middleware ──

export interface Middleware {
  beforeCall?(method: string, ...args: unknown[]): void;
  afterCall?(method: string, result: unknown, durationMs: number): void;
  onError?(method: string, error: Error): void;
}

export class MetricsMiddleware implements Middleware {
  private _counts: Record<string, number> = {};
  private _latencies: Record<string, number[]> = {};
  private _startTime = 0;

  beforeCall(method: string): void {
    this._startTime = Date.now();
  }

  afterCall(method: string, _result: unknown, durationMs: number): void {
    this._counts[method] = (this._counts[method] ?? 0) + 1;
    (this._latencies[method] ??= []).push(durationMs);
  }

  get metrics(): Record<string, unknown> {
    return {
      calls: { ...this._counts },
      avgLatencyMs: Object.fromEntries(
        Object.entries(this._latencies).map(([k, v]) => [k, v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : 0]),
      ),
    };
  }
}

// ── Sanitization ──

function sanitizeQuery(query: string): string {
  if (typeof query !== "string") throw new TypeError(`query must be string, got ${typeof query}`);
  return query.slice(0, MAX_QUERY_LENGTH);
}

function sanitizeLimit(limit: number): number {
  if (!Number.isInteger(limit)) throw new TypeError(`limit must be integer, got ${typeof limit}`);
  return Math.max(MIN_LIMIT, Math.min(limit, MAX_LIMIT));
}

function sanitizeContent(content: string, label = "content"): string {
  if (typeof content !== "string") throw new TypeError(`${label} must be string, got ${typeof content}`);
  return content.slice(0, MAX_CONTENT_LENGTH);
}

// ── Retry ──

function exponentialBackoff(attempt: number, baseMs: number, maxMs: number): number {
  const delay = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  const jitter = Math.random() * delay * 0.1;
  return delay + jitter;
}

function isRetryable(err: Error): boolean {
  const name = err.name;
  return (
    name === "TdaiConnectionError" ||
    name === "TdaiTimeoutError" ||
    name === "TdaiRateLimitError" ||
    name === "TdaiServerError" ||
    name === "AbortError" ||
    name === "TypeError" // fetch network errors
  );
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (!isRetryable(lastError) || attempt === RETRY_MAX_ATTEMPTS - 1) throw lastError;
      const delay = exponentialBackoff(attempt, RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS);
      console.warn(`[${label}] attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS} failed, retrying in ${(delay / 1000).toFixed(1)}s: ${lastError.message}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError!;
}

// ── Base class ──

export abstract class BaseMemoryAdapter implements MemoryAdapter {
  abstract readonly name: string;

  protected _middleware: Middleware[] = [];
  protected _metrics = new MetricsMiddleware();
  /** Session-level recall cache: SHA256(query) → cached result. Prevents prefix cache degradation (#120). */
  private _recallCache = new Map<string, { prependContext: string; appendSystemContext: string }>();

  constructor(enableDefaultGates = false) {
    this._middleware.push(this._metrics);
    if (enableDefaultGates) {
      this._middleware.push(new RateLimitGate());
      this._middleware.push(new CircuitBreakerGate());
      this._middleware.push(new AuditGate());
    }
  }

  addMiddleware(mw: Middleware): void {
    this._middleware.push(mw);
  }

  get metrics(): Record<string, unknown> {
    return this._metrics.metrics;
  }

  // ── Lifecycle ──

  abstract initialize(config?: Record<string, unknown>): boolean;
  abstract isAvailable(): boolean;
  abstract shutdown(): void;

  // ── Internal implementations (subclasses override) ──

  protected abstract _recallImpl(query: string, limit: number): Promise<{ prependContext: string; appendSystemContext: string }>;
  protected abstract _captureImpl(userContent: string, assistantContent: string, sessionId: string): Promise<boolean>;
  protected abstract _searchMemoryImpl(query: string, limit: number): Promise<Array<Record<string, unknown>>>;
  protected abstract _searchConversationImpl(query: string, limit: number): Promise<Array<Record<string, unknown>>>;

  // Optional overrides
  async mcpHealth(): Promise<Record<string, unknown>> {
    return { available: this.isAvailable() };
  }

  async syncProfile(_profileData: Record<string, unknown>): Promise<boolean> {
    return false;
  }

  // ── Guard dispatcher ──

  private async _callWithGuards<T>(method: string, fn: () => Promise<T>): Promise<T> {
    for (const mw of this._middleware) mw.beforeCall?.(method);
    const start = Date.now();
    try {
      const result = await withRetry(fn, method);
      const duration = Date.now() - start;
      for (const mw of this._middleware) mw.afterCall?.(method, result, duration);
      return result;
    } catch (err) {
      const duration = Date.now() - start;
      for (const mw of this._middleware) mw.onError?.(method, err as Error);
      throw err;
    }
  }

  // ── Public API ──

  async recall(query: string, limit = DEFAULT_LIMIT): Promise<{ prependContext: string; appendSystemContext: string }> {
    const q = sanitizeQuery(query);
    const l = sanitizeLimit(limit);
    const cacheKey = createHash("sha256").update(q).digest("hex");
    const cached = this._recallCache.get(cacheKey);
    if (cached) {
      console.debug(`recall cache hit for query=${q.slice(0, 50)}...`);
      return { ...cached };
    }
    try {
      const result = await this._callWithGuards("recall", () => this._recallImpl(q, l));
      this._recallCache.set(cacheKey, {
        prependContext: result.prependContext ?? "",
        appendSystemContext: result.appendSystemContext ?? "",
      });
      return result;
    } catch {
      console.warn("recall failed, returning safe defaults");
      return { prependContext: "", appendSystemContext: "" };
    }
  }

  async capture(userContent: string, assistantContent: string, sessionId = ""): Promise<boolean> {
    const u = sanitizeContent(userContent, "userContent");
    const a = sanitizeContent(assistantContent, "assistantContent");
    try {
      return await this._callWithGuards("capture", () => this._captureImpl(u, a, sessionId));
    } catch {
      console.warn("capture failed, returning false");
      return false;
    }
  }

  async searchMemory(query: string, limit = DEFAULT_LIMIT): Promise<Array<Record<string, unknown>>> {
    const q = sanitizeQuery(query);
    const l = sanitizeLimit(limit);
    try {
      return await this._callWithGuards("searchMemory", () => this._searchMemoryImpl(q, l));
    } catch {
      console.warn("searchMemory failed, returning []");
      return [];
    }
  }

  async searchConversation(query: string, limit = DEFAULT_LIMIT): Promise<Array<Record<string, unknown>>> {
    const q = sanitizeQuery(query);
    const l = sanitizeLimit(limit);
    try {
      return await this._callWithGuards("searchConversation", () => this._searchConversationImpl(q, l));
    } catch {
      console.warn("searchConversation failed, returning []");
      return [];
    }
  }
}
