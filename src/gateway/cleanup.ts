/**
 * Workspace cleanup (wave tdai-memory-subagents-2026-08-02, P11a, ТЗ §5.10).
 *
 * Deletes only run artifacts of the memory pipeline — NEVER memory data:
 *   - configured dataDir-relative paths (`memory.cleanup.paths`, default
 *     `["logs"]` — logs/diff sidecars/reports) by age (maxAge = intervalHours);
 *   - `dataDir/.backup` (apply-*.bak) by age;
 *   - stale run scratch dirs under scratchRoot (the P6 orchestrator removes
 *     its own run dir in `finally`; this catches crash leftovers) by age;
 *   - the deterministic tasks subtree `~/.pi/agent/tasks/--<sanitized-cwd>--/`
 *     derived from the scratch cwd (SKILL.md:29 hardcodes that path from the
 *     sub-session's cwd = scratch; if the P9 task-simple prompt-override fails,
 *     cleanup removes the droppings post-factum) — exact derived path plus a
 *     marker sweep for dir names containing the scratch marker.
 *
 * Safety:
 *   - records/, vectors.db, scene_blocks/, persona.md are NEVER touched: config
 *     paths are dataDir-relative and sanitized (reject .. / absolute), scratch
 *     cleanup is bounded to scratchRoot, the tasks subtree is derived from the
 *     tasks dir itself.
 *   - write-free module (only fs.rm / readdir / stat) — no file-writing calls,
 *     so it never enters the nogo-records-rewrite allowlist.
 */

import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../core/types.js";

// ============================
// Scratch-cwd sanitizer (SKILL.md:29 task-path derivation)
// ============================

/**
 * Sanitize a RELATIVE cwd into the token used by `~/.pi/agent/tasks/--<token>--/`
 * (task-simple SKILL.md:29 derives it from the child's cwd). REJECTS absolute
 * paths, `~` and `..` traversal — the derived tasks path must never escape
 * `~/.pi/agent/tasks/`. Slashes become dashes; every other non [A-Za-z0-9_-]
 * char becomes a dash. Returns null on any rejected input (caller skips).
 */
export function sanitizeCwdToken(raw: string): string | null {
  if (!raw) return null;
  if (raw.startsWith("/") || raw.startsWith("~")) return null;
  if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) return null;
  if (/^\.\.?$/.test(raw)) return null;
  const segments = raw.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  return segments.map((s) => s.replace(/[^A-Za-z0-9_-]/g, "-")).join("-");
}

/**
 * Sanitize an ABSOLUTE cwd into the tasks-dir token, mirroring pi's observable
 * behavior (`/home/penis` → `home-penis`, `/home/penis/projects/x` →
 * `home-penis-projects-x`): strip the leading slash, split on separators,
 * replace every non [A-Za-z0-9_-] char with a dash. Used for the deterministic
 * subtree derivation where the cwd is the gateway-constructed absolute scratch
 * path (trusted input — unlike the reject-absolute contract above).
 */
export function sanitizeAbsoluteCwdToken(raw: string): string | null {
  if (!raw) return null;
  const segments = raw
    .replace(/^[/\\]+/, "")
    .split(/[\\/]+/)
    .filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  return segments.map((s) => s.replace(/[^A-Za-z0-9_-]/g, "-")).join("-");
}

/**
 * Deterministic tasks subtree for a scratch cwd:
 * `~/.pi/agent/tasks/--<sanitized-cwd>--/` (SKILL.md:29 hardcodes that path
 * from the sub-session's cwd). The cwd is the absolute scratch path the
 * gateway constructed — sanitized the same way pi does — and the output always
 * lands under `~/.pi/agent/tasks/`.
 */
export function tasksSubtreeForScratch(opts: {
  home: string;
  cwd: string;
}): string | null {
  const token = sanitizeAbsoluteCwdToken(path.resolve(opts.cwd));
  if (!token) return null;
  return path.join(opts.home, ".pi", "agent", "tasks", `--${token}--`);
}

