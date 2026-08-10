/**
 * Dependency type for the apply pipeline.
 *
 * Split from types.ts so the apply operations + ApplyExecutor class can
 * share a single type without forcing types.ts to import from
 * core/store/embedding.js (which would couple pure result types to runtime
 * service interfaces).
 */

import type { IMemoryStore } from "../../core/store/types.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import type { Logger } from "../../core/types.js";

export interface ApplyExecutorDeps {
  dataDir: string;
  logger: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  /** tz-09 Ф6: when true an apply must name a live Run and its ops/caps come
   * from that Run's pinned contract. Absent → the pre-tz-09 behaviour, which
   * is what the direct call sites (and the rollback switch) rely on. */
  runRepo?: boolean;
}
