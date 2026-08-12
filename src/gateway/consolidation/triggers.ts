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
import { taggedLogger, runTag } from "../../utils/logger-tag.js";
import { resolveRoleDir } from "../role-files.js";
import { recoverOrphanRuns } from "../control-plane/recover.js";
import { runOwnerId } from "../control-plane/owner.js";
import { sweepKeeperOrphans } from "./child-spawn.js";
import { busySummary } from "./busy-summary.js";
import { acquireRoleLock } from "./role-lock.js";
import { resolveRoleContract } from "./role-contract.js";
import type { RoleGate } from "./role-gate.js";
import type { RoleLegacyDefaults } from "./role-contract-types.js";
import type {
  ChildHandle,
  OrchestratorOptions,
  RunSummary,
  TriggerResult,
} from "./types.js";

/** How long shutdown waits for one child's cancel to reap before moving on. */
const SHUTDOWN_CANCEL_MS = 5_000;

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
  children: { value: Map<string, ChildHandle> };
  lastRunRef: { value: RunSummary | null };
  gate: RoleGate;
  /** Legacy snapshot for the contract resolver (lock ttl = maxRunMs). */
  roleDefaults: RoleLegacyDefaults;
  executeRun: (opts: {
    reason: string;
    dryRun?: boolean;
    runId: string;
    role: string;
  }) => Promise<RunSummary>;
  readLastReport: () => Promise<RunSummary | null>;
  checkpoint: { read: () => Promise<unknown>; file: string };
}

/**
 * Both halves of `single-writer-per-role`: the in-process gate (fast refusal
 * inside this gateway) and the cross-process file lock (another process on
 * the same dataDir). Either one refusing means busy. Returns a combined,
 * idempotent release.
 *
 * The lock ttl is the role's own `maxRunMs`, so a live run can never expire
 * under itself. A role that does not resolve takes the gate only — the run
 * is refused downstream with the reason (`fail-closed-role`).
 */
function acquireRole(self: TriggerHandle, role: string): (() => void) | null {
  const releaseGate = self.gate.tryAcquire(role);
  if (!releaseGate) return null;
  const resolution = resolveRoleContract(role, self.roleDir, self.roleDefaults);
  if (!resolution.ok) return releaseGate;
  let releaseFile: (() => void) | null = null;
  try {
    const lock = acquireRoleLock(self.dataDir, role, {
      ttlMs: resolution.contract.policy.maxRunMs,
      nowMs: self.now(),
    });
    if (lock === null) {
      releaseGate();
      self.logger.info?.(
        `[trigger] role=${role} held by another process — refused`,
      );
      return null;
    }
    releaseFile = lock.release;
    // A run slower than one ttl must not have its lock expire underneath it:
    // renewal is what keeps "stale" meaning "the owner is gone" rather than
    // "the owner is slow" (Codex major #9).
    const ttl = resolution.contract.policy.maxRunMs;
    const beat = setInterval(
      () => {
        if (!lock.renew(self.now())) clearInterval(beat);
      },
      Math.max(1_000, Math.floor(ttl / 3)),
    );
    beat.unref?.();
    const stopBeat = (): void => clearInterval(beat);
    const releaseLock = lock.release;
    releaseFile = () => {
      stopBeat();
      releaseLock();
    };
  } catch (err) {
    // Unusable lock dir: degrade to in-process locking, never crash.
    self.logger.warn?.(
      `[trigger] cross-process lock unavailable for ${role} (${err instanceof Error ? err.message : String(err)}) — in-process gate only`,
    );
  }
  return () => {
    releaseFile?.();
    releaseGate();
  };
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
  const release = acquireRole(self, role);
  if (!release) {
    self.logger.debug?.(`[trigger] busy role=${role} reason=${opts.reason}`);
    return { accepted: false, status: "busy", reason: opts.reason };
  }
  const runId = randomUUID();
  // Tagged like every other line of this run: the trigger is the only record
  // of WHY it started, and the cleanup line the only record that it let go.
  const log = taggedLogger(self.logger, runTag(runId));
  log.debug?.(`[trigger] start role=${role} reason=${opts.reason}`);
  self.activeRunUuid.value.add(runId);
  // Never reject: run failures are recorded in the report + lastRun.
  void self
    .executeRun({ ...opts, runId, role })
    .finally(() => {
      self.activeRunUuid.value.delete(runId);
      self.children.value.delete(runId);
      log.debug?.("[trigger] cleanup");
      release();
    })
    .catch((err: unknown) => {
      log.error?.(
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
  const release = acquireRole(self, role);
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
  // tz-09 Ф2: the process-level sweep above kills orphan CHILDREN; this one
  // settles the RUNS they belonged to. Taking a run over bumps its fence, so
  // an artefact from the previous process is refused at ingestion; a run
  // caught mid-apply is parked for reconciliation instead.
  try {
    const recovered = recoverOrphanRuns(
      self.dataDir,
      runOwnerId(self.ownerPid),
      { nowMs: self.now(), ttlMs: 60_000 },
    );
    for (const r of recovered) {
      self.logger.warn?.(
        `[run] recovered ${r.runId}: ${r.from} → ${r.to} fence=${r.fence}` +
          (r.reason === undefined ? "" : ` (${r.reason})`),
      );
    }
  } catch (err) {
    self.logger.warn?.(
      `[run] orphan-run recovery failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  self.lastRunRef.value = await self.readLastReport();
}

/** Kill ALL in-flight child groups + sweep leftovers (gateway shutdown). */
export async function stop(self: TriggerHandle): Promise<void> {
  for (const handle of self.children.value.values()) {
    try {
      // The launcher's own cancel path when it exists: it marks the attempt
      // `cancelled` and waits for the reap, where a bare kill leaves the run
      // to be classified as a failure it did not have. Bounded, because a
      // shutdown that waits forever on one unreapable child is worse than a
      // shutdown that gives up on its terminal status.
      if (handle.cancelAndWait !== undefined) {
        await Promise.race([
          handle.cancelAndWait(),
          new Promise((r) => setTimeout(r, SHUTDOWN_CANCEL_MS)),
        ]);
      } else handle.kill();
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
