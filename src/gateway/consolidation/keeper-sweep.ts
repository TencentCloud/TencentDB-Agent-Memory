/**
 * Keeper orphan sweep (§5.1).
 *
 * Matches the per-run marker PI_MEMORY_KEEPER_RUN=<uuid> with predicate
 * uuid ∉ active-set — a static PI_MEMORY_KEEPER=1 sweep during a live run
 * would kill the keeper's own children (TOCTOU). Marker is inherited by the
 * child's subagents; the cmdline fallback (RUN-uuid as an argument) covers
 * env sanitization.
 */
import fs from "node:fs";
import { ENV_KEEPER, ENV_RUN, ENV_OWNER, killPid } from "./keeper-proc.js";
import type { Logger } from "../../core/types.js";

export interface OrphanCandidate {
  pid: number;
  /** RUN-uuid from environ; null when only the cmdline fallback matched. */
  runUuid: string | null;
  /** Orchestrator pid that spawned this keeper (PI_MEMORY_KEEPER_OWNER);
   * null when the env marker is absent (pre-owner builds / cmdline fallback). */
  ownerPid: number | null;
  source: "environ" | "cmdline";
}

/**
 * Scan live processes for the keeper marker. Primary: /proc/<pid>/environ
 * (marker is inherited by the child's subagents — equivalent to the documented
 * `pgrep --env PI_MEMORY_KEEPER_RUN=<uuid>`). Fallback: RUN-uuid in cmdline
 * (covers environments that sanitize env for subagents).
 */
export function scanKeeperProcesses(): OrphanCandidate[] {
  const out: OrphanCandidate[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const envRaw = fs.readFileSync(`/proc/${pid}/environ`, "utf-8");
      const envs = envRaw.split("\0");
      if (!envs.includes(`${ENV_KEEPER}=1`)) continue;
      const run = envs.find((s) => s.startsWith(`${ENV_RUN}=`));
      const owner = envs.find((s) => s.startsWith(`${ENV_OWNER}=`));
      out.push({
        pid,
        runUuid: run ? run.slice(ENV_RUN.length + 1) : null,
        ownerPid: owner ? Number(owner.slice(ENV_OWNER.length + 1)) : null,
        source: "environ",
      });
    } catch {
      // environ unreadable (zombie/racer) — cmdline fallback.
      try {
        const cmd = fs
          .readFileSync(`/proc/${pid}/cmdline`, "utf-8")
          .replace(/\0/g, " ");
        if (cmd.includes(ENV_RUN))
          out.push({ pid, runUuid: null, ownerPid: null, source: "cmdline" });
      } catch {
        // Gone — skip.
      }
    }
  }
  return out;
}

/** True when the given pid is a live process (owner-orchestrator guard). */
export function isAlivePid(pid: number | null): boolean {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    fs.statSync(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill stale keeper processes. Predicate: RUN-uuid ∉ active-set (a live run's
 * uuid protects the keeper AND its marker-inheriting children — iter-13
 * regression). With no active set (or an empty one), every marker-carrying
 * process is an orphan.
 *
 * Owner guard (per-role parallel orchestrators): candidates whose
 * PI_MEMORY_KEEPER_OWNER names a LIVE foreign process are NOT orphans — they
 * belong to another running orchestrator (e.g. the gateway + a smoke harness
 * on the same host). Only sweep them when the owner pid is dead (crashed) or
 * absent (pre-owner builds). A null `myOwnerPid` (caller did not opt in)
 * preserves legacy sweep-all behavior.
 */
export function sweepKeeperOrphans(
  activeRunUuids: ReadonlySet<string> | null,
  logger: Logger,
  myOwnerPid: number | null = null,
): number {
  const candidates = scanKeeperProcesses();
  logger.debug?.(`[keeper] orphan sweep: ${candidates.length} candidate(s), ${activeRunUuids?.size ?? 0} active run(s)`);
  let killed = 0;
  for (const c of candidates) {
    if (activeRunUuids !== null && activeRunUuids.size > 0) {
      if (c.runUuid !== null && activeRunUuids.has(c.runUuid)) continue; // live keeper — keep
      if (c.runUuid === null) continue; // cannot distinguish — keep
    }
    // Owner guard: a live foreign owner is a parallel orchestrator's child.
    if (
      myOwnerPid !== null &&
      c.ownerPid !== null &&
      c.ownerPid !== myOwnerPid &&
      isAlivePid(c.ownerPid)
    ) {
      continue;
    }
    if (killPid(c.pid)) killed++;
  }
  if (killed > 0) {
    logger.warn?.(
      `[memory-keeper] orphan sweep killed ${killed} stale keeper process(es)`,
    );
  }
  return killed;
}
