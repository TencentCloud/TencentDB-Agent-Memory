/**
 * cache-diagnostics.ts
 *
 * Deterministic diagnostic utilities for analyzing prompt-cache friendliness
 * across conversation turns.
 *
 * These are pure functions that compute prefix "shapes" (hashes of structural
 * elements that determine cache boundaries). They help operators verify whether
 * their configuration (injectionMode, showInjected) produces cache-friendly
 * prefixes.
 *
 * When cfg.recall.cacheDiagnostics is enabled, the plugin logs prefix-stability
 * diagnostics on every before_prompt_build turn.
 *
 * Inspired by OpenAI-compatible prefix-matching cache semantics:
 * - The cache key is derived from the prompt prefix up to the first varying token
 * - Stable system prompts + tool definitions → high cache hit rate
 * - Variable user message prefixes → cache miss every turn
 */

import type { Logger } from "../core/types.js";

const TAG = "[memory-tdai] [cache-diag]";

// ============================
// PrefixShape
// ============================

/** Structural snapshot of a prompt prefix for cache-stability comparison. */
export interface PrefixShape {
  /** Hash of the system prompt portion (including stable injected content). */
  systemHash: string;
  /** Hash of tool definitions (stable across turns in the same session). */
  toolHash: string;
  /** Hash of the user-message prefix (affected by prependContext injection). */
  userPrefixHash: string;
  /** Epoch ms when this shape was captured. */
  capturedAt: number;
}

export interface CacheDiagnosis {
  /** Whether the prefix is stable (identical to previous turn). */
  prefixStable: boolean;
  /** List of which sections changed since the last capture. */
  changedSections: string[];
  /** Human-readable diagnostic message. */
  message: string;
  /** Estimated cacheable tokens if prefix is stable. */
  estimatedCacheableTokens: number;
}

/**
 * Simple deterministic hash (FNV-1a-inspired, 32-bit) for structural comparison.
 * Not cryptographically secure — designed for fast, deterministic prefix matching.
 */
export function structuralHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash = hash >>> 0; // force unsigned 32-bit
  }
  return hash.toString(36);
}

/**
 * Capture a structural snapshot of the current prompt prefix.
 *
 * This is intended to be called in before_prompt_build, comparing the current
 * shape against the previous turn's shape to detect cache-unfriendly changes.
 */
export function capturePrefixShape(params: {
  systemPrompt: string;
  toolSchemas?: unknown;
  userPrefix: string;
}): PrefixShape {
  return {
    systemHash: structuralHash(params.systemPrompt),
    toolHash: structuralHash(JSON.stringify(params.toolSchemas ?? {})),
    userPrefixHash: structuralHash(params.userPrefix),
    capturedAt: Date.now(),
  };
}

/**
 * Compare two prefix shapes and diagnose cache stability.
 */
export function comparePrefixShape(
  prev: PrefixShape,
  curr: PrefixShape,
): CacheDiagnosis {
  const changed: string[] = [];
  if (prev.systemHash !== curr.systemHash) changed.push("systemPrompt");
  if (prev.toolHash !== curr.toolHash) changed.push("toolSchemas");
  if (prev.userPrefixHash !== curr.userPrefixHash) changed.push("userPrefix");

  const prefixStable = changed.length === 0;
  const elapsedMs = curr.capturedAt - prev.capturedAt;

  // Rough token estimation: CJK ~1 char/token, Latin ~4 chars/token
  const estimateTokens = (text: string): number => {
    let cjk = 0;
    let other = 0;
    for (const ch of text) {
      if (/[一-鿿㐀-䶿豈-﫿]/.test(ch)) {
        cjk++;
      } else {
        other++;
      }
    }
    return Math.ceil(cjk / 1.5 + other / 4);
  };

  return {
    prefixStable,
    changedSections: changed,
    message: prefixStable
      ? `Prefix stable (${elapsedMs}ms since last capture) — cache HIT expected`
      : `Prefix changed in: ${changed.join(", ")} (${elapsedMs}ms since last capture) — cache MISS expected`,
    estimatedCacheableTokens: 0, // populated by caller with actual system prompt length
  };
}

// ============================
// Session-state tracker
// ============================

/**
 * Per-session prefix-shape history for cache-diagnostic logging.
 *
 * Callers create one instance per session and call {@link recordTurn} on each
 * before_prompt_build invocation.
 */
export class CacheDiagnosticsTracker {
  private prevShape: PrefixShape | undefined;
  private turnCount = 0;
  private hitCount = 0;

  constructor(private logger?: Logger) {}

  /**
   * Record a new prompt-build turn.
   *
   * On the first turn, only captures the shape (no comparison).
   * On subsequent turns, compares against the previous shape and logs the diagnosis.
   */
  recordTurn(params: {
    systemPrompt: string;
    toolSchemas?: unknown;
    userPrefix: string;
  }): CacheDiagnosis | undefined {
    this.turnCount++;
    const curr = capturePrefixShape(params);

    if (!this.prevShape) {
      this.prevShape = curr;
      this.logger?.debug?.(
        `${TAG} Turn ${this.turnCount}: initial prefix shape captured ` +
        `(system=${curr.systemHash}, tools=${curr.toolHash}, userPrefix=${curr.userPrefixHash})`,
      );
      return undefined;
    }

    const diag = comparePrefixShape(this.prevShape, curr);
    this.prevShape = curr;

    if (diag.prefixStable) {
      this.hitCount++;
    }

    const hitRate = ((this.hitCount / (this.turnCount - 1)) * 100).toFixed(1);
    this.logger?.info?.(
      `${TAG} Turn ${this.turnCount}: ${diag.message} | ` +
      `session hit rate: ${hitRate}% (${this.hitCount}/${this.turnCount - 1})`,
    );

    if (!diag.prefixStable && diag.changedSections.length > 0) {
      this.logger?.debug?.(
        `${TAG} Cache-unfriendly changes: ${diag.changedSections.join(", ")}. ` +
        `Consider switching recall.injectionMode to "append" to stabilize the user prefix.`,
      );
    }

    return diag;
  }

  /** Reset the tracker for a new session. */
  reset(): void {
    this.prevShape = undefined;
    this.turnCount = 0;
    this.hitCount = 0;
  }

  /** Get the current cache hit rate across all recorded turns. */
  getHitRate(): number {
    if (this.turnCount <= 1) return 0;
    return this.hitCount / (this.turnCount - 1);
  }
}
