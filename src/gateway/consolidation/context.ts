/**
 * Orchestrator context — bundle of dependencies + mutable state.
 *
 * Module-level runner functions (day-runner, night-runner, runner) take
 * this context instead of using `this`, so the class shell in
 * orchestrator.ts can be a thin delegator.
 */

import type { GatewayConfig } from "../config.js";
import type { Logger } from "../../core/types.js";
import type { RoleLauncher } from "./launchers/types.js";
import type { IMemoryStore } from "../../core/store/types.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import { ConsolidationCheckpoint } from "./checkpoint.js";
import { RoleGate } from "./role-gate.js";
import type { RunSummary, SpawnChildFn, ApplyDiffFn } from "./types.js";
import type {
  RoleLegacyDefaults,
} from "./role-contract-types.js";

export interface OrchestratorContext {
  /** Kept for the post-run recall probe (memory-wide knobs). Role parameters
   * NEVER come from here — they come from the resolved contract (tz-01). */
  config: GatewayConfig;
  /** Consolidation master switch, lifted out of the config read path. */
  enabled: boolean;
  /** Global fallbacks the LegacyRoleAdapter may use, snapshotted by the
   * composition root (server.ts) — see `contract-drives-execution`. */
  roleDefaults: RoleLegacyDefaults;
  /** Apply-gate mode (tz-09 Ф3) — read once at the composition root from
   * `memory.consolidation.applyGateMode`, never from inside consolidation/. */
  applyGateMode: "shadow" | "enforce";
  /** tz-09 Ф6: require a control-plane Run for every apply. Composition-root
   * value from `memory.consolidation.applyRunRepo`. */
  applyRunRepo: boolean;
  /** tz-06 Ф1: the host substitution point. The binding names a launcher and
   * this resolves it; nothing outside `launchers/` knows what a host needs. */
  launcherFor: (launcherId: string) => RoleLauncher;
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
