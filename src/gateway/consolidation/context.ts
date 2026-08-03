/**
 * Orchestrator context — bundle of dependencies + mutable state.
 *
 * Module-level runner functions (day-runner, night-runner, runner) take
 * this context instead of using `this`, so the class shell in
 * orchestrator.ts can be a thin delegator.
 */

import type { GatewayConfig } from "../config.js";
import type { Logger } from "../../core/types.js";
import type { IMemoryStore } from "../../core/store/types.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import { ConsolidationCheckpoint } from "./checkpoint.js";
import { RoleGate } from "./role-gate.js";
import type { RunSummary, SpawnChildFn, ApplyDiffFn } from "./types.js";

export interface OrchestratorContext {
  config: GatewayConfig;
  dataDir: string;
  scratchRoot: string;
  logger: Logger;
  gatewayUrl: string;
  vectorStore?: () => IMemoryStore | undefined;
  embeddingService?: () => EmbeddingService | undefined;
  now: () => number;
  spawnChild: SpawnChildFn;
  applyDiff: ApplyDiffFn;
  roleName: string;
  roleDir: string;
  /** Orchestrator pid — stamped into keeper children (PI_MEMORY_KEEPER_OWNER)
   * so the orphan sweep never kills another live orchestrator's children. */
  ownerPid: number;
  checkpoint: ConsolidationCheckpoint;
  gate: RoleGate;
  /** Mutable state wrapped in refs so module-level functions can read/write. */
  activeRunUuidRef: { value: Set<string> };
  /** Per-run kill handles (parallel roles → multiple children alive at once). */
  childrenRef: { value: Map<string, { kill: () => unknown }> };
  lastRunRef: { value: RunSummary | null };
}
