import { createHash } from "node:crypto";
import type {
  BudgetedRecallCandidate,
  RecallCandidate,
  RecallSnapshot,
} from "./protocol.js";

const SEPARATOR = "\n";
const SUFFIX = "…（已截断；可用 tdai_memory_search 或 tdai_conversation_search 查看详情）";
const MIN_TRUNCATED_CHARS = 40;

function normalizedLimit(value?: number): number | undefined {
  return value != null && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function truncateRecallLineExactly(line: string, maxChars: number): string {
  const codePoints = Array.from(line);
  if (codePoints.length <= maxChars) return line;
  if (maxChars <= SUFFIX.length) return codePoints.slice(0, maxChars).join("");
  return `${codePoints.slice(0, maxChars - SUFFIX.length).join("").trimEnd()}${SUFFIX}`;
}

export function budgetRecallCandidates(
  candidates: readonly RecallCandidate[],
  limits: { maxCharsPerMemory?: number; maxTotalRecallChars?: number },
): BudgetedRecallCandidate[] {
  const perMemory = normalizedLimit(limits.maxCharsPerMemory);
  const total = normalizedLimit(limits.maxTotalRecallChars);
  if (!perMemory && !total) {
    return candidates.map((candidate, originalRank) => ({
      ...candidate,
      originalRank,
      decision: "BUDGET_DISABLED",
      renderedLineAfterBudget: candidate.renderedLine,
    }));
  }

  const output: BudgetedRecallCandidate[] = [];
  let usedChars = 0;
  let exhausted = false;
  candidates.forEach((candidate, originalRank) => {
    if (exhausted) {
      output.push({ ...candidate, originalRank, decision: "DROPPED_TOTAL_BUDGET" });
      return;
    }
    const perBounded = perMemory ? truncateRecallLineExactly(candidate.renderedLine, perMemory) : candidate.renderedLine;
    let decision: BudgetedRecallCandidate["decision"] = perBounded === candidate.renderedLine ? "KEPT" : "TRUNCATED";
    let rendered = perBounded;
    if (total) {
      const separatorChars = output.some((item) => item.renderedLineAfterBudget != null) ? SEPARATOR.length : 0;
      const remaining = total - usedChars - separatorChars;
      if (remaining <= 0) {
        output.push({ ...candidate, originalRank, decision: "DROPPED_TOTAL_BUDGET" });
        exhausted = true;
        return;
      }
      // Preserve the production aggregate-budget contract, which counts UTF-16
      // code units even though the truncation itself is code-point safe.
      if (rendered.length > remaining) {
        if (remaining < MIN_TRUNCATED_CHARS) {
          output.push({ ...candidate, originalRank, decision: "DROPPED_TOTAL_BUDGET" });
          exhausted = true;
          return;
        }
        rendered = truncateRecallLineExactly(rendered, remaining);
        decision = "TRUNCATED";
        exhausted = true;
      }
      usedChars += separatorChars + rendered.length;
    }
    output.push({ ...candidate, originalRank, decision, renderedLineAfterBudget: rendered });
  });
  return output;
}

export function createRecallSnapshot(input: Omit<RecallSnapshot, "snapshotId" | "injectedCandidateIds">): RecallSnapshot {
  const injectedCandidateIds = input.budgetedCandidates
    .filter((candidate) => candidate.renderedLineAfterBudget != null)
    .map((candidate) => candidate.id);
  const digest = createHash("sha256").update(JSON.stringify({ ...input, injectedCandidateIds })).digest("hex").slice(0, 24);
  return Object.freeze({ ...input, snapshotId: `r0_${digest}`, injectedCandidateIds });
}
