/**
 * Recall budget: cap per-memory length and total injected char count.
 * Code-point aware — never splits a surrogate pair.
 */

import type { MemoryTdaiConfig } from "../../../config.js";
import type { Logger } from "../../types.js";
import {
  MIN_TRUNCATED_RECALL_LINE_CHARS,
  RECALL_LINE_SEPARATOR,
  RECALL_TRUNCATION_SUFFIX,
  TAG,
  type RecallDiagnostic,
  type RecallItem,
} from "./types.js";

/**
 * A rendered item: the structured element next to the line it produced.
 * The budget cuts the LINE (the suffix `(活动时间: …)` is appended after the
 * content, so truncating the content would leave the ellipsis mid-line and
 * blow the cap), while the item travels along so the caller keeps identity
 * and score for whatever survived (tz-10 C10.3).
 */
export interface RenderedItem {
  item: RecallItem;
  line: string;
}

/**
 * Apply per-memory and total recall budgets. Returns the surviving rendered
 * items plus a diagnostic per truncation/drop.
 * - `maxCharsPerMemory`: cap each line's length
 * - `maxTotalRecallChars`: cap the joined output length
 * Both default to "no limit" if undefined / non-positive.
 */
export function applyRecallBudget(
  rendered: RenderedItem[],
  recall: MemoryTdaiConfig["recall"],
  logger?: Logger,
): { kept: RenderedItem[]; diagnostics: RecallDiagnostic[] } {
  const lines = rendered.map((r) => r.line);
  const maxCharsPerMemory = normalizeBudgetLimit(recall.maxCharsPerMemory);
  const maxTotalRecallChars = normalizeBudgetLimit(recall.maxTotalRecallChars);
  if (!maxCharsPerMemory && !maxTotalRecallChars)
    return { kept: rendered, diagnostics: [] };

  const diagnostics: RecallDiagnostic[] = [];
  const keptItems: RecallItem[] = [];
  const budgeted: string[] = [];
  let usedChars = 0;
  let truncatedCount = 0;
  let droppedCount = 0;

  const keep = (index: number, line: string, wasTruncated: boolean): void => {
    const item = rendered[index]!.item;
    budgeted.push(line);
    keptItems.push(item);
    if (!wasTruncated) return;
    truncatedCount++;
    diagnostics.push({
      stage: "budget",
      code: "truncated",
      message: `line cut to ${line.length} chars`,
      itemId: item.memoryId,
    });
  };
  const drop = (from: number): void => {
    droppedCount += lines.length - from;
    for (let j = from; j < rendered.length; j++) {
      diagnostics.push({
        stage: "budget",
        code: "dropped",
        message: `no room left in maxTotalRecallChars=${maxTotalRecallChars}`,
        itemId: rendered[j]!.item.memoryId,
      });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const perMemoryBounded = maxCharsPerMemory
      ? truncateRecallLine(line, maxCharsPerMemory)
      : line;
    let wasTruncated = perMemoryBounded !== line;
    if (!maxTotalRecallChars) {
      keep(i, perMemoryBounded, wasTruncated);
      continue;
    }
    const separatorChars =
      budgeted.length > 0 ? RECALL_LINE_SEPARATOR.length : 0;
    const remainingChars = maxTotalRecallChars - usedChars - separatorChars;
    if (remainingChars <= 0) {
      drop(i);
      break;
    }
    if (perMemoryBounded.length > remainingChars) {
      const canFit = remainingChars >= MIN_TRUNCATED_RECALL_LINE_CHARS;
      if (canFit) {
        const totalBounded = truncateRecallLine(
          perMemoryBounded,
          remainingChars,
        );
        usedChars += separatorChars + totalBounded.length;
        wasTruncated ||= totalBounded !== perMemoryBounded;
        keep(i, totalBounded, wasTruncated);
      }
      drop(i + (canFit ? 1 : 0));
      break;
    }
    usedChars += separatorChars + perMemoryBounded.length;
    keep(i, perMemoryBounded, wasTruncated);
  }

  if (truncatedCount > 0 || droppedCount > 0) {
    logger?.debug?.(
      `${TAG} Recall budget applied: input=${lines.length}, output=${budgeted.length}, ` +
        `truncated=${truncatedCount}, dropped=${droppedCount}, ` +
        `maxCharsPerMemory=${recall.maxCharsPerMemory}, maxTotalRecallChars=${recall.maxTotalRecallChars}`,
    );
  }
  const kept = budgeted.map((line, i) => ({ item: keptItems[i]!, line }));
  return { kept, diagnostics };
}

function normalizeBudgetLimit(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function truncateRecallLine(line: string, maxChars: number): string {
  // Count and slice by code point, not UTF-16 code unit, so a cut never lands
  // between the halves of a surrogate pair (which would corrupt a non-BMP
  // character to U+FFFD when the line is UTF-8 encoded for the request).
  const cps = Array.from(line);
  if (cps.length <= maxChars) return line;
  if (maxChars <= RECALL_TRUNCATION_SUFFIX.length)
    return cps.slice(0, maxChars).join("");
  return `${cps
    .slice(0, maxChars - RECALL_TRUNCATION_SUFFIX.length)
    .join("")
    .trimEnd()}${RECALL_TRUNCATION_SUFFIX}`;
}
