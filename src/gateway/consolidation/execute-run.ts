/**
 * Contract-driven run entry (tz-01 B1/B2).
 *
 * One place resolves the role contract for a run and hands it to the batching
 * strategy the contract NAMES. The role name is never compared against a
 * literal — that was `orchestrator.ts:143` and `handle-from-ctx.ts:29`.
 *
 * A role that does not resolve does not run: the summary comes back as
 * `disabled` carrying the reason (`fail-closed-role`).
 */
import { resolveRoleContract } from "./role-contract.js";
import { executeRunDay } from "./day-runner.js";
import { executeRunNight } from "./night-runner.js";
import { mkFailedSummary } from "./summary.js";
import type { OrchestratorContext } from "./context.js";
import type { RunSummary } from "./types.js";

export interface ExecuteRunOpts {
  reason: string;
  dryRun?: boolean;
  runId: string;
  role: string;
}

export async function executeRunForRole(
  ctx: OrchestratorContext,
  opts: ExecuteRunOpts,
): Promise<RunSummary> {
  const resolution = resolveRoleContract(
    opts.role,
    ctx.roleDir,
    ctx.roleDefaults,
  );
  if (!resolution.ok) {
    const startedAt = new Date(ctx.now()).toISOString();
    const summary = mkFailedSummary(
      opts.role,
      startedAt,
      opts.reason,
      opts.dryRun,
    );
    summary.status = "disabled";
    summary.error = `role disabled: ${resolution.reason}`;
    ctx.logger.warn?.(
      `[role] ${opts.role} disabled — ${resolution.reason} (run refused)`,
    );
    return summary;
  }
  const contract = resolution.contract;
  for (const w of contract.warnings) {
    ctx.logger.warn?.(`[role] ${opts.role}: ${w}`);
  }
  const args = { ...opts, contract };
  return contract.batching.strategy === "bounded-full-store-chunked"
    ? executeRunNight(ctx, args)
    : executeRunDay(ctx, args);
}
