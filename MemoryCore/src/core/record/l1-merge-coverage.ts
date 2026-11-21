/**
 * Merge coverage check.
 *
 * When the conflict-detection model decides to `merge` / `update`, the target
 * records are deleted from the store and replaced by a single record whose
 * content is the model-generated `merged_content`. Nothing used to verify that
 * the merged text still carries the targets' facts — so a model that returned
 * an empty or under-written `merged_content` silently destroyed the facts of
 * the records it deleted.
 *
 * This module provides a deterministic, non-semantic check: a target counts as
 * covered when enough of its distinctive tokens reappear in the merged text.
 */

import type { IMemoryStore } from "../store/types.js";
import type { Logger } from "../../types.js";

const TAG = "[memory-tdai][l1-merge-coverage]";

/**
 * Normalize text into comparable "fact tokens".
 *
 * We deliberately avoid semantic judgement (an LLM call per merge would be
 * expensive and non-deterministic) and instead compare *literal* content:
 * a fact survives a merge only if the merged text still contains the target's
 * distinctive characters. Chinese text has no spaces, so we work on
 * character n-grams; ASCII runs are kept whole.
 */
function extractFactTokens(text: string): string[] {
  const normalized = text.toLowerCase();
  const tokens: string[] = [];

  // ASCII / alphanumeric runs (ports, model names, identifiers) — keep whole.
  for (const m of normalized.matchAll(/[a-z0-9][a-z0-9._:/-]{2,}/g)) {
    tokens.push(m[0]);
  }

  // CJK runs — character bigrams (a bigram is the smallest unit that still
  // carries a Chinese word's identity; single characters are too noisy).
  for (const m of normalized.matchAll(/[一-鿿]+/g)) {
    const run = m[0];
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      tokens.push(run.slice(i, i + 2));
    }
  }

  return tokens;
}

/**
 * Tokens that carry the fact's hard core and must survive **verbatim**.
 *
 * Ports, version numbers, model names and paths are the parts of a fact that
 * are silently wrong when they change: "port 8096" written as "port 8095"
 * keeps the sentence grammatical, so a ratio-based check passes it — but the
 * stored fact is now false.
 *
 * These tokens are therefore excluded from the ratio and checked separately
 * for *exact* presence.
 *
 * Timestamps are deliberately NOT part of that hard core — see
 * `TIMESTAMP_PATTERNS` below.
 */

/**
 * Timestamp-like fragments that must NOT be treated as fact-critical.
 *
 * Models legitimately restate timestamps when merging records ("确认于
 * 2026-11-21T03:43:12.923Z" → "确认于 2026-11-21"), and they may drop the
 * time part entirely. Treating those as altered critical values blocks every
 * legitimate merge, which makes the guard turn merges into plain stores and
 * inflates the record count — worse than not guarding at all.
 *
 * Real facts (ports, versions, model names, paths) are unaffected.
 */
const TIMESTAMP_PATTERNS: RegExp[] = [
  // ISO 8601 date-time: 2026-11-21T03:43:12.923Z / 2026-11-21 03:43:12+08:00
  /\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?/gi,
  // ISO date: 2026-11-21
  /\d{4}-\d{2}-\d{2}/g,
  // clock time: 03:43:12 / 03:43 / 03:43:12.923
  /\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?/g,
  // Chinese date: 2026年11月21日 / 11月21日
  /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/g,
  /\d{1,2}\s*月\s*\d{1,2}\s*日/g,
  // bare year with 年 marker: 2026年
  /\d{4}\s*年/g,
];

/**
 * Remove timestamp-like fragments so they are never collected as critical
 * tokens.
 */
function stripTimestamps(text: string): string {
  let out = text;
  for (const re of TIMESTAMP_PATTERNS) out = out.replace(re, " ");
  return out;
}

function extractCriticalTokens(text: string): string[] {
  const normalized = stripTimestamps(text).toLowerCase();
  const critical: string[] = [];

  // Runs containing at least one digit: ports, versions, counts, sizes.
  for (const m of normalized.matchAll(/[a-z0-9][a-z0-9._:/-]*(?:\d[a-z0-9._:/-]*)+/g)) {
    critical.push(m[0]);
  }

  // Dotted / slashed identifiers without digits: file names, module paths.
  for (const m of normalized.matchAll(/[a-z][a-z0-9._-]*(?:[./_][a-z0-9._-]+)+/g)) {
    critical.push(m[0]);
  }

  return [...new Set(critical)];
}

