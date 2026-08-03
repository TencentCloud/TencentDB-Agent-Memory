/**
 * Recall budget: cap per-memory length and total injected char count.
 * Code-point aware — never splits a surrogate pair.
 */

import type { MemoryTdaiConfig } from "../../../config.js";
import type { Logger } from "../../types.js";
import { MIN_TRUNCATED_RECALL_LINE_CHARS, RECALL_LINE_SEPARATOR, RECALL_TRUNCATION_SUFFIX, TAG } from "./types.js";

/**
 * Apply per-memory and total recall budgets. Returns the budgeted lines.
 * - `maxCharsPerMemory`: cap each line's length
 * - `maxTotalRecallChars`: cap the joined output length
 * Both default to "no limit" if undefined / non-positive.
 */
export function applyRecallBudget(
  lines: string[],
  recall: MemoryTdaiConfig["recall"],
  logger?: Logger,
): string[] {
  const maxCharsPerMemory = normalizeBudgetLimit(recall.maxCharsPerMemory);
  const maxTotalRecallChars = normalizeBudgetLimit(recall.maxTotalRecallChars);
  if (!maxCharsPerMemory && !maxTotalRecallChars) return lines;

  const budgeted: string[] = [];
  let usedChars = 0;
  let truncatedCount = 0;
  let droppedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const perMemoryBounded = maxCharsPerMemory ? truncateRecallLine(line, maxCharsPerMemory) : line;
    let wasTruncated = perMemoryBounded !== line;
    if (!maxTotalRecallChars) {
      budgeted.push(perMemoryBounded);
      if (wasTruncated) truncatedCount++;
      continue;
    }
    const separatorChars = budgeted.length > 0 ? RECALL_LINE_SEPARATOR.length : 0;
    const remainingChars = maxTotalRecallChars - usedChars - separatorChars;
    if (remainingChars <= 0) {
      droppedCount += lines.length - i;
      break;
    }
    if (perMemoryBounded.length > remainingChars) {
      const canFit = remainingChars >= MIN_TRUNCATED_RECALL_LINE_CHARS;
      if (canFit) {
        const totalBounded = truncateRecallLine(perMemoryBounded, remainingChars);
        budgeted.push(totalBounded);
        usedChars += separatorChars + totalBounded.length;
        wasTruncated ||= totalBounded !== perMemoryBounded;
        if (wasTruncated) truncatedCount++;
      }
      droppedCount += lines.length - i - (canFit ? 1 : 0);
      break;
    }
    budgeted.push(perMemoryBounded);
    usedChars += separatorChars + perMemoryBounded.length;
    if (wasTruncated) truncatedCount++;
  }

  if (truncatedCount > 0 || droppedCount > 0) {
    logger?.debug?.(
      `${TAG} Recall budget applied: input=${lines.length}, output=${budgeted.length}, ` +
      `truncated=${truncatedCount}, dropped=${droppedCount}, ` +
      `maxCharsPerMemory=${recall.maxCharsPerMemory}, maxTotalRecallChars=${recall.maxTotalRecallChars}`,
    );
  }
  return budgeted;
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
  if (maxChars <= RECALL_TRUNCATION_SUFFIX.length) return cps.slice(0, maxChars).join("");
  return `${cps.slice(0, maxChars - RECALL_TRUNCATION_SUFFIX.length).join("").trimEnd()}${RECALL_TRUNCATION_SUFFIX}`;
}
