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
