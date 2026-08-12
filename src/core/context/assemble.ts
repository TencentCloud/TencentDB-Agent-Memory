/**
 * `assembleContext` — the one deterministic function that turns items into the
 * injected context (tz-10:110).
 *
 * Pure by construction: no fs, no network, no store, no clock, no randomness,
 * no module state. Everything variable — the tokenizer, the renderer, the
 * request identity — arrives as an argument, which is why the same items in any
 * order always produce the same envelope (tz-10 acceptance 3 and 6).
 */

import { estimateTokens } from "./tokenizer.js";
import type {
  RecallDiagnostic,
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
  // Content is the last tie-break, not the input position: a store that
  // exposes no record id (tcvdb returns "") would otherwise leave two items
  // ordered by however they arrived, and permutations would render different
  // text under equal ids.
  return (
    rank(a) - rank(b) ||
    b.score.final - a.score.final ||
    a.memoryId.localeCompare(b.memoryId) ||
    a.content.localeCompare(b.content)
  );
}

/**
 * Cost one item on the text it actually contributes, surviving a tokenizer that
 * throws: a broken tokenizer must show up as a diagnostic, never as a silently
 * missing element (C10.5). The fallback is the same estimate the default
 * tokenizer uses, so the number is reproducible rather than arbitrary.
 */
function costOf(
  item: MemoryItem,
  text: string,
  tokenizer: Tokenizer,
  diagnostics: RecallDiagnostic[],
): number {
  try {
    return tokenizer.count(text);
  } catch (err) {
    diagnostics.push({
      stage: "tokenize",
      code: "tokenizer-failed",
      message: err instanceof Error ? err.message : String(err),
      itemId: item.memoryId,
    });
    return estimateTokens(text);
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
  /**
   * The text an item costs when included. Defaults to its content; a caller
   * whose renderer wraps or prefixes an item passes that rendered text, so the
   * item is charged for what really enters the prompt instead of leaving the
   * difference to accumulate in `renderOverhead`.
   */
  costText?: (item: MemoryItem) => string;
}): ContextEnvelope {
  const { items, policy, budget, tokenizer, render, request } = params;
  const diagnostics: RecallDiagnostic[] = [];
  const excluded: Array<{ item: MemoryItem; reason: string }> = [];
  const available = Math.max(0, budget.total - budget.reservedForUser);

  const candidates = selectCandidates({
    items,
    policy,
    tokenizer,
    costText: params.costText ?? ((item: MemoryItem) => item.content),
    diagnostics,
    excluded,
  });
  const fitted = fitToBudget(candidates, available, diagnostics, excluded);
  const { included, segments, used } = evictUntilFits({
    included: fitted,
    available,
    tokenizer,
    render,
    diagnostics,
    excluded,
  });
  return buildEnvelope({
    request,
    budget,
    tokenizer,
    included,
    excluded,
    diagnostics,
    segments,
    used,
  });
}

/** Cost every item, put them in the one true order, then drop duplicates. */
function selectCandidates(p: {
  items: MemoryItem[];
  policy: ContextAssemblerPolicy;
  tokenizer: Tokenizer;
  costText: (item: MemoryItem) => string;
  diagnostics: RecallDiagnostic[];
  excluded: Array<{ item: MemoryItem; reason: string }>;
}): MemoryItem[] {
  const costed = p.items.map((item) => ({
    ...item,
    tokenCost: costOf(item, p.costText(item), p.tokenizer, p.diagnostics),
  }));
  const ordered = [...costed].sort((a, b) =>
    compareItems(a, b, p.policy.precedence),
  );
  return p.policy.dedup === "exact"
    ? dropDuplicates(ordered, p.diagnostics, p.excluded)
    : ordered;
}

/** Pack the finished assembly into the envelope the caller audits. */
function buildEnvelope(p: {
  request: ContextRequest;
  budget: ContextBudget;
  tokenizer: Tokenizer;
  included: MemoryItem[];
  excluded: Array<{ item: MemoryItem; reason: string }>;
  diagnostics: RecallDiagnostic[];
  segments: ContextSegment[];
  used: number;
}): ContextEnvelope {
  const itemCosts = p.included.reduce((sum, item) => sum + item.tokenCost, 0);
  return {
    schemaVersion: 1,
    requestId: p.request.requestId,
    sessionKey: p.request.sessionKey,
    sessionId: p.request.sessionId,
    projectId: p.request.projectId,
    budget: {
      total: p.budget.total,
      used: p.used,
      reservedForUser: p.budget.reservedForUser,
      tokenizerId: p.tokenizer.id,
      tokenizerVersion: p.tokenizer.version,
      renderOverhead: p.used - itemCosts,
    },
    included: p.included,
    excluded: p.excluded,
    diagnostics: p.diagnostics,
    segments: p.segments,
    renderedContext: p.segments.map((s) => s.text).join("\n\n"),
  };
}

/**
 * Take candidates in order while they fit. A candidate that does not fit is
 * skipped, not a stop signal: a cheaper one further down may still fit, and the
 * order is fixed, so the outcome stays deterministic.
 */
function fitToBudget(
  candidates: MemoryItem[],
  available: number,
  diagnostics: RecallDiagnostic[],
  excluded: Array<{ item: MemoryItem; reason: string }>,
): MemoryItem[] {
  const included: MemoryItem[] = [];
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
  return included;
}

/**
 * Render, then drop from the tail until the RENDERED text fits. This is the
 * load-bearing check: the sum of item costs ignores the wrappers, so a context
 * can be over budget while every item "fit".
 */
function evictUntilFits(p: {
  included: MemoryItem[];
  available: number;
  tokenizer: Tokenizer;
  render: ContextRenderer;
  diagnostics: RecallDiagnostic[];
  excluded: Array<{ item: MemoryItem; reason: string }>;
}): { included: MemoryItem[]; segments: ContextSegment[]; used: number } {
  let included = p.included;
  let segments = p.render(included);
  let used = recount(segments, p.tokenizer, p.diagnostics, included);
  for (let guard = included.length; used > p.available && guard > 0; guard--) {
    const evicted = included[included.length - 1]!;
    included = included.slice(0, -1);
    p.excluded.push({ item: evicted, reason: "budget" });
    p.diagnostics.push({
      stage: "budget",
      code: "recount-mismatch",
      message: `rendered context cost ${used} > ${p.available}; dropped after render`,
      itemId: evicted.memoryId,
    });
    segments = p.render(included);
    used = recount(segments, p.tokenizer, p.diagnostics, included);
  }
  return { included, segments, used };
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
