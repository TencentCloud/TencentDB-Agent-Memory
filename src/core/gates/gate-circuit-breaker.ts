import type { Middleware } from "../base-memory-adapter.js";
import { CircuitOpenError } from "./types.js";
import type { CircuitBreakerOptions } from "./types.js";
import { DEFAULT_CIRCUIT_BREAKER_OPTIONS } from "./types.js";

export class CircuitBreakerGate implements Middleware {
  private _opts: CircuitBreakerOptions;
  private _consecutiveFailures = 0;
  private _openUntil = 0;
  private _currentCooldownMs: number;

  constructor(opts?: Partial<CircuitBreakerOptions>) {
    this._opts = { ...DEFAULT_CIRCUIT_BREAKER_OPTIONS, ...opts };
    this._currentCooldownMs = this._opts.cooldownMs;
  }

  beforeCall(_method: string, ..._args: unknown[]): void {
    if (Date.now() < this._openUntil) throw new CircuitOpenError(this._openUntil - Date.now());
    if (this._currentCooldownMs > this._opts.cooldownMs) this._currentCooldownMs = this._opts.cooldownMs;
  }

  afterCall(_method: string, _result: unknown, _durationMs: number): void {
    this._consecutiveFailures = 0;
  }

  onError(_method: string, _error: Error): void {
    this._consecutiveFailures++;
    if (this._consecutiveFailures >= this._opts.threshold) {
      this._openUntil = Date.now() + this._currentCooldownMs;
      this._currentCooldownMs = Math.min(this._currentCooldownMs * 2, this._opts.maxCooldownMs);
      this._consecutiveFailures = 0;
    }
  }

  _reset(): void { this._consecutiveFailures = 0; this._openUntil = 0; this._currentCooldownMs = this._opts.cooldownMs; }
  _isOpen(): boolean { return Date.now() < this._openUntil; }
}
