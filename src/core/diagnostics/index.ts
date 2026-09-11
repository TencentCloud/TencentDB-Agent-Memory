/**
 * Prefix Stability Diagnostics — unified entry point.
 *
 * This module provides diagnostic tooling for cache boundary verification,
 * prefix stability monitoring, and drift detection. It is OBSERVATION-ONLY:
 * no prompt content is modified, no configuration is added, no behavior
 * is changed.
 *
 * These diagnostics complement caching optimization PRs like #375 and #433
 * by providing the visibility needed to verify those optimizations are
 * working correctly in production.
 *
 * Usage:
 *   import { auditCacheBoundary, capturePrefixSnapshot, detectDrift } from "...";
 *
 *   // Audit a single turn
 *   const audit = auditCacheBoundary(systemPrompt);
 *   console.log(formatAuditSummary(audit));
 *
 *   // Track prefix stability across turns
 *   const snap1 = capturePrefixSnapshot("turn-1", systemPrompt);
 *   const snap2 = capturePrefixSnapshot("turn-2", systemPrompt);
 *   const drift = detectDrift(snap1, snap2);
 *   if (drift.drifted) console.warn("Prefix drifted!");
 */

export {
  auditCacheBoundary,
  formatAuditSummary,
  hasCacheBoundary,
  detectPrefixLeaks,
  DEFAULT_CACHE_BOUNDARY,
} from "./cache-boundary.js";

export type { CacheBoundaryAudit } from "./cache-boundary.js";

export {
  capturePrefixSnapshot,
  detectDrift,
  createStabilityHistory,
  updateHistory,
  summarizeHistory,
} from "./prefix-stability.js";

export type {
  PrefixSnapshot,
  PrefixDriftReport,
  PrefixStabilityHistory,
} from "./prefix-stability.js";
