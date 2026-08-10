/**
 * Store-wide apply serialization (tz-09 Ф7, `single-apply-per-store`).
 *
 * The per-role lock (tz-01) keeps one role from running twice; it says
 * nothing about two DIFFERENT roles mutating the same store at once, and the
 * manifest baseline of the second one is then read while the first is halfway
 * through writing. So applies take one exclusive lock per dataDir — the same
 * hard-link lock, under the reserved role name `_store-apply`.
 *
 * Waiting, not failing: an apply that finds the store busy is not an error,
 * it is early. It polls until the holder is done and only refuses after the
 * timeout, which is a real deadlock signal rather than ordinary contention.
 */
import {
  acquireRoleLock,
  roleLockPath,
  type RoleLock,
} from "../consolidation/role-lock.js";
import { ApplyRuntimeError } from "./errors.js";

export const STORE_APPLY_LOCK = "_store-apply";

export interface StoreLockOpts {
  /** Hard ceiling on how long one apply may hold the store. */
  ttlMs?: number;
  /** How long to wait for the current holder before refusing. */
  waitMs?: number;
  pollMs?: number;
}

export function storeApplyLockPath(dataDir: string): string {
  return roleLockPath(dataDir, STORE_APPLY_LOCK);
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withStoreApplyLock<T>(
  dataDir: string,
  fn: () => Promise<T>,
  opts: StoreLockOpts = {},
): Promise<T> {
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const waitMs = opts.waitMs ?? 60_000;
  const pollMs = opts.pollMs ?? 25;
  const deadline = Date.now() + waitMs;

  let lock: RoleLock | null = null;
  for (;;) {
    lock = acquireRoleLock(dataDir, STORE_APPLY_LOCK, { ttlMs });
    if (lock !== null) break;
    if (Date.now() >= deadline) {
      throw new ApplyRuntimeError(
        `another apply holds the store lock (${storeApplyLockPath(dataDir)}) ` +
          `after ${waitMs}ms — refusing to mutate concurrently`,
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
