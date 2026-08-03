/**
 * Public types for the pipeline-factory: factory options, instance shape,
 * logger alias, store-init result, and shared gate utilities (warnOnce,
 * isConsolidationEnabled, supportsProfileSyncWrite).
 */

import type { MemoryTdaiConfig } from "../../config.js";
import type { IMemoryStore } from "../../core/store/types.js";
import type { MemoryPipelineManager } from "../pipeline-manager.js";
import type { Logger } from "../../core/types.js";

const TAG = "[memory-tdai] [pipeline-factory]";

/** @deprecated Use `Logger` from `../core/types.js` directly. */
export type PipelineLogger = Logger;

/** Emit a warning at most once per distinct message (module-level memo). */
const warnOnceEmitted = new Set<string>();
export function warnOnce(logger: PipelineLogger, message: string): void {
  if (warnOnceEmitted.has(message)) return;
  warnOnceEmitted.add(message);
  logger.warn(`${TAG} ${message}`);
}

/**
 * P5 single-writer gate: when `memory.consolidation.enabled`, the inline
 * L2/L3 runners become no-ops — scene/persona writes are owned by the
 * memory-keeper sub-session via /memory/apply. Default enabled=false.
 */
export function isConsolidationEnabled(cfg: MemoryTdaiConfig): boolean {
  return cfg.consolidation?.enabled === true;
}

export function supportsProfileSyncWrite(store?: IMemoryStore): boolean {
  return !!(store?.syncProfiles || store?.deleteProfiles);
}

export interface PipelineFactoryOptions {
  /** Plugin data directory (L0, records, scene_blocks, vectors.db, etc.). */
  pluginDataDir: string;
  /** Parsed memory-tdai config. */
  cfg: MemoryTdaiConfig;
  /** OpenClaw config object (needed for LLM calls in L1). */
  openclawConfig: unknown;
  /** Logger instance. */
  logger: PipelineLogger;
  /** Session filter (optional, defaults to empty). */
  sessionFilter?: import("../session-filter.js").SessionFilter;
  /** Host-neutral LLM runner for L1 extraction (text-only, enableTools=false). */
  l1LlmRunner?: import("../../core/types.js").LLMRunner;
  /** Host-neutral LLM runner for L2/L3 (tool-call enabled, enableTools=true). */
  l2l3LlmRunner?: import("../../core/types.js").LLMRunner;
}

export interface PipelineInstance {
  /** The pipeline scheduler. */
  scheduler: MemoryPipelineManager;
  /** VectorStore (undefined if init failed or degraded). */
  vectorStore: IMemoryStore | undefined;
  /** EmbeddingService (undefined if not configured or init failed). */
  embeddingService: import("../../core/store/embedding.js").EmbeddingService | undefined;
  /**
   * Destroy all resources (scheduler, VectorStore, EmbeddingService).
   * Call this on shutdown / cleanup.
   */
  destroy: () => Promise<void>;
}