/** All `--<name>--` dirs under ~/.pi/agent/tasks/. */
export function listTaskSubtrees(home: string): string[] {
  const tasksRoot = path.join(home, ".pi", "agent", "tasks");
  let entries: string[];
  try {
    entries = fs.readdirSync(tasksRoot);
  } catch {
    return [];
  }
  return entries
    .filter((e) => /^--.*--$/.test(e))
    .map((e) => path.join(tasksRoot, e))
    .filter((p) => fs.existsSync(p) && fs.statSync(p).isDirectory());
}

// ============================
// Cleanup
// ============================

export interface CleanupDeps {
  /** Gateway memory data dir. */
  dataDir: string;
  /** Scratch root OUTSIDE the memory tree (sibling of dataDir). */
  scratchRoot: string;
  /**
   * Extra roots a role brought with it (`runtime.scratch_root`), tz-02 Ф5.
   * Without them a role with its own root is never swept: `keep_scratch` makes
   * attempt dirs survive the run, and the only thing that deletes them after
   * that is this pass.
   */
  extraScratchRoots?: readonly string[];
  home: string;
  /** Parsed memory.cleanup config. */
  config: { enabled: boolean; intervalHours: number; paths: string[] };
  /** Injectable clock (tests use a fixed one). */
  now: () => number;
  logger: Logger;
}

export interface CleanupStats {
  removedFiles: number;
  removedDirs: number;
  errors: string[];
  scanned: string[];
}

/**
 * Age threshold: artifacts older than one interval are removed (a 24h cleanup
 * keeps the current cycle's logs/diffs and clears everything older).
 */
export function maxAgeMsFor(config: { intervalHours: number }): number {
  return Math.max(1, config.intervalHours) * 3_600_000;
}

/** True when `mtimeMs` is older than `nowMs - maxAgeMs`. */
function isStale(mtimeMs: number, nowMs: number, maxAgeMs: number): boolean {
  return nowMs - mtimeMs > maxAgeMs;
}

/**
 * One cleanup pass. Never throws — errors are collected into `stats.errors`
 * (fail-open; the timer must not crash the gateway over a cleanup hiccup).
 */
export function runCleanup(deps: CleanupDeps): CleanupStats {
  const stats: CleanupStats = {
    removedFiles: 0,
    removedDirs: 0,
    errors: [],
    scanned: [],
  };
  if (!deps.config.enabled) return stats;
  const nowMs = deps.now();
  const maxAge = maxAgeMsFor(deps.config);

  // 1. Configured dataDir-relative paths (sanitized: reject .. / absolute).
  for (const rel of deps.config.paths) {
    const resolved = resolveDataDirRelative(deps.dataDir, rel);
    if (!resolved) {
      stats.errors.push(
        `cleanup: configured path "${rel}" rejected (not dataDir-relative)`,
      );
      continue;
    }
    stats.scanned.push(resolved);
    ageCleanDir(resolved, nowMs, maxAge, stats);
  }

  // 2. dataDir/.backup — apply-*.bak files (P4) by age.
  const backupDir = path.join(deps.dataDir, ".backup");
  stats.scanned.push(backupDir);
  ageCleanDir(backupDir, nowMs, maxAge, stats);

  // 3. Stale run scratch dirs by age, in EVERY root a run could have used.
  const roots = [
    ...new Set([deps.scratchRoot, ...(deps.extraScratchRoots ?? [])]),
  ];
  for (const root of roots) {
    stats.scanned.push(root);
    ageCleanDir(root, nowMs, maxAge, stats);
  }

  // 4. Tasks subtrees derived from scratch dirs (exact) + marker sweep.
  const scratchRoots: string[] = [...roots];
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root)) {
        scratchRoots.push(path.join(root, entry));
      }
    } catch {
      // root missing — nothing to derive.
    }
  }
  const exactSubtrees = new Set<string>();
  for (const cwd of scratchRoots) {
    const subtree = tasksSubtreeForScratch({ home: deps.home, cwd });
    if (subtree) exactSubtrees.add(subtree);
  }
  // Marker sweep: dirs whose name contains the scratch marker (covers a
  // sanitizer mismatch between this module and pi's internal one).
  const markers = roots.map((r) =>
    path.basename(r).replace(/[^A-Za-z0-9_-]/g, "-"),
  );
  const targets = new Set<string>(exactSubtrees);
  for (const p of listTaskSubtrees(deps.home)) {
    if (markers.some((m) => path.basename(p).includes(m))) targets.add(p);
  }
  for (const target of targets) {
    stats.scanned.push(target);
    removeDirTree(target, stats);
  }

  if (stats.removedFiles > 0 || stats.removedDirs > 0) {
    deps.logger.info?.(
      `[memory-cleanup] removed ${stats.removedFiles} file(s), ${stats.removedDirs} dir(s)` +
        (stats.errors.length > 0 ? `; errors: ${stats.errors.length}` : ""),
    );
  }
  return stats;
}

