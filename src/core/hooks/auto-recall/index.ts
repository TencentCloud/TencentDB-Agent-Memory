/** Subdir entry: re-exports the public API of the auto-recall module. */

export { performAutoRecall } from "./recall.js";
export { applyRecallBudget } from "./budget.js";
export { applyTypeWeights, filterByScope, itemToRecalledMemory, passesScope, searchMemoriesWithDetails } from "./scope.js";
export { renderItems } from "./item.js";
export { RECALL_ITEM_SCHEMA_VERSION } from "./types.js";
export type { RecallResult, RecalledMemory, RecallItem, RecallDiagnostic, RecallDiagnosticStage, FormatableMemory, ScoredRecord, SearchTiming, SearchResult, StrategyResult, RecallStrategy, TypeWeights } from "./types.js";
