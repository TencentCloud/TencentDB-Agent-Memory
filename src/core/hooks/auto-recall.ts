/**
 * auto-recall hook (v3) — Group C decomp shim.
 *
 * Implementation now lives in `./auto-recall/`:
 *   - `types.ts`            — types, TAG, MEMORY_TOOLS_GUIDE, constants
 *   - `format.ts`           — formatMemoryLine, recordToFormatable, vectorResultToFormatable, ftsResultToFormatable, formatTimestamp
 *   - `budget.ts`           — applyRecallBudget, normalizeBudgetLimit, truncateRecallLine
 *   - `scope.ts`            — passesScope, applyTypeWeights, searchMemoriesWithDetails
 *   - `search.ts`           — searchMemories (dispatcher)
 *   - `search-keyword.ts`   — searchByKeyword (FTS5 BM25)
 *   - `search-embedding.ts` — searchByEmbedding (VectorStore cosine + type rerank)
 *   - `search-hybrid.ts`    — searchHybrid (parallel + RRF merge)
 *   - `recall.ts`           — performAutoRecall (public entry), performAutoRecallInner
 *   - `index.ts`            — subdir entry / canonical re-exports
 *
 * This file is a re-export shim to preserve the public import path
 * (`from "./auto-recall.js"`) used by `tdai-core`, `gateway/probe`,
 * `persona-budget.test.ts`, and `auto-recall.test.ts`.
 *
 * ## Behavior contract
 *   - Injects L1 recalled memories (dynamic, per-turn) into the user prompt.
 *   - Injects L3 persona + L2 scene navigation (stable, cacheable) into the system prompt.
 *   - Strategy resolution: keyword / embedding / hybrid (or fallback).
 *   - Honors `recall.timeoutMs` to avoid blocking the user.
 *   - Honors `recall.maxPersonaChars`, `recall.maxCharsPerMemory`, `recall.maxTotalRecallChars`.
 *   - Applies per-type rerank (improvement #2, ТЗ §5.15).
 *   - Filters by `passesScope` when `projectId` is provided.
 */

export { performAutoRecall, applyRecallBudget, applyTypeWeights, filterByScope, itemToRecalledMemory, passesScope, renderItems, searchMemoriesWithDetails, RECALL_ITEM_SCHEMA_VERSION } from "./auto-recall/index.js";
export type { RecallResult, RecalledMemory, RecallItem, RecallDiagnostic } from "./auto-recall/index.js";
