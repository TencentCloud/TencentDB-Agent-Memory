import type { Middleware } from "../base-memory-adapter.js";
import { TdaiRateLimitError } from "../tdai-http-client.js";
import type { RateLimitOptions } from "./types.js";
import { DEFAULT_RATE_LIMIT_OPTIONS } from "./types.js";

export class RateLimitGate implements Middleware {
  private _opts: RateLimitOptions;
  private _bucket: number[] = [];
  private _selfFailures = 0;
  private _selfOpenUntil = 0;

  constructor(opts?: Partial<RateLimitOptions>) {
    this._opts = { ...DEFAULT_RATE_LIMIT_OPTIONS, ...opts };
  }

  beforeCall(_method: string, ..._args: unknown[]): void {
    if (this._selfOpenUntil > Date.now()) return;
    const now = Date.now();
    const windowStart = now - this._opts.windowMs;
    this._bucket = this._bucket.filter((t) => t > windowStart);
    if (this._bucket.length >= this._opts.maxCalls) {
      throw new TdaiRateLimitError(`Rate limit exceeded: ${this._opts.maxCalls} calls per ${this._opts.windowMs}ms`);
    }
    this._bucket.push(now);
  }

  onError(_method: string, _error: Error): void {
    if (this._opts.selfFallbackThreshold === 0) return;
    this._selfFailures++;
    if (this._selfFailures >= this._opts.selfFallbackThreshold) {
      this._selfOpenUntil = Date.now() + this._opts.selfFallbackDurationMs;
    }
  }

  _reset(): void { this._bucket = []; this._selfFailures = 0; this._selfOpenUntil = 0; }
}
