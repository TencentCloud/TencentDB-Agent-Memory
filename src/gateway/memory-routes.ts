/**
 * Memory read routes + discovery (P3) — slim shim.
 *
 * Per-route handlers + helpers live in `memory-routes/`:
 *   - info.ts          — GET /memory/info
 *   - records.ts       — GET /memory/records
 *   - duplicates.ts    — GET /memory/duplicates + findDuplicateClusters (P10 reuse)
 *   - blocks.ts        — GET /memory/blocks + collectBlockStats (P10 reuse)
 *   - validate.ts      — GET /memory/validate
 *   - helpers.ts       — queryL1Rows, clampInt, clampFloat, sameScope
 *   - validate-checks.ts — checkJsonIntegrity, checkSceneMeta, checkVecMetaCounts
 *   - context.ts       — MemoryRoutesContext
 *
 * This shim re-exports the public surface for `server.ts` + the dashboard
 * (reports.ts imports findDuplicateClusters, collectBlockStats, checkVecMetaCounts).
 */

export { handleMemoryInfo } from "./memory-routes/info.js";
export { handleMemoryRecords } from "./memory-routes/records.js";
export { handleMemoryDuplicates, findDuplicateClusters } from "./memory-routes/duplicates.js";
export { handleMemoryBlocks, collectBlockStats } from "./memory-routes/blocks.js";
export { handleMemoryValidate } from "./memory-routes/validate.js";
export { checkVecMetaCounts } from "./memory-routes/validate-checks.js";
export type { MemoryRoutesContext } from "./memory-routes/context.js";
