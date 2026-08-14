import type { Logger } from "../core/types.js";
import { RoleGate } from "../gateway/consolidation/role-gate.js";
import { acquireRoleLock } from "../gateway/consolidation/role-lock.js";

export interface RoleExecutionLease {
  readonly roleKey: string;
  readonly isLive: () => boolean;
  readonly release: () => void;
}

/** Shared single-flight lifecycle for every role protocol. */
export function acquireRoleExecutionLease(input: {
  dataDir: string;
  roleKey: string;
  ttlMs: number | null;
  gate: RoleGate;
  logger: Logger;
  nowMs: number;
  now?: () => number;
}): RoleExecutionLease | null {
  const releaseGate = input.gate.tryAcquire(input.roleKey);
  if (releaseGate === null) return null;
  let isLive = true;
  let isReleased = false;
  let releaseFile: (() => void) | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;
  try {
    if (input.ttlMs !== null) {
      const lock = acquireRoleLock(input.dataDir, input.roleKey, {
        ttlMs: input.ttlMs,
        nowMs: input.nowMs,
      });
      if (lock === null) {
        releaseGate();
        return null;
      }
      releaseFile = lock.release;
      beat = setInterval(
        () => {
          if (!lock.renew((input.now ?? Date.now)())) {
            isLive = false;
            if (beat !== null) clearInterval(beat);
          }
        },
        Math.max(1_000, Math.floor(input.ttlMs / 3)),
      );
      beat.unref?.();
    }
  } catch (error) {
    input.logger.warn?.(
      `[role-runtime] file lock unavailable for ${input.roleKey}: ${error instanceof Error ? error.message : String(error)}`,
    );
    releaseGate();
    return null;
  }
  return {
    roleKey: input.roleKey,
    isLive: () => isLive,
    release: () => {
      if (isReleased) return;
      isReleased = true;
      isLive = false;
      if (beat !== null) clearInterval(beat);
      releaseFile?.();
      releaseGate();
    },
  };
}

export function assertLiveRoleLease(lease: RoleExecutionLease): void {
  if (!lease.isLive()) throw new Error(`role lease expired: ${lease.roleKey}`);
}
