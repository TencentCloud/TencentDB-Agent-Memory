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
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

export interface RoleLockInfo {
  /** Unique per acquisition: pid+host is NOT enough to identify the owner —
   * two sequential locks in one process share them, and the older handle
   * would then release the newer lock. */
  token: string;
  pid: number;
  host: string;
  role: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface RoleLock {
  path: string;
  info: RoleLockInfo;
  /** Idempotent; removes the file only while it still holds OUR token. */
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

/** How long one takeover attempt may hold the `.steal` gate. Takeover is a
 * few syscalls; anything older is a crashed taker-over. */
const STEAL_TTL_MS = 5_000;

/** True when an existing lock may be taken over (stale ttl or dead local pid). */
function isStale(info: RoleLockInfo, nowMs: number): boolean {
  const expires = Date.parse(info.expiresAt);
  if (Number.isFinite(expires) && expires <= nowMs) return true;
  return info.host === os.hostname() && !pidAlive(info.pid);
}

/** Write the payload to a private temp file and hard-link it into place.
 * `link()` fails with EEXIST when the target exists, so the LINK — not the
 * preceding write — is the mutual exclusion: there is no window in which the
 * lock file exists but is still empty. */
function linkLock(file: string, info: RoleLockInfo): boolean {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info), "utf-8");
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
}

export function acquireRoleLock(
  dataDir: string,
  role: string,
  opts: { ttlMs: number; nowMs?: number },
): RoleLock | null {
  const nowMs = opts.nowMs ?? Date.now();
  const file = roleLockPath(dataDir, role);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const info: RoleLockInfo = {
    token: randomUUID(),
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
      if (held !== null && held.token === info.token) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // best-effort: a stale file is taken over by ttl anyway
        }
      }
    },
  });

  if (linkLock(file, info)) return mk();

  const held = readLock(file);
  // An unparseable lock file is a leftover, not an owner.
  if (held !== null && !isStale(held, nowMs)) return null;

  // Takeover is itself a critical section: without it two processes reaping
  // the SAME stale lock both unlink and both link — the second unlink would
  // delete the first one's fresh lock. The `.steal` gate is taken with the
  // same exclusive link, so only one process ever reaps.
  const stealFile = `${file}.steal`;
  if (!linkLock(stealFile, info)) {
    reapStaleSteal(stealFile, nowMs);
    if (!linkLock(stealFile, info)) return null;
  }
  try {
    // Re-read under the gate: the previous reaper may already have handed the
    // lock to a live run.
    const stillHeld = readLock(file);
    if (stillHeld !== null && !isStale(stillHeld, nowMs)) return null;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // best-effort: the ttl still expires the stale lock
    }
    return linkLock(file, info) ? mk() : null;
  } finally {
    try {
      fs.rmSync(stealFile, { force: true });
    } catch {
      // best-effort: a leftover gate is reaped by STEAL_TTL_MS
    }
  }
}

/** Drop a `.steal` gate left behind by a crashed taker-over. */
function reapStaleSteal(stealFile: string, nowMs: number): void {
  const info = readLock(stealFile);
  const age = info === null ? Infinity : nowMs - Date.parse(info.acquiredAt);
  const deadLocally =
    info !== null && info.host === os.hostname() && !pidAlive(info.pid);
  if (info === null || deadLocally || !(age <= STEAL_TTL_MS)) {
    try {
      fs.rmSync(stealFile, { force: true });
    } catch {
      // best-effort
    }
  }
}
