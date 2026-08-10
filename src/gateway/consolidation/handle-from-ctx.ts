/**
 * Adapt the OrchestratorContext to the TriggerHandle shape that triggers.ts
 * functions consume. Pure projection — no shared state.
 */
import { executeRunForRole } from "./execute-run.js";
import { readLastReport } from "./reports.js";
import type { TriggerHandle } from "./triggers.js";
import type { OrchestratorContext } from "./context.js";
import type { Logger } from "../../core/types.js";

export function handleFromCtx(ctx: OrchestratorContext): TriggerHandle {
  return {
    roleName: ctx.roleName,
    roleDir: ctx.roleDir,
    now: ctx.now,
    enabled: ctx.enabled,
    dataDir: ctx.dataDir,
    scratchRoot: ctx.scratchRoot,
    logger: ctx.logger as Logger,
    ownerPid: ctx.ownerPid,
    activeRunUuid: ctx.activeRunUuidRef,
    children: ctx.childrenRef,
    lastRunRef: ctx.lastRunRef,
    gate: ctx.gate,
    roleDefaults: ctx.roleDefaults,
    executeRun: (o: {
      reason: string;
      dryRun?: boolean;
      runId: string;
      role: string;
    }) => executeRunForRole(ctx, o),
    readLastReport: () => readLastReport(ctx),
    checkpoint: ctx.checkpoint,
  };
}
