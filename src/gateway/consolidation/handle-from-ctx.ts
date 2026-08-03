/**
 * Adapt the OrchestratorContext to the TriggerHandle shape that triggers.ts
 * functions consume. Pure projection — no shared state.
 */
import { executeRunDay } from "./day-runner.js";
import { executeRunNight } from "./night-runner.js";
import { readLastReport } from "./reports.js";
import type { TriggerHandle } from "./triggers.js";
import type { OrchestratorContext } from "./context.js";
import type { Logger } from "../../core/types.js";

export function handleFromCtx(ctx: OrchestratorContext): TriggerHandle {
  return {
    roleName: ctx.roleName,
    roleDir: ctx.roleDir,
    now: ctx.now,
    config: ctx.config,
    dataDir: ctx.dataDir,
    scratchRoot: ctx.scratchRoot,
    logger: ctx.logger as Logger,
    ownerPid: ctx.ownerPid,
    activeRunUuid: ctx.activeRunUuidRef,
    children: ctx.childrenRef,
    lastRunRef: ctx.lastRunRef,
    gate: ctx.gate,
    executeRun: (o: {
      reason: string;
      dryRun?: boolean;
      runId: string;
      role: string;
    }) =>
      o.role === "night-keeper"
        ? executeRunNight(ctx, o)
        : executeRunDay(ctx, o),
    readLastReport: () => readLastReport(ctx),
    checkpoint: ctx.checkpoint,
  };
}
