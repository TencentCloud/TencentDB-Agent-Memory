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
    const ratio = coverageRatio(row.content ?? "", mergedContent);
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
