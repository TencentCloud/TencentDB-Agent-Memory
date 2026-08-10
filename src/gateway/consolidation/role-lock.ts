/**
 * Cross-process per-role lock (tz-01 criterion 5, `single-writer-per-role`).
 *
 * The in-process RoleGate only guards ONE gateway process; two processes on
 * the same dataDir (a restarted gateway, a CLI run, a smoke script) could
 * both start the same role. This lock is the process-independent half: an
 * exclusively created file under `<dataDir>/.metadata/locks/<role>.lock`.
 *
 * Takeover of an existing lock is deliberately narrow:
 *   - its `expiresAt` is in the past (ttl = the role's maxRunMs, so a live
 *     run can never expire under itself), OR
 *   - it belongs to THIS host and its pid is gone (`process.kill(pid, 0)` →
 *     ESRCH). The host check is not cosmetic: on a shared/network dataDir a
 *     foreign pid would collide with a local one and single-writer would
 *     break silently.
 * Anything else → busy (null).
 *
 * Degrades safely: if the lock dir cannot be used at all, the caller keeps
 * the previous in-process behaviour (the gateway must not die over it).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RoleLockInfo {
  pid: number;
  host: string;
  role: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface RoleLock {
  path: string;
  info: RoleLockInfo;
  /** Idempotent; removes the file only while it still holds OUR pid. */
  release: () => void;
}

export function roleLockPath(dataDir: string, role: string): string {
  return path.join(dataDir, ".metadata", "locks", `${role}.lock`);
}

function readLock(file: string): RoleLockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as RoleLockInfo;
    return typeof parsed?.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = alive but owned by another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when an existing lock may be taken over (stale ttl or dead local pid). */
function isStale(info: RoleLockInfo, nowMs: number): boolean {
  const expires = Date.parse(info.expiresAt);
  if (Number.isFinite(expires) && expires <= nowMs) return true;
  return info.host === os.hostname() && !pidAlive(info.pid);
}

function writeLock(file: string, info: RoleLockInfo): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info), "utf-8");
  fs.renameSync(tmp, file);
}

/**
 * Acquire the lock for `role`, or null when another live run holds it.
 * Throws only when the lock directory itself is unusable — the caller
 * decides whether that degrades to in-process-only locking.
 */
export function acquireRoleLock(
  dataDir: string,
  role: string,
  opts: { ttlMs: number; nowMs?: number },
): RoleLock | null {
  const nowMs = opts.nowMs ?? Date.now();
  const file = roleLockPath(dataDir, role);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const info: RoleLockInfo = {
    pid: process.pid,
    host: os.hostname(),
    role,
    acquiredAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + Math.max(1, opts.ttlMs)).toISOString(),
  };

  const mk = (): RoleLock => ({
    path: file,
    info,
    release: () => {
      const held = readLock(file);
      if (
        held !== null &&
        held.pid === process.pid &&
        held.host === info.host
      ) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // best-effort: a stale file is taken over by ttl anyway
        }
      }
    },
  });

  try {
    // "wx" is atomic on every POSIX filesystem — the exclusive create IS the
    // mutual exclusion; everything below only handles a leftover file.
    fs.closeSync(fs.openSync(file, "wx"));
    writeLock(file, info);
    return mk();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  const held = readLock(file);
  // An unparseable lock file is a leftover, not an owner.
  if (held !== null && !isStale(held, nowMs)) return null;
  writeLock(file, info);
  // Re-read: two processes may have raced through the takeover branch.
  const winner = readLock(file);
  if (winner === null || winner.pid !== process.pid) return null;
  return mk();
}
