/**
 * Gate types — shared interfaces for G1/G2/G3 middleware gates.
 */
export interface RateLimitOptions {
  windowMs: number;
  maxCalls: number;
  selfFallbackThreshold: number;
  selfFallbackDurationMs: number;
}
export const DEFAULT_RATE_LIMIT_OPTIONS: RateLimitOptions = {
  windowMs: 60_000, maxCalls: 10,
  selfFallbackThreshold: 3, selfFallbackDurationMs: 30_000,
};
export interface CircuitBreakerOptions {
  threshold: number; cooldownMs: number; maxCooldownMs: number;
}
export const DEFAULT_CIRCUIT_BREAKER_OPTIONS: CircuitBreakerOptions = {
  threshold: 5, cooldownMs: 60_000, maxCooldownMs: 300_000,
};
export interface AuditEntry {
  method: string; args: unknown[]; result: unknown;
  durationMs: number; timestamp: number; error?: string;
}
export interface AuditExporter {
  export(entries: AuditEntry[]): Promise<void>;
}
export interface AuditGateOptions {
  maxBufferSize: number; intervalMs: number;
  exporters?: AuditExporter[]; sampleRate: number;
  onDrop?: (entry: AuditEntry) => void;
}
export const DEFAULT_AUDIT_OPTIONS: AuditGateOptions = {
  maxBufferSize: 1024, intervalMs: 5000, sampleRate: 0.1,
};
export class CircuitOpenError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Circuit breaker open; retry after ${retryAfterMs}ms`);
    this.name = "CircuitOpenError";
  }
}
