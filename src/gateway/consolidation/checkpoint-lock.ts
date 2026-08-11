/**
 * Cross-process serialization of the checkpoint's read-modify-write (tz-03a,
 * ТЗ A2b :76, критерий 3a :88).
 *
 * The in-process lock in checkpoint.ts is a module-level Map: two gateway
 * processes have two different maps, so both read their own snapshot and both
 * rename their own file over the other's. One of the two runs then simply
 * never happened. A2b allows either a control-plane transaction or a file
 * lock; the file lock already exists here as a hard link (role-lock.ts,
 * tz-01), which is mutual exclusion at the filesystem level rather than in
 * memory.
 *
 * It WAITS instead of refusing, like the store-apply lock: a finalization that
 * finds the checkpoint busy is early, not wrong. Refusal is reserved for the
 * timeout, which is a real deadlock signal.
 *
 * ponytail: the wait loop is copied from apply-executor/store-lock.ts rather
 * than parameterised out of it — ten lines against touching a file on the
 * apply path for a second client. Merge the two if a third one appears.
 */
import { acquireRoleLock, roleLockPath, type RoleLock } from "./role-lock.js";

export const CHECKPOINT_LOCK = "_checkpoint";

export function checkpointLockPath(dataDir: string): string {
  return roleLockPath(dataDir, CHECKPOINT_LOCK);
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface CheckpointLockOpts {
  /** Hard ceiling on how long one finalization may hold the checkpoint. */
  ttlMs?: number;
  /** How long to wait for the current holder before giving up. */
  waitMs?: number;
  pollMs?: number;
}

export async function withCheckpointLock<T>(
  dataDir: string,
  fn: () => Promise<T>,
  opts: CheckpointLockOpts = {},
): Promise<T> {
  const ttlMs = opts.ttlMs ?? 60_000;
  const waitMs = opts.waitMs ?? 30_000;
  const pollMs = opts.pollMs ?? 15;
  const deadline = Date.now() + waitMs;

  let lock: RoleLock | null = null;
  for (;;) {
    lock = acquireRoleLock(dataDir, CHECKPOINT_LOCK, { ttlMs });
    if (lock !== null) break;
    if (Date.now() >= deadline) {
      // Not a lost update — a refusal, loudly. Silently writing anyway is the
      // one outcome this lock exists to prevent.
      throw new Error(
        `checkpoint lock (${checkpointLockPath(dataDir)}) still held after ` +
          `${waitMs}ms — refusing to finalize concurrently`,
      );
    }
    await sleep(pollMs);
  }
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
