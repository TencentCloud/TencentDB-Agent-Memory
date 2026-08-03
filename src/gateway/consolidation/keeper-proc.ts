/**
 * Keeper /proc helpers (pid-reuse-guard, group walk) + process-group kill.
 *
 * Kill policy (§5.1):
 *   - process-group kill via `kill -KILL -- -<pgid>` (kill(1) negative PID =
 *     process group), NOT process.kill(-pid) — bun throws ERR_OUT_OF_RANGE
 *     (oven-sh/bun#15791);
 *   - pid-reuse-guard: before the group kill, /proc/<pid>/stat must still
 *     report pgrp == pgid (otherwise the PID was reused — never kill a
 *     stranger's group);
 *   - assert pgid == pid post-spawn (bun detached → setsid; on failure fall
 *     back to single-pid kill + sweep);
 *   - descendant snapshot taken WHILE the keeper is alive, BEFORE the kill
 *     (a post-kill walk is empty — children reparent on exit).
 */
import fs from "node:fs";
import { execFileSync, type ChildProcess } from "node:child_process";
import type { Logger } from "../../core/types.js";

/** Keeper env markers (defined here so keeper-sweep/keeper-run import from
 * keeper-proc, NOT back into child-spawn which re-exports them). */
export const ENV_KEEPER = "PI_MEMORY_KEEPER";
export const ENV_RUN = "PI_MEMORY_KEEPER_RUN";
export const ENV_OWNER = "PI_MEMORY_KEEPER_OWNER";
export const ENV_GATEWAY_URL = "TDAI_GATEWAY_URL";

/**
 * Parse pgrp (field 5) from a /proc/<pid>/stat line. comm may contain spaces
 * and parentheses, so the field split starts after the LAST ')'.
 */
export function parsePgrpFromStat(statLine: string): number | null {
  const close = statLine.lastIndexOf(")");
  if (close < 0) return null;
  const fields = statLine
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // After comm: state(1) ppid(2) pgrp(3) ...
  const pgrp = Number(fields[2]);
  return Number.isFinite(pgrp) ? pgrp : null;
}

/** pgrp of a live pid via /proc/<pid>/stat; null when the pid is gone. */
export function readPgrpOf(pid: number): number | null {
  try {
    return parsePgrpFromStat(fs.readFileSync(`/proc/${pid}/stat`, "utf-8"));
  } catch {
    return null;
  }
}

/** All live pids whose process group == pgid (descendant snapshot). */
export function snapshotPgrp(pgid: number): number[] {
  const out: number[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pgrp = readPgrpOf(Number(entry));
    if (pgrp === pgid) out.push(Number(entry));
  }
  return out;
}

/** `kill -KILL -- -<pgid>` — process-group kill via kill(1), NOT
 * process.kill(-pid) (bun ERR_OUT_OF_RANGE, oven-sh/bun#15791). */
export function killProcessGroup(pgid: number): boolean {
  try {
    execFileSync("kill", ["-KILL", "--", `-${pgid}`], { stdio: "ignore" });
    return true;
  } catch {
    return false; // ESRCH etc. — group already gone
  }
}

export function killPid(pid: number): boolean {
  try {
    execFileSync("kill", ["-KILL", "--", String(pid)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface KillOutcome {
  killed: number;
  /** Pids that survived the group kill (post-kill walk). */
  survivors: number[];
  method:
    | "group-kill"
    | "single-pid"
    | "snapshot-fallback"
    | "pid-reuse-guard"
    | "already-exited"
    | "no-pid";
}

/**
 * Kill the keeper's whole process tree:
 *   1. read pgrp of child.pid; assert pgid == pid (setsid happened);
 *   2. pid-reuse-guard: re-read /proc/<pid> pgrp right before the kill;
 *   3. snapshot descendants WHILE the keeper is alive (pre-kill);
 *   4. `kill -KILL -- -<pgid>`;
 *   5. post-kill walk — SIGKILL any survivors individually.
 */
export function killChildGroup(
  child: ChildProcess,
  logger: Logger,
): KillOutcome {
  const pid = child.pid;
  if (!pid) return { killed: 0, survivors: [], method: "no-pid" };

  const pgid = readPgrpOf(pid);
  if (pgid === null)
    return { killed: 0, survivors: [], method: "already-exited" };

  if (pgid !== pid) {
    logger.warn?.(
      `[memory-keeper] child.pid=${pid} is not a group leader (pgid=${pgid}); falling back to single-pid kill + sweep`,
    );
    const ok = killPid(pid);
    return { killed: ok ? 1 : 0, survivors: [], method: "single-pid" };
  }

  const pgrpNow = readPgrpOf(pid);
  if (pgrpNow !== pgid) {
    logger.warn?.(
      `[memory-keeper] pid-reuse-guard: /proc/${pid} pgrp=${String(pgrpNow)} != pgid=${pgid}; skip group kill`,
    );
    return { killed: 0, survivors: [], method: "pid-reuse-guard" };
  }

  const descendants = snapshotPgrp(pgid);
  const ok = killProcessGroup(pgid);
  if (!ok) {
    // Group kill failed (ESRCH) — fall back to per-pid SIGKILL of the
    // pre-kill snapshot.
    let killed = 0;
    for (const p of descendants) if (killPid(p)) killed++;
    return { killed, survivors: [], method: "snapshot-fallback" };
  }

  const survivors = snapshotPgrp(pgid).filter((p) => p !== pid);
  for (const p of survivors) killPid(p);
  return { killed: descendants.length + 1, survivors, method: "group-kill" };
}
