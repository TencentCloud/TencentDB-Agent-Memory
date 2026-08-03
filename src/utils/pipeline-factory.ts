/**
 * Pipeline factory (Group C decomp — shim).
 *
 * Implementation now lives in `./pipeline-factory/`:
 *   - `types.ts`     — PipelineLogger, PipelineFactoryOptions, PipelineInstance,
 *                       warnOnce, isConsolidationEnabled, supportsProfileSyncWrite
 *   - `stores.ts`    — initStores / resetStores / initDataDirectories / _doInitStores
 *   - `persister.ts` — createPersister
 *   - `l1-runner.ts` — createL1Runner
 *   - `l2-runner.ts` — createL2Runner
 *   - `l3-runner.ts` — createL3Runner
 *   - `pipeline.ts`  — createPipeline, createPipelineManager
 *
 * This file is a re-export shim to preserve the public import path
 * (`from "./pipeline-factory.js"`) used by `gateway/server.ts`,
 * `seed-runtime.ts`, `tdai-core.ts`, and the test suite.
 *
 * ## Module map
 *
 * - `src/gateway/server.ts:23`     → `initDataDirectories`
 * - `src/core/tdai-core.ts:48`     → `createL1Runner, createL2Runner, createL3Runner,
 *                                     createPipeline, initDataDirectories`
 * - `src/core/seed/seed-runtime.ts` → `createPipeline, createL2Runner, createL3Runner,
 *                                      PipelineInstance, PipelineLogger`
 * - `src/utils/pipeline-factory.test.ts` → `createL2Runner, createL3Runner`
 */

export { initDataDirectories, initStores, resetStores } from "./pipeline-factory/stores.js";
export { createPersister } from "./pipeline-factory/persister.js";
export { createL1Runner } from "./pipeline-factory/l1-runner.js";
export { createL2Runner } from "./pipeline-factory/l2-runner.js";
export { createL3Runner } from "./pipeline-factory/l3-runner.js";
export { createPipeline, createPipelineManager } from "./pipeline-factory/pipeline.js";
export type { PipelineFactoryOptions, PipelineInstance, PipelineLogger } from "./pipeline-factory/types.js";
export { isConsolidationEnabled, supportsProfileSyncWrite, warnOnce } from "./pipeline-factory/types.js";
