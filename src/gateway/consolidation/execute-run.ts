/**
 * Contract-driven run entry (tz-01 B1/B2).
 *
 * One place resolves the role contract for a run and hands it to `runRole`,
 * which executes the batching strategy the contract NAMES. The role name is never compared against a
 * literal — that was `orchestrator.ts:143` and `handle-from-ctx.ts:29`.
 *
 * A role that does not resolve does not run: the summary comes back as
 * `disabled` carrying the reason (`fail-closed-role`).
 */
import { resolveRoleContract } from "./role-contract.js";
import { runRole } from "./run-role.js";
import { mkFailedSummary } from "./summary.js";
import { createRun } from "../control-plane/run-repo.js";
import { resolveCriticPackage } from "./critic-bootstrap.js";
import type { OrchestratorContext } from "./context.js";
import type { ResolvedRoleContract } from "./role-contract-types.js";
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

  // tz-09 Ф4a (criterion 6): an unusable critic stops the role BEFORE the
  // first LaunchAttempt — in enforce. In shadow it is logged only, so the
  // package can ship while no critic package exists yet.
  const critic = resolveCriticPackage(ctx, contract);
  if (!critic.ok) {
    if (ctx.applyGateMode === "enforce") {
      const startedAt = new Date(ctx.now()).toISOString();
      const summary = mkFailedSummary(
        opts.role,
        startedAt,
        opts.reason,
        opts.dryRun,
      );
      summary.status = "disabled";
      summary.error = `role disabled: ${critic.reason}`;
      ctx.logger.warn?.(
        `[role] ${opts.role} disabled — ${critic.reason} (no run started)`,
      );
      return summary;
    }
    ctx.logger.warn?.(`[critic] SHADOW ${opts.role}: ${critic.reason}`);
  }
  // tz-09 Ф1: the Run row is created HERE — the one place that already holds
  // both the run id and the RESOLVED contract, so the contract snapshot is
  // pinned before anything can be spawned. A role that failed to resolve
  // (above) never gets a Run: it never runs.
  openRunRecord(ctx, opts, contract);
  return runRole(ctx, { ...opts, contract });
}

/** `policy.opsSubset` is a Set, and a plain JSON.stringify turns a Set into
 * `{}` — the snapshot would silently lose the very policy Ф6 reads back from
 * it. Sets become arrays here, once. */
function serializeContract(contract: ResolvedRoleContract): string {
  return JSON.stringify(contract, (_key, value: unknown) =>
    value instanceof Set ? [...value] : value,
  );
}

function openRunRecord(
  ctx: OrchestratorContext,
  opts: ExecuteRunOpts,
  contract: ResolvedRoleContract,
): void {
  if (opts.dryRun) return;
  try {
    createRun(
      ctx.dataDir,
      {
        runId: opts.runId,
        roleId: opts.role,
        contractHash: contract.contractHash,
        contractJson: serializeContract(contract),
        binding: JSON.stringify(contract.binding),
        scratchPath: contract.assets.scratchRoot ?? ctx.scratchRoot,
        reason: opts.reason,
      },
      new Date(ctx.now()).toISOString(),
    );
  } catch (err) {
    // The control plane is diagnostics + protocol state, not the run itself:
    // a broken db must not stop consolidation before the gates depend on it
    // (Ф6 flips that — a run without a record then cannot apply).
    ctx.logger.warn?.(
      `[run] control-plane record failed for ${opts.role}/${opts.runId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