/**
 * Resolve a configured cleanup path relative to dataDir. Rejects absolute
 * paths, `..` escapes, and the protected memory paths (records / vectors.db /
 * scene_blocks / persona.md) — cleanup must never touch memory data.
 */
function resolveDataDirRelative(dataDir: string, rel: string): string | null {
  if (!rel || rel.startsWith("/") || rel.startsWith("~") || rel.includes(".."))
    return null;
  const dataRoot = path.resolve(dataDir);
  const resolved = path.resolve(dataRoot, rel);
  // Root sweep guard: a path resolving to dataDir itself ('.', './', the
  // dataDir basename) would age-sweep EVERYTHING including records/*.jsonl
  // and vectors.db — always reject, never treat the root as a sweep target.
  if (resolved === dataRoot) return null;
  if (!resolved.startsWith(dataRoot + path.sep)) return null;
  const base = path.basename(resolved);
  if (
    base === "records" ||
    base === "vectors.db" ||
    base === "scene_blocks" ||
    base === "persona.md"
  ) {
    return null;
  }
  return resolved;
}

/** Remove entries (files + dirs) under `dir` older than maxAge. */
function ageCleanDir(
  dir: string,
  nowMs: number,
  maxAge: number,
  stats: CleanupStats,
): void {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing/unreadable — nothing to clean
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(full);
      if (isStale(stat.mtimeMs, nowMs, maxAge)) {
        if (entry.isDirectory()) {
          removeDirTree(full, stats);
        } else {
          fs.rmSync(full, { force: true });
          stats.removedFiles++;
        }
      }
    } catch (err) {
      stats.errors.push(
        `cleanup stat/remove failed for ${full}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Remove a directory tree (recursive). Failure → collected, not thrown. */
function removeDirTree(dir: string, stats: CleanupStats): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    stats.removedDirs++;
  } catch (err) {
    stats.errors.push(
      `cleanup rm failed for ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ============================
// CleanupTimer (interval from memory.cleanup.intervalHours)
// ============================

export interface CleanupTimerDeps {
  enabled: boolean;
  /** Cleanup interval in hours. */
  intervalHours: number;
  run: () => CleanupStats | Promise<CleanupStats>;
  /** Injectable clock. */
  now: () => number;
  logger: Logger;
}

/**
 * Periodic cleanup inside the gateway (no cron unit), same pattern as
 * NightRunTimer (P7): immediate first run + setInterval(intervalHours),
 * no-op when disabled, unref'd so it never keeps the process alive.
 */
export class CleanupTimer {
  private readonly deps: CleanupTimerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: CleanupTimerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (!this.deps.enabled || this.timer) return;
    void this.tick();
    const intervalMs = Math.max(1, this.deps.intervalHours) * 3_600_000;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  private async tick(): Promise<void> {
    if (this.running) return; // no overlapping passes
    this.running = true;
    try {
      await this.deps.run();
    } catch (err) {
      this.deps.logger.warn?.(
        `[memory-cleanup] pass failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
