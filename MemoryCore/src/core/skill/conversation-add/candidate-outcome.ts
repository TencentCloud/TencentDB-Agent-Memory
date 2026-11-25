import type { ExtractedCandidate } from "../queue/types.js";

export interface CandidateOutcomeSummary {
  total: number;
  created: number;
  updated: number;
  nonCreate: number;
  byAction: Partial<Record<ExtractedCandidate["action"], number>>;
}

/**
 * Turn extractor candidates into a privacy-preserving task outcome summary.
 *
 * The summary intentionally records action types and counts only. Skill names
 * and content can contain user data, while action counts are enough to tell
 * whether a task created a skill, edited one, or produced no candidates.
 */
export function summarizeCandidateOutcomes(
  candidates: ExtractedCandidate[],
): CandidateOutcomeSummary {
  const byAction: Partial<Record<ExtractedCandidate["action"], number>> = {};
  for (const candidate of candidates) {
    byAction[candidate.action] = (byAction[candidate.action] ?? 0) + 1;
  }

  const created = byAction.create ?? 0;
  const updated = (byAction.patch ?? 0)
    + (byAction.edit ?? 0)
    + (byAction.update ?? 0)
    + (byAction.write_file ?? 0)
    + (byAction.files_write ?? 0);

  return {
    total: candidates.length,
    created,
    updated,
    nonCreate: candidates.length - created,
    byAction,
  };
}
