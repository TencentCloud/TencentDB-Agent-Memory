/**
 * `assembleContext` — the one deterministic function that turns items into the
 * injected context (tz-10:110).
 *
 * Pure by construction: no fs, no network, no store, no clock, no randomness,
 * no module state. Everything variable — the tokenizer, the renderer, the
 * request identity — arrives as an argument, which is why the same items in any
 * order always produce the same envelope (tz-10 acceptance 3 and 6).
 */

import type { RecallDiagnostic } from "../hooks/auto-recall/types.js";
import { estimateTokens } from "./tokenizer.js";
import type {
  ContextAssemblerPolicy,
  ContextEnvelope,
  ContextRenderer,
  ContextSegment,
  MemoryItem,
  Tokenizer,
} from "./types.js";

/** Identity of the turn the context is assembled for. */
export interface ContextRequest {
  requestId: string;
  sessionKey: string;
  sessionId: string;
  projectId?: string;
}

/** How much room the context may take, in the tokenizer's units. */
export interface ContextBudget {
  total: number;
  reservedForUser: number;
}

/** tz-10:103 — scenes and same-project L1 outrank persona for inclusion. */
export const DEFAULT_PRECEDENCE: MemoryItem["kind"][] = [
  "scene",
  "l1",
  "persona",
];

/**
 * Total order over items: precedence by kind, then score, then id. The id
 * tie-break is what makes the result independent of the input order — without
 * it two equally scored items would keep whatever order they arrived in.
 */
function compareItems(
  a: MemoryItem,
  b: MemoryItem,
  precedence: MemoryItem["kind"][],
): number {
  const rank = (item: MemoryItem): number => {
    const index = precedence.indexOf(item.kind);
    return index === -1 ? precedence.length : index;
  };
  return (
    rank(a) - rank(b) ||
    b.score.final - a.score.final ||
    a.memoryId.localeCompare(b.memoryId)
  );
}

/**
 * Cost one item, surviving a tokenizer that throws: a broken tokenizer must
 * show up as a diagnostic, never as a silently missing element (C10.5). The
 * fallback is the same estimate the default tokenizer uses, so the number is
 * reproducible rather than arbitrary.
 */
function costOf(
  item: MemoryItem,
  tokenizer: Tokenizer,
  diagnostics: RecallDiagnostic[],
): number {
  try {
    return tokenizer.count(item.content);
  } catch (err) {
    diagnostics.push({
      stage: "tokenize",
      code: "tokenizer-failed",
      message: err instanceof Error ? err.message : String(err),
      itemId: item.memoryId,
    });
    return estimateTokens(item.content);
  }
}

/** Drop items whose content is byte-identical to one already kept. */
function dropDuplicates(
  items: MemoryItem[],
  diagnostics: RecallDiagnostic[],
  excluded: Array<{ item: MemoryItem; reason: string }>,
): MemoryItem[] {
  const seen = new Set<string>();
  const kept: MemoryItem[] = [];
  for (const item of items) {
    const key = item.content.trim();
    if (seen.has(key)) {
      excluded.push({ item, reason: "dedup:duplicate" });
      diagnostics.push({
        stage: "dedup",
        code: "duplicate",
        message: "identical content already included",
        itemId: item.memoryId,
      });
      continue;
    }
    seen.add(key);
    kept.push(item);
  }
  return kept;
}

/**
 * Assemble the context: order, dedup, fit into the budget, render, then verify
 * the budget against the FULL rendered text — wrappers and separators cost
 * tokens too, and an item-by-item sum does not see them.
 */
export function assembleContext(params: {
  items: MemoryItem[];
  policy: ContextAssemblerPolicy;
  budget: ContextBudget;
  tokenizer: Tokenizer;
  render: ContextRenderer;
  request: ContextRequest;
}): ContextEnvelope {
  const { items, policy, budget, tokenizer, render, request } = params;
  const diagnostics: RecallDiagnostic[] = [];
  const excluded: Array<{ item: MemoryItem; reason: string }> = [];
  const available = Math.max(0, budget.total - budget.reservedForUser);

  const costed = items.map((item) => ({
    ...item,
    tokenCost: costOf(item, tokenizer, diagnostics),
  }));
  const ordered = [...costed].sort((a, b) =>
    compareItems(a, b, policy.precedence),
  );
  const candidates =
    policy.dedup === "exact"
      ? dropDuplicates(ordered, diagnostics, excluded)
      : ordered;

  // A candidate that does not fit is skipped, not a stop signal: a cheaper one
  // further down may still fit, and the order is fixed, so the outcome stays
  // deterministic.
  let included: MemoryItem[] = [];
  let spent = 0;
  for (const item of candidates) {
    if (spent + item.tokenCost <= available) {
      included.push(item);
      spent += item.tokenCost;
      continue;
    }
    excluded.push({ item, reason: "budget" });
    diagnostics.push({
      stage: "budget",
      code: "dropped",
      message: `costs ${item.tokenCost}, ${available - spent} left of ${available}`,
      itemId: item.memoryId,
    });
  }

  let segments = render(included);
  let used = recount(segments, tokenizer, diagnostics, included);
  // The recount is the load-bearing check: the sum of item costs ignores the
  // wrappers, so a context can be over budget while every item "fit".
  for (let guard = included.length; used > available && guard > 0; guard--) {
    const evicted = included[included.length - 1]!;
    included = included.slice(0, -1);
    excluded.push({ item: evicted, reason: "budget" });
    diagnostics.push({
      stage: "budget",
      code: "recount-mismatch",
      message: `rendered context cost ${used} > ${available}; dropped after render`,
      itemId: evicted.memoryId,
    });
    segments = render(included);
    used = recount(segments, tokenizer, diagnostics, included);
  }

  const renderedContext = segments.map((s) => s.text).join("\n\n");
  const itemCosts = included.reduce((sum, item) => sum + item.tokenCost, 0);
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    sessionKey: request.sessionKey,
    sessionId: request.sessionId,
    projectId: request.projectId,
    budget: {
      total: budget.total,
      used,
      reservedForUser: budget.reservedForUser,
      tokenizerId: tokenizer.id,
      tokenizerVersion: tokenizer.version,
      renderOverhead: used - itemCosts,
    },
    included,
    excluded,
    diagnostics,
    renderedContext,
  };
}

/**
 * Cost of the full rendered text. A tokenizer that throws here leaves a
 * diagnostic and the item-cost sum — a defined number, so the envelope never
 * reports NaN.
 */
function recount(
  segments: ContextSegment[],
  tokenizer: Tokenizer,
  diagnostics: RecallDiagnostic[],
  included: MemoryItem[],
): number {
  const text = segments.map((s) => s.text).join("\n\n");
  try {
    return tokenizer.count(text);
  } catch (err) {
    diagnostics.push({
      stage: "tokenize",
      code: "recount-failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return included.reduce((sum, item) => sum + item.tokenCost, 0);
  }
}
