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
import type {
  OrchestratorOptions,
  RunSummary,
  TriggerResult,
} from "./types.js";

/** Build the busy-summary that the gate returns when a run is in flight. */
export function busySummary(
  now: () => number,
  roleName: string,
  opts: { reason: string; dryRun?: boolean; runType?: string },
): RunSummary {
  const startedMs = now();
  return {
    role: opts.runType ?? roleName,
    status: "failed",
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: new Date(startedMs).toISOString(),
    elapsedMs: 0,
    reason: opts.reason,
    dryRun: !!opts.dryRun,
    newL0: 0,
    recordsPresented: 0,
    overLimitBlocks: 0,
    applied: { merges: [], deletes: [], rewrites: [] },
    skipped: { merges: [], deletes: [], rewrites: [] },
    error: "another consolidation run is in flight (single-flight)",
    reindexed: false,
    needsReindex: false,
  };
}

/** Orchestrator handle (just the lifecycle methods). The full class lives
 * in orchestrator.ts; this file holds the dispatchable triggers so the
 * runner can be swapped without touching the class. */
export interface TriggerHandle {
  roleName: string;
  roleDir: string;
  now: () => number;
  config: OrchestratorOptions["config"];
  dataDir: string;
  scratchRoot: string;
  logger: OrchestratorOptions["logger"];
  activeRunUuid: { value: string | null };
  currentChild: { value: { kill: () => unknown } | null };
  lastRunRef: { value: RunSummary | null };
  gate: { tryAcquire: () => (() => void) | null; isLocked: boolean };
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
  if (!self.config.memory.consolidation.enabled) {
    return { accepted: false, status: "disabled", reason: opts.reason };
  }
  const release = self.gate.tryAcquire();
  if (!release) {
    return { accepted: false, status: "busy", reason: opts.reason };
  }
  const runId = randomUUID();
  self.activeRunUuid.value = runId;
  // Never reject: run failures are recorded in the report + lastRun.
  void self
    .executeRun({ ...opts, runId, role: opts.runType ?? self.roleName })
    .finally(() => {
      self.activeRunUuid.value = null;
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
  const release = self.gate.tryAcquire();
  if (!release)
    return busySummary(self.now, self.roleName, {
      ...opts,
      runType: opts.runType ?? self.roleName,
    });
  const runId = randomUUID();
  self.activeRunUuid.value = runId;
  try {
    return await self.executeRun({
      ...opts,
      runId,
      role: opts.runType ?? self.roleName,
    });
  } finally {
    self.activeRunUuid.value = null;
    release();
  }
}

/** Restore checkpoint + orphan sweep. */
export async function start(self: TriggerHandle): Promise<void> {
  await self.checkpoint.read();
  sweepKeeperOrphans(null, self.logger);
  self.lastRunRef.value = await self.readLastReport();
}

/** Kill the in-flight child group + sweep leftovers (gateway shutdown). */
export async function stop(self: TriggerHandle): Promise<void> {
  if (self.currentChild.value) {
    try {
      self.currentChild.value.kill();
    } catch (err) {
      self.logger.warn?.(
        `[memory-keeper] kill on shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    self.currentChild.value = null;
  }
  sweepKeeperOrphans(self.activeRunUuid.value, self.logger);
}

/** Default roleDir when not set in OrchestratorOptions. */
export { resolveRoleDir as defaultRoleDir };