/**
 * Fraction of a target record's distinctive tokens that reappear in the
 * merged text. 1.0 = every token carried over, 0.0 = nothing carried over.
 */
function coverageRatio(targetContent: string, mergedContent: string): number {
  const targetTokens = extractFactTokens(targetContent);
  if (targetTokens.length === 0) return 1;

  const mergedTokens = new Set(extractFactTokens(mergedContent));
  let hit = 0;
  for (const t of targetTokens) {
    if (mergedTokens.has(t)) hit++;
  }
  return hit / targetTokens.length;
}

/**
 * Critical tokens of the target that do NOT appear verbatim in the merged
 * text. A non-empty result means the merged text states the fact with a
 * different value — worse than dropping it, because it looks correct.
 */
function findAlteredCriticalTokens(targetContent: string, mergedContent: string): string[] {
  const critical = extractCriticalTokens(targetContent);
  if (critical.length === 0) return [];

  const mergedLower = mergedContent.toLowerCase();
  return critical.filter((c) => !mergedLower.includes(c));
}

/**
 * Find target records whose facts are NOT covered by the merged content.
 *
 * A target is "covered" when at least `MERGE_COVERAGE_THRESHOLD` of its
 * distinctive tokens survive in the merged text. The threshold is deliberately
 * generous: we only want to block a merge when the model clearly failed to
 * carry the target over, not when it rephrased.
 */
const MERGE_COVERAGE_THRESHOLD = 0.6;

export async function findUncoveredTargets(
  targetIds: string[],
  mergedContent: string,
  vectorStore: IMemoryStore,
  logger?: Logger,
): Promise<string[]> {
  let existing: Array<{ record_id: string; content: string }>;
  try {
    existing = (await vectorStore.queryL1Records({ recordIds: targetIds })) as Array<{
      record_id: string;
      content: string;
    }>;
  } catch (err) {
    // Cannot verify coverage → assume covered (do not block the merge); the
    // write itself already logs failures at this level.
    logger?.debug?.(
      `${TAG} coverage check skipped: failed to read target records (${err instanceof Error ? err.message : String(err)})`,
    );
    return [];
  }

  const uncovered: string[] = [];
  for (const row of existing) {
    const content = row.content ?? "";

    // Hard-core tokens (ports, versions, paths) must survive verbatim — a
    // rephrased sentence that changed "8096" to "8095" states a false fact.
    const altered = findAlteredCriticalTokens(content, mergedContent);
    if (altered.length > 0) {
      logger?.warn?.(
        `${TAG} coverage check: target ${row.record_id} has altered critical token(s) ` +
        `(${altered.join(",")}) — treating target as uncovered`,
      );
      uncovered.push(row.record_id);
      continue;
    }

    const ratio = coverageRatio(content, mergedContent);
    if (ratio < MERGE_COVERAGE_THRESHOLD) {
      uncovered.push(row.record_id);
    }
  }
  return uncovered;
}


/**
 * Decide whether a merge / update may safely delete its target records.
 *
 * Returns `safe: false` when the model's `merged_content` cannot be trusted
 * to carry the targets' facts — the caller then degrades the action to
 * `store`, keeping both the new memory and the target records.
 */
export async function evaluateMergeCoverage(params: {
  action: string;
  mergedContent: string;
  targetIds: string[];
  newContent: string;
  vectorStore?: IMemoryStore;
  logger?: Logger;
}): Promise<{ safe: boolean; uncovered: string[] }> {
  const { action, mergedContent, targetIds, newContent, vectorStore, logger } = params;
  const empty = mergedContent.trim().length === 0;
  if (empty) {
    // `??` does not fall back on "" — an empty merged_content would produce
    // an empty surviving record while the targets are deleted.
    logger?.warn?.(
      `${action} downgraded to store: model returned empty merged_content; ` +
      `target records kept (${targetIds.join(",") || "none"})`,
    );
    return { safe: false, uncovered: targetIds };
  }

  if (targetIds.length === 0 || !vectorStore) {
    return { safe: true, uncovered: [] };
  }

  const uncovered = await findUncoveredTargets(targetIds, mergedContent, vectorStore, logger);
  if (uncovered.length > 0) {
    logger?.warn?.(
      `${action} downgraded to store: merged_content does not cover ` +
      `${uncovered.length}/${targetIds.length} target record(s) ` +
      `(${uncovered.join(",")}); targets kept to avoid fact loss`,
    );
    return { safe: false, uncovered };
  }

  return { safe: true, uncovered: [] };
}
