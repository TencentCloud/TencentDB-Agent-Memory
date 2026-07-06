/**
 * StableRecallContextCache — session-level freeze/dedup for the stable recall
 * system block (persona + scene navigation + memory tools guide).
 *
 * Why (issue #120): prefix-matching prompt caches (DeepSeek / MiMo
 * `openai-completions`) invalidate everything after the FIRST divergent byte.
 * The stable block sits inside the system prompt — the very first bytes of the
 * serialized request — so any mid-session drift (L2/L3 pipelines rewriting
 * persona.md / the scene index, or a recall timeout dropping the block for one
 * turn) busts the cache for the entire request, twice (drop + reappear).
 *
 * This cache freezes the first composed block per sessionKey and keeps
 * returning the SAME BYTES for the rest of the session:
 *   - drift in the candidate is detected (hash compare) but never surfaces;
 *   - `candidate === undefined` after a freeze still returns frozen content,
 *     so a recall timeout can no longer flicker the persona out;
 *   - a sliding TTL (default 60 min idle) + LRU cap bound memory and let
 *     long-idle sessions pick up fresh persona content on their next turn.
 *
 * This IS the "session-level dedup of repeated stable system prompt
 * additions" the issue asks for: within a session the block resolves to one
 * canonical byte sequence, no matter how often it is recomposed upstream.
 */

import { createHash } from "node:crypto";
import type { Logger } from "../types.js";

const TAG = "[memory-tdai] [stable-context]";

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 60 min sliding idle window
const DEFAULT_MAX_SESSIONS = 10_000;   // hard cap, same spirit as index.ts prompt caches

/** One frozen stable block, keyed by sessionKey. */
export interface StableContextEntry {
  /** Frozen block content (byte-canonical for the session). */
  content: string;
  /** hashContent(content) — used for drift detection. */
  hash: string;
  /** Epoch ms when the content was frozen. */
  frozenAt: number;
  /** Epoch ms of the last resolve/freeze (sliding TTL). */
  lastAccess: number;
  /** How many times a differing candidate was observed after the freeze. */
  driftDetected: number;
}

export interface StableContextResolveResult {
  /** The canonical content for this session (undefined only before any freeze). */
  content: string | undefined;
  /** True when the content was served from an existing freeze. */
  cacheHit: boolean;
  /** True when the candidate differed from the frozen bytes on this call. */
  drifted: boolean;
}

export interface StableRecallContextCacheOptions {
  /** Sliding idle TTL in ms (default: 60 min). */
  ttlMs?: number;
  /** Max tracked sessions before LRU eviction (default: 10 000). */
  maxSessions?: number;
  logger?: Logger;
}

/** sha256 hex digest, first 16 chars — cheap fingerprint for drift detection. */
export function hashContent(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

export class StableRecallContextCache {
  private readonly entries = new Map<string, StableContextEntry>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly logger?: Logger;

  constructor(opts?: StableRecallContextCacheOptions) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSessions = opts?.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.logger = opts?.logger;
  }

  /**
   * Resolve the canonical stable block for `sessionKey`.
   *
   * - No freeze yet (or the previous one expired): freezes `candidate`
   *   (when defined) and returns it with `cacheHit: false`.
   * - Freeze exists: returns the frozen bytes regardless of `candidate`.
   *   A defined-but-different candidate increments the drift counter;
   *   an undefined candidate (recall timeout / empty recall) still returns
   *   the frozen content so the persona never flickers out mid-session.
   */
  resolve(sessionKey: string, candidate: string | undefined, now = Date.now()): StableContextResolveResult {
    const existing = this.getLive(sessionKey, now);

    if (!existing) {
      if (candidate === undefined) {
        return { content: undefined, cacheHit: false, drifted: false };
      }
      this.freeze(sessionKey, candidate, now);
      return { content: candidate, cacheHit: false, drifted: false };
    }

    existing.lastAccess = now; // sliding TTL
    let drifted = false;
    if (candidate !== undefined && hashContent(candidate) !== existing.hash) {
      drifted = true;
      existing.driftDetected++;
      this.logger?.debug?.(
        `${TAG} drift detected for session=${sessionKey} ` +
        `(count=${existing.driftDetected}), keeping frozen bytes (policy=session-frozen)`,
      );
    }
    return { content: existing.content, cacheHit: true, drifted };
  }

  /** Explicitly (re-)freeze content for a session (used by session-stable turn-1 fold). */
  freeze(sessionKey: string, content: string, now = Date.now()): void {
    this.entries.delete(sessionKey); // re-insert at Map tail → true LRU order
    this.entries.set(sessionKey, {
      content,
      hash: hashContent(content),
      frozenAt: now,
      lastAccess: now,
      driftDetected: 0,
    });
    this.logger?.debug?.(
      `${TAG} frozen stable block for session=${sessionKey} (${content.length} chars)`,
    );
  }

  /** Whether a live (non-expired) freeze exists for the session. */
  has(sessionKey: string, now = Date.now()): boolean {
    return this.getLive(sessionKey, now) !== undefined;
  }

  /** Peek at an entry without touching lastAccess (diagnostics / tests). */
  peek(sessionKey: string): StableContextEntry | undefined {
    return this.entries.get(sessionKey);
  }

  /** TTL + LRU-cap eviction. Safe to call every turn (O(n) worst case, n bounded). */
  sweep(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.lastAccess > this.ttlMs) {
        this.entries.delete(key);
      }
    }
    if (this.entries.size > this.maxSessions) {
      const sorted = [...this.entries.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
      const toEvict = sorted.slice(0, sorted.length - this.maxSessions);
      for (const [key] of toEvict) {
        this.entries.delete(key);
      }
      this.logger?.debug?.(`${TAG} LRU-evicted ${toEvict.length} session(s) (cap=${this.maxSessions})`);
    }
  }

  /** Drop everything (destroy() / tests). */
  clear(): void {
    this.entries.clear();
  }

  /** Number of tracked sessions (tests / diagnostics). */
  get size(): number {
    return this.entries.size;
  }

  private getLive(sessionKey: string, now: number): StableContextEntry | undefined {
    const entry = this.entries.get(sessionKey);
    if (!entry) return undefined;
    if (now - entry.lastAccess > this.ttlMs) {
      this.entries.delete(sessionKey);
      return undefined;
    }
    return entry;
  }
}
