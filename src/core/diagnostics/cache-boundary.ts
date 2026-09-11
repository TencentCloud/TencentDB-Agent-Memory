/**
 * Cache Boundary Auditor — verifies CACHE_BOUNDARY marker position
 * and stability within the assembled system prompt.
 *
 * Purpose: Diagnostic only. This module observes and reports on the
 * cache boundary without modifying any prompt content. It helps
 * developers and operators understand the cacheable prefix structure
 * that prefix-matching providers (DeepSeek, MiMo, etc.) rely on.
 *
 * This does NOT optimize cache hit rates — it measures what's
 * actually happening so that optimization decisions can be data-driven.
 *
 * #375 and #433 provide caching optimizations; this module provides
 * the diagnostics to verify those optimizations are working correctly.
 */

/** Result of a single cache boundary audit. */
export interface CacheBoundaryAudit {
  /** Whether a CACHE_BOUNDARY marker was found in the system prompt. */
  boundaryFound: boolean;
  /** 0-based index of the marker start, or -1 if not found. */
  boundaryIndex: number;
  /** Content BEFORE the boundary (cacheable prefix). */
  prefixContent: string;
  /** Content AFTER the boundary (dynamic region). */
  postBoundaryContent: string;
  /** Character count of the cacheable prefix. */
  prefixLength: number;
  /** Character count of the dynamic region. */
  postBoundaryLength: number;
  /** Cacheable prefix ratio: prefixLength / totalLength (0-1). */
  cacheableRatio: number;
  /** Total system prompt length. */
  totalLength: number;
  /** Timestamp of this audit (epoch ms). */
  auditedAt: number;
}

/**
 * Default CACHE_BOUNDARY marker used by OpenClaw and compatible hosts.
 * This is the standard marker that delineates the cacheable prefix region
 * from per-turn dynamic content.
 */
export const DEFAULT_CACHE_BOUNDARY = "<!-- CACHE_BOUNDARY -->";

/**
 * Audit the cache boundary in an assembled system prompt.
 *
 * Returns a detailed report on boundary position, prefix content,
 * and cache efficiency metrics. Pure function — no side effects.
 *
 * @param systemPrompt The fully assembled system prompt to audit.
 * @param cacheBoundary Optional custom boundary marker (defaults to OpenClaw's).
 */
export function auditCacheBoundary(
  systemPrompt: string,
  cacheBoundary: string = DEFAULT_CACHE_BOUNDARY,
): CacheBoundaryAudit {
  const now = Date.now();
  const totalLength = systemPrompt.length;
  const idx = systemPrompt.indexOf(cacheBoundary);

  if (idx === -1) {
    return {
      boundaryFound: false,
      boundaryIndex: -1,
      prefixContent: "",
      postBoundaryContent: systemPrompt,
      prefixLength: 0,
      postBoundaryLength: totalLength,
      cacheableRatio: 0,
      totalLength,
      auditedAt: now,
    };
  }

  const prefixContent = systemPrompt.slice(0, idx);
  const postBoundaryContent = systemPrompt.slice(idx + cacheBoundary.length);
  const prefixLength = prefixContent.length;
  const postBoundaryLength = postBoundaryContent.length;

  return {
    boundaryFound: true,
    boundaryIndex: idx,
    prefixContent,
    postBoundaryContent,
    prefixLength,
    postBoundaryLength,
    cacheableRatio: totalLength > 0 ? prefixLength / totalLength : 0,
    totalLength,
    auditedAt: now,
  };
}

/**
 * Generate a human-readable summary of the cache boundary audit.
 *
 * Suitable for debug-log output or embedding in an audit trail.
 */
export function formatAuditSummary(audit: CacheBoundaryAudit): string {
  if (!audit.boundaryFound) {
    return (
      `[cache-audit] CACHE_BOUNDARY NOT FOUND — entire system prompt ` +
      `(${audit.totalLength} chars) is uncacheable prefix`
    );
  }

  const pct = (audit.cacheableRatio * 100).toFixed(1);
  return (
    `[cache-audit] CACHE_BOUNDARY at offset ${audit.boundaryIndex}: ` +
    `prefix=${audit.prefixLength} chars (${pct}% cacheable), ` +
    `post-boundary=${audit.postBoundaryLength} chars`
  );
}

/**
 * Quick check: does the system prompt have a valid cache boundary?
 */
export function hasCacheBoundary(
  systemPrompt: string,
  cacheBoundary: string = DEFAULT_CACHE_BOUNDARY,
): boolean {
  return systemPrompt.includes(cacheBoundary);
}

/**
 * Verify that dynamic content (e.g. L1 memories) is NOT in the cacheable prefix.
 *
 * If dynamic content leaks into the prefix, every turn will bust the cache
 * for all content after it. This check is a safety guard.
 *
 * @returns Array of leaked strings found in the prefix, or empty array if clean.
 */
export function detectPrefixLeaks(
  prefixContent: string,
  dynamicContent: string[],
): string[] {
  const leaks: string[] = [];
  for (const content of dynamicContent) {
    if (prefixContent.includes(content)) {
      leaks.push(content);
    }
  }
  return leaks;
}
