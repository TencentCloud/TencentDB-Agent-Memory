/**
 * Session-level recall deduplication for the Gateway `/recall` endpoint.
 *
 * Problem (see issue #120 / #523): Hermes calls `POST /recall` before every
 * turn (prefetch). Within the same session and topic, the returned
 * `appendSystemContext` (stable persona / scene / tools blocks) is byte-for-byte
 * identical turn after turn, so the identical context text gets re-sent to the
 * LLM every turn — redundant tokens, and (for providers with prefix-matching
 * prompt caches) a prompt that drifts apart from the cached prefix as dynamic
 * parts change around it.
 *
 * This component applies **change detection**, not "seen-before, never again":
 * a session's context is skipped only when it is identical to the *most recent*
 * /recall response for that session. If the context ever changes (e.g. the
 * scene navigation block switches), the new context is served again and becomes
 * the new baseline. This keeps the dedup safe even when the consumer (Hermes)
 * rebuilds its prompt from scratch every turn: the LLM only ever misses a block
 * it has just seen unchanged.
 *
 * Semantics:
 * - Dedup is keyed by `session_key` only (different sessions never interfere).
 * - Empty contexts are never cached and never deduplicated.
 * - Entries expire after `ttlMs` without access (lazy, on next evaluate).
 * - The map is bounded by `maxEntries` (oldest entry evicted on overflow).
 * - `/session/end` clears the session entry so a new session starts fresh.
 */

import { createHash } from "node:crypto";

export interface RecallDedupOptions {
  /** Master switch. When false (default), every call is served in full. */
  enabled: boolean;
  /** Entry lifetime without access, in ms. Default 60 minutes. */
  ttlMs: number;
  /** Max tracked sessions. Oldest entry is evicted when the map overflows. */
  maxEntries: number;
}

export interface RecallDedupDecision {
  /** True when the context was identical to the session's previous response. */
  deduplicated: boolean;
  /** The context to serve. Empty string when `deduplicated` is true. */
  context: string;
}

export const RECALL_DEDUP_DEFAULTS: RecallDedupOptions = {
  enabled: false,
  ttlMs: 60 * 60 * 1000, // 1 hour
  maxEntries: 1000,
};

interface DedupEntry {
  fingerprint: string;
  lastAccess: number;
}

export class SessionRecallDedup {
  private readonly entries = new Map<string, DedupEntry>();
  private readonly options: RecallDedupOptions;
  private hitCount = 0;
  private missCount = 0;

  constructor(options?: Partial<RecallDedupOptions>) {
    this.options = { ...RECALL_DEDUP_DEFAULTS, ...options };
  }

  /**
   * Decide whether `context` for `sessionKey` should be served or skipped.
   *
   * When dedup is disabled, or the context is empty, this is a plain passthrough
   * (never deduplicated, never cached). Otherwise the context is fingerprinted
   * and compared against the session's most recent response.
   */
  evaluate(sessionKey: string, context: string): RecallDedupDecision {
    if (!this.options.enabled || !context) {
      return { deduplicated: false, context };
    }

    this.evictExpired();

    const fingerprint = fingerprintOf(context);
    const entry = this.entries.get(sessionKey);

    if (entry && entry.fingerprint === fingerprint) {
      // Touch — move to the tail so it becomes the most-recently-used entry;
      // an active session must never be evicted just because it was inserted
      // early (FIFO would defeat the purpose of the dedup).
      this.entries.delete(sessionKey);
      this.entries.set(sessionKey, entry);
      entry.lastAccess = Date.now();
      this.hitCount++;
      return { deduplicated: true, context: "" };
    }

    // Miss — a new (or changed) baseline is about to be stored. Bound the map
    // here, only when inserting, so a hit never evicts another session.
    this.evictOverflow();
    this.entries.set(sessionKey, { fingerprint, lastAccess: Date.now() });
    this.missCount++;
    return { deduplicated: false, context };
  }

  /** Forget a session (called on `/session/end`). */
  clearSession(sessionKey: string): void {
    this.entries.delete(sessionKey);
  }

  /** Remove expired entries; returns how many were removed. */
  evictExpired(now: number = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (now - entry.lastAccess > this.options.ttlMs) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Number of dedup hits (identical repeats served as empty). */
  get hits(): number {
    return this.hitCount;
  }

  /** Number of non-dedup evaluations (full contexts served). */
  get misses(): number {
    return this.missCount;
  }

  /** Total tracked sessions. */
  get size(): number {
    return this.entries.size;
  }

  private evictOverflow(): void {
    while (this.entries.size >= this.options.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/**
 * Content fingerprint (SHA-256 hex) used for byte-exact change detection.
 * Collisions are negligible for this use case; SHA-256 is Node built-in.
 */
export function fingerprintOf(context: string): string {
  return createHash("sha256").update(context, "utf-8").digest("hex");
}
