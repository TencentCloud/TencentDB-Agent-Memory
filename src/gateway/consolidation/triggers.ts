/**
 * Public lifecycle API for the consolidation orchestrator (P6).
 *
 * trigger: fire-and-forget, returns immediately with 202-style result.
 * runNow: awaitable, single-flight enforced. Used by tests + internal reuse.
 * start: restore checkpoint + orphan sweep (no active run → all orphans die).
 * stop: kill the in-flight child group + sweep leftovers (gateway shutdown).
 *
 * busySummary: returned when the single-flight gate refuses.
 *
 * The actual run pipeline (executeRun / runBatch) lives in runner.ts.
 */

import { randomUUID } from "node:crypto";
import { resolveRoleDir } from "../role-files.js";
import { sweepKeeperOrphans } from "./child-spawn.js";
import { busySummary } from "./busy-summary.js";
import type { RoleGate } from "./role-gate.js";
import type {
  OrchestratorOptions,
  RunSummary,
  TriggerResult,
} from "./types.js";

/** Orchestrator handle (just the lifecycle methods). The full class lives
 * in orchestrator.ts; this file holds the dispatchable triggers so the
 * runner can be swapped without touching the class. */
export interface TriggerHandle {
  roleName: string;
  roleDir: string;
  now: () => number;
  /** Consolidation master switch (no config read on the role path). */
  enabled: boolean;
  dataDir: string;
  scratchRoot: string;
  logger: OrchestratorOptions["logger"];
  ownerPid: number;
  activeRunUuid: { value: Set<string> };
  children: { value: Map<string, { kill: () => unknown }> };
  lastRunRef: { value: RunSummary | null };
  gate: RoleGate;
  executeRun: (opts: {
    reason: string;
    dryRun?: boolean;
    runId: string;
    role: string;
  }) => Promise<RunSummary>;
  readLastReport: () => Promise<RunSummary | null>;
  checkpoint: { read: () => Promise<unknown>; file: string };
}

/** Manual/scheduled trigger. Fire-and-forget. */
export async function trigger(
  self: TriggerHandle,
  opts: { reason: string; dryRun?: boolean; runType?: string },
): Promise<TriggerResult> {
  if (!self.enabled) {
    return { accepted: false, status: "disabled", reason: opts.reason };
  }
  const role = opts.runType ?? self.roleName;
  const release = self.gate.tryAcquire(role);
  if (!release) {
    self.logger.debug?.(`[trigger] busy role=${role} reason=${opts.reason}`);
    return { accepted: false, status: "busy", reason: opts.reason };
  }
  const runId = randomUUID();
  self.logger.debug?.(`[trigger] start role=${role} runId=${runId} reason=${opts.reason}`);
  self.activeRunUuid.value.add(runId);
  // Never reject: run failures are recorded in the report + lastRun.
  void self
    .executeRun({ ...opts, runId, role })
    .finally(() => {
      self.activeRunUuid.value.delete(runId);
      self.children.value.delete(runId);
      self.logger.debug?.(`[trigger] cleanup runId=${runId}`);
      release();
    })
    .catch((err: unknown) => {
      self.logger.error?.(
        `[memory-keeper] unexpected run error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  return { accepted: true, status: "started", runId, reason: opts.reason };
}

/** Awaitable run (tests + internal reuse). Single-flight enforced too. */
export async function runNow(
  self: TriggerHandle,
  opts: { reason: string; dryRun?: boolean; runType?: string },
): Promise<RunSummary> {
  const role = opts.runType ?? self.roleName;
  const release = self.gate.tryAcquire(role);
  if (!release)
    return busySummary(self.now, self.roleName, {
      ...opts,
      runType: role,
    });
  const runId = randomUUID();
  self.activeRunUuid.value.add(runId);
  try {
    return await self.executeRun({
      ...opts,
      runId,
      role,
    });
  } finally {
    self.activeRunUuid.value.delete(runId);
    self.children.value.delete(runId);
    release();
  }
}

/** Restore checkpoint + orphan sweep. */
export async function start(self: TriggerHandle): Promise<void> {
  await self.checkpoint.read();
  sweepKeeperOrphans(null, self.logger, self.ownerPid);
  self.lastRunRef.value = await self.readLastReport();
}

/** Kill ALL in-flight child groups + sweep leftovers (gateway shutdown). */
export async function stop(self: TriggerHandle): Promise<void> {
  for (const handle of self.children.value.values()) {
    try {
      handle.kill();
    } catch (err) {
      self.logger.warn?.(
        `[memory-keeper] kill on shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  self.children.value.clear();
  // Empty active set (no live runs) → treat as null: sweep everything.
  sweepKeeperOrphans(
    self.activeRunUuid.value.size > 0 ? self.activeRunUuid.value : null,
    self.logger,
    self.ownerPid,
  );
}

/** Default roleDir when not set in OrchestratorOptions. */
export { resolveRoleDir as defaultRoleDir };
