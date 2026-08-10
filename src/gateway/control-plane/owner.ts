/**
 * Lease owner identity (tz-09 Ф2).
 *
 * Host AND pid: on a shared dataDir a bare pid from another machine would
 * collide with a local one and the lease would hand the same run to two
 * processes — the exact failure the per-role lock already guards against
 * (consolidation/role-lock.ts).
 */
import os from "node:os";

export function runOwnerId(pid: number): string {
  return `${os.hostname()}:${pid}`;
}

/**
 * True when the owner names a process on THIS host that no longer exists.
 *
 * The TTL alone cannot decide this: a crash five seconds into a run leaves a
 * lease valid for the whole role timeout (tens of minutes), so startup
 * recovery would be a silent no-op exactly in the ordinary
 * crash-and-restart-immediately case. Another host is unknowable from here —
 * there the TTL stays the only signal.
 */
export function ownerIsGone(owner: string | null): boolean {
  if (owner === null) return false;
  const sep = owner.lastIndexOf(":");
  if (sep < 0 || owner.slice(0, sep) !== os.hostname()) return false;
  const pid = Number(owner.slice(sep + 1));
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // EPERM means the process is alive but owned by someone else.
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}
