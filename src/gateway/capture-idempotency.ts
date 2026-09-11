import { createHash } from "node:crypto";
import type { CaptureRequest } from "./types.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1_024;

interface CaptureIdempotencyEntry<T> {
  fingerprint: string;
  promise: Promise<T>;
  settled: boolean;
  expiresAt: number;
}

export class CaptureIdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key was already used with a different capture payload");
    this.name = "CaptureIdempotencyConflictError";
  }
}

export class CaptureIdempotencyCapacityError extends Error {
  constructor() {
    super("Capture idempotency capacity is temporarily exhausted");
    this.name = "CaptureIdempotencyCapacityError";
  }
}

/**
 * Coalesces retried capture requests without retaining an unbounded request log.
 * Failed operations are removed immediately so the same key can be retried.
 */
export class CaptureIdempotencyStore<T> {
  private readonly entries = new Map<string, CaptureIdempotencyEntry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.ttlMs = normalizePositiveInteger(opts.ttlMs, DEFAULT_TTL_MS);
    this.maxEntries = normalizePositiveInteger(opts.maxEntries, DEFAULT_MAX_ENTRIES);
    this.now = opts.now ?? Date.now;
  }

  async run(opts: {
    sessionKey: string;
    idempotencyKey: string;
    fingerprint: string;
    execute: () => Promise<T>;
  }): Promise<{ value: T; replayed: boolean }> {
    const cacheKey = buildCacheKey(opts.sessionKey, opts.idempotencyKey);
    this.pruneExpired();

    const existing = this.entries.get(cacheKey);
    if (existing) {
      if (existing.fingerprint !== opts.fingerprint) {
        throw new CaptureIdempotencyConflictError();
      }
      return { value: await existing.promise, replayed: true };
    }

    this.makeRoom();

    const entry: CaptureIdempotencyEntry<T> = {
      fingerprint: opts.fingerprint,
      promise: Promise.resolve().then(opts.execute),
      settled: false,
      expiresAt: Number.POSITIVE_INFINITY,
    };
    this.entries.set(cacheKey, entry);

    void entry.promise.then(
      () => {
        if (this.entries.get(cacheKey) === entry) {
          entry.settled = true;
          entry.expiresAt = this.now() + this.ttlMs;
        }
      },
      () => {
        if (this.entries.get(cacheKey) === entry) {
          this.entries.delete(cacheKey);
        }
      },
    );

    return { value: await entry.promise, replayed: false };
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.settled && entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  private makeRoom(): void {
    while (this.entries.size >= this.maxEntries) {
      const settled = [...this.entries].find(([, entry]) => entry.settled);
      if (!settled) {
        throw new CaptureIdempotencyCapacityError();
      }
      this.entries.delete(settled[0]);
    }
  }
}

export function fingerprintCaptureRequest(request: CaptureRequest): string {
  const { idempotency_key: _idempotencyKey, ...payload } = request;
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function isValidCaptureIdempotencyKey(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && Buffer.byteLength(value, "utf-8") <= 128
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function buildCacheKey(sessionKey: string, idempotencyKey: string): string {
  return `${sessionKey.length}:${sessionKey}${idempotencyKey}`;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => item === undefined ? "null" : canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`Unsupported capture payload value: ${typeof value}`);
}
