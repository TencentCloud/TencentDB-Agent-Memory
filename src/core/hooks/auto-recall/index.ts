/** Subdir entry: re-exports the public API of the auto-recall module. */

export { performAutoRecall } from "./recall.js";
export { applyRecallBudget } from "./budget.js";
export { applyTypeWeights, passesScope, searchMemoriesWithDetails } from "./scope.js";
export type { RecallResult, RecalledMemory, FormatableMemory, ScoredRecord, SearchTiming, SearchResult, RecallStrategy, TypeWeights } from "./types.js";
