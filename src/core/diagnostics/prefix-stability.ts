/**
 * Prefix Stability Monitor — detects cacheable prefix changes across
 * multiple turns and identifies when the cache boundary drifts.
 *
 * Purpose: Diagnostic only. This module tracks prefix content across
 * conversation turns and reports on stability, drift, and churn.
 *
 * Why this matters:
 * - Prefix-matching providers (DeepSeek, MiMo) hash the token sequence
 *   before CACHE_BOUNDARY. If that prefix changes between turns, the
 *   cache is busted and the provider must re-process the entire prefix.
 * - Stability monitoring catches "silent drift" — incremental changes
 *   to the prefix that accumulate over time without obvious breakage.
 *
 * #375 and #433 provide caching optimizations; this module provides
 * the diagnostics to verify those optimizations are working correctly.
 */

import { auditCacheBoundary, DEFAULT_CACHE_BOUNDARY } from "./cache-boundary.js";

/** A single snapshot of the cache boundary state for a given turn. */
export interface PrefixSnapshot {
  /** Turn number (0-based) or unique turn identifier. */
  turnId: string;
  /** Hash of the prefix content (for fast equality comparison). */
  prefixHash: string;
  /** Length of the cacheable prefix in characters. */
  prefixLength: number;
  /** Position of CACHE_BOUNDARY in the system prompt. */
  boundaryIndex: number;
  /** Epoch ms when this snapshot was taken. */
  capturedAt: number;
}

/** Result of comparing two prefix snapshots. */
export interface PrefixDriftReport {
  /** Whether the prefix changed between the two snapshots. */
  drifted: boolean;
  /** The two snapshots compared. */
  previous: PrefixSnapshot;
  current: PrefixSnapshot;
  /** Difference in prefix length (current - previous). */
  lengthDelta: number;
  /** Difference in CACHE_BOUNDARY position (current - previous). */
  boundaryShift: number;
  /** Simple classification of the drift magnitude. */
  driftSeverity: "none" | "minor" | "significant";
}

/** Running history of prefix snapshots for trend analysis. */
export interface PrefixStabilityHistory {
  snapshots: PrefixSnapshot[];
  /** Total number of turns tracked. */
  totalTurns: number;
  /** Number of turns where the prefix changed. */
  driftCount: number;
  /** First and last snapshot timestamps. */
  firstSeenAt: number;
  lastSeenAt: number;
}

/**
 * Create a prefix snapshot from an assembled system prompt.
 *
 * Uses a simple length‑based hash for fast comparison. This is NOT
 * cryptographic — collisions are astronomically unlikely for
 * same‑length different‑content at real prompt sizes, but we also
 * compare lengths as a secondary discriminator.
 */
export function capturePrefixSnapshot(
  turnId: string,
  systemPrompt: string,
  cacheBoundary: string = DEFAULT_CACHE_BOUNDARY,
): PrefixSnapshot {
  const audit = auditCacheBoundary(systemPrompt, cacheBoundary);
  const prefixHash = hashPrefix(audit.prefixContent);

  return {
    turnId,
    prefixHash,
    prefixLength: audit.prefixLength,
    boundaryIndex: audit.boundaryIndex,
    capturedAt: audit.auditedAt,
  };
}

/**
 * Compare two prefix snapshots and produce a drift report.
 *
 * A drift is detected when EITHER:
 * - The prefix hash changes (content changed)
 * - The boundary position shifted
 */
export function detectDrift(
  previous: PrefixSnapshot,
  current: PrefixSnapshot,
): PrefixDriftReport {
  const prefixChanged = previous.prefixHash !== current.prefixHash;
  const boundaryMoved = previous.boundaryIndex !== current.boundaryIndex;
  const drifted = prefixChanged || boundaryMoved;
  const lengthDelta = current.prefixLength - previous.prefixLength;
  const boundaryShift = current.boundaryIndex - previous.boundaryIndex;

  let driftSeverity: PrefixDriftReport["driftSeverity"] = "none";
  if (drifted) {
    // Significant: boundary moved by > 100 chars OR prefix content changed
    // with a non-trivial length delta
    const largeShift = Math.abs(boundaryShift) > 100;
    const substantialChange = prefixChanged && Math.abs(lengthDelta) > 50;
    driftSeverity = largeShift || substantialChange ? "significant" : "minor";
  }

  return {
    drifted,
    previous,
    current,
    lengthDelta,
    boundaryShift,
    driftSeverity,
  };
}

/**
 * Initialize a new stability history.
 */
export function createStabilityHistory(): PrefixStabilityHistory {
  const now = Date.now();
  return {
    snapshots: [],
    totalTurns: 0,
    driftCount: 0,
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

/**
 * Add a new snapshot to the history and check for drift.
 *
 * Returns a drift report if this isn't the first snapshot; otherwise
 * returns undefined (nothing to compare against).
 */
export function updateHistory(
  history: PrefixStabilityHistory,
  snapshot: PrefixSnapshot,
): PrefixDriftReport | undefined {
  history.snapshots.push(snapshot);
  history.totalTurns++;
  history.lastSeenAt = snapshot.capturedAt;

  if (history.snapshots.length >= 2) {
    const previous = history.snapshots[history.snapshots.length - 2];
    const report = detectDrift(previous, snapshot);
    if (report.drifted) {
      history.driftCount++;
    }
    return report;
  }

  // First snapshot — nothing to compare against
  return undefined;
}

/**
 * Generate a summary of the prefix stability over the tracked history.
 */
export function summarizeHistory(history: PrefixStabilityHistory): string {
  const driftRate = history.totalTurns > 0
    ? ((history.driftCount / history.totalTurns) * 100).toFixed(1)
    : "0.0";

  const lines: string[] = [
    `[prefix-stability] Tracked ${history.totalTurns} turns`,
    `  Drifts detected: ${history.driftCount} (${driftRate}% instability rate)`,
  ];

  if (history.snapshots.length > 0) {
    const first = history.snapshots[0];
    const last = history.snapshots[history.snapshots.length - 1];
    lines.push(`  First turn: ${first.turnId} (prefix=${first.prefixLength} chars)`);
    lines.push(`  Last turn:  ${last.turnId} (prefix=${last.prefixLength} chars)`);
    if (first.prefixHash !== last.prefixHash) {
      lines.push(`  ⚠️ Net prefix change detected — first ≠ last hash`);
    } else {
      lines.push(`  ✅ Prefix stable — first == last hash`);
    }
  }

  return lines.join("\n");
}

/**
 * Lightweight non-cryptographic hash for prefix content comparison.
 *
 * Uses a simple djb2 variant — fast, deterministic, sufficient for
 * our use case (comparing same-system-prompt prefixes, not adversarial).
 */
function hashPrefix(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  // Encode as hex with zero-padding for readability
  return (hash >>> 0).toString(16).padStart(8, "0");
}
