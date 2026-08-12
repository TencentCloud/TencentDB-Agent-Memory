/**
 * Memory-keeper child process management (wave tdai-memory-subagents-2026-08
 * -02, P6). Spawn + kill + orphan-sweep of the pi sub-session ("пчёлка").
 *
 * Spawn contract (ТЗ §5.1):
 *   spawn(pi, ["-p","--no-context-files","--no-session","--model",<model>,
 *              "--thinking",<level>,"--system-prompt",<sess-prompt>,<задание>],
 *         { cwd: <scratch-dir>, env: <whitelist>, stdio: pipe, detached: true })
 *   — WITHOUT --no-skills (the child needs skills/subagents for task-simple);
 *   cwd = scratch dir OUTSIDE the memory tree; stdout/stderr data listeners
 *   attach immediately (live pipe drain — a stalled >64KB pipe deadlocks the
 *   child); --thinking output lands on stderr (stdout = errors/report only).
 *
 * Env whitelist is EXPLICIT and exhaustive: PATH, HOME, PI_MEMORY_KEEPER=1,
 * PI_MEMORY_KEEPER_RUN=<uuid>, TDAI_GATEWAY_URL. Auth keys and the loopback
 * token are excluded by construction (INVARIANT nogo-secrets).
 *
 * Kill policy:
 *   - process-group kill via `kill -KILL -- -<pgid>` (kill(1) negative PID =
 *     process group), NOT process.kill(-pid) — bun throws ERR_OUT_OF_RANGE
 *     (oven-sh/bun#15791);
 *   - pid-reuse-guard: before the group kill, /proc/<pid>/stat must still
 *     report pgrp == pgid (otherwise the PID was reused — never kill a
 *     stranger's group);
 *   - assert pgid == pid post-spawn (bun detached → setsid; on failure fall
 *     back to single-pid kill + sweep);
 *   - descendant snapshot taken WHILE the keeper is alive, BEFORE the kill
 *     (a post-kill walk is empty — children reparent on exit);
 *   - gateway SIGTERM/exit handler kills the child group (orchestrator.stop);
 *   - orphan sweep (gateway start + auto-cleanup) matches the per-run marker
 *     PI_MEMORY_KEEPER_RUN=<uuid> with predicate uuid ≠ active-run — a static
 *     PI_MEMORY_KEEPER=1 sweep during a live run would kill the keeper's own
 *     children (TOCTOU). Marker is inherited by the child's subagents; the
 *     cmdline fallback (RUN-uuid as an argument) covers env sanitization.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";

export type { ChildProcess };
import fs from "node:fs";
import type { Logger } from "../../core/types.js";

export const ENV_KEEPER = "PI_MEMORY_KEEPER";
export const ENV_RUN = "PI_MEMORY_KEEPER_RUN";
export const ENV_GATEWAY_URL = "TDAI_GATEWAY_URL";

// ============================
// Env whitelist (§5.1)
// ============================

export interface ChildEnvDeps {
  home: string;
  pathValue: string;
  gatewayUrl: string;
  runUuid: string;
}

/**
 * Build the child environment — an EXPLICIT whitelist. Nothing else is copied
 * from process.env: auth keys, loopback token and provider secrets never reach
 * the sub-session (INVARIANT nogo-secrets). The provider key the child's model
 * needs is read by opencode-go itself from ~/.pi/agent/auth.json via HOME.
 */
export function buildChildEnv(deps: ChildEnvDeps): Record<string, string> {
  const env: Record<string, string> = {
    PATH: deps.pathValue,
    HOME: deps.home,
    [ENV_KEEPER]: "1",
    [ENV_RUN]: deps.runUuid,
    [ENV_GATEWAY_URL]: deps.gatewayUrl,
  };
  // Deliberately no other keys. Loopback token and apiKey are NOT here.
  return env;
}

// ============================
// Spawn (§5.1)
// ============================

export interface SpawnKeeperOptions {
  piBinary: string;
  /** Config spawnFlags — defaults ["-p","--no-context-files","--no-session"];
   * --model/--thinking/--system-prompt are appended by the orchestrator. */
  spawnFlags: string[];
  model: string;
  thinking: string;
  systemPromptPath: string;
  taskPrompt: string;
  cwd: string;
  env: Record<string, string>;
}

export function spawnKeeper(opts: SpawnKeeperOptions): ChildProcess {
  const args = [
    ...opts.spawnFlags,
    "--model",
    opts.model,
    "--thinking",
    opts.thinking,
    "--system-prompt",
    opts.systemPromptPath,
    opts.taskPrompt,
  ];
  return spawn(opts.piBinary, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}

// ============================
// /proc helpers (pid-reuse-guard, group walk)
// ============================

/**
 * Parse pgrp (field 5) from a /proc/<pid>/stat line. comm may contain spaces
 * and parentheses, so the field split starts after the LAST ')'.
 */
export function parsePgrpFromStat(statLine: string): number | null {
  const close = statLine.lastIndexOf(")");
  if (close < 0) return null;
  const fields = statLine.slice(close + 1).trim().split(/\s+/);
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

// ============================
// Kill (§5.1)
// ============================

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
  method: "group-kill" | "single-pid" | "snapshot-fallback" | "pid-reuse-guard" | "already-exited" | "no-pid";
}

/**
 * Kill the keeper's whole process tree:
 *   1. read pgrp of child.pid; assert pgid == pid (setsid happened);
 *   2. pid-reuse-guard: re-read /proc/<pid> pgrp right before the kill;
 *   3. snapshot descendants WHILE the keeper is alive (pre-kill);
 *   4. `kill -KILL -- -<pgid>`;
 *   5. post-kill walk — SIGKILL any survivors individually.
 */
export function killChildGroup(child: ChildProcess, logger: Logger): KillOutcome {
  const pid = child.pid;
  if (!pid) return { killed: 0, survivors: [], method: "no-pid" };

  const pgid = readPgrpOf(pid);
  if (pgid === null) return { killed: 0, survivors: [], method: "already-exited" };

  if (pgid !== pid) {
    logger.warn?.(
      `[memory-keeper] child.pid=${pid} is not a group leader (pgid=${pgid}); falling back to single-pid kill + sweep`,
    );
    const ok = killPid(pid);
    return { killed: ok ? 1 : 0, survivors: [], method: "single-pid" };
  }

  const pgrpNow = readPgrpOf(pid);
  if (pgrpNow !== pgid) {
    logger.warn?.(`[memory-keeper] pid-reuse-guard: /proc/${pid} pgrp=${String(pgrpNow)} != pgid=${pgid}; skip group kill`);
    return { killed: 0, survivors: [], method: "pid-reuse-guard" };
  }

  const descendants = snapshotPgrp(pgid).filter((p) => p !== pid);

  if (!killProcessGroup(pgid)) {
    let swept = 0;
    for (const p of descendants) if (killPid(p)) swept++;
    return { killed: swept, survivors: [], method: "snapshot-fallback" };
  }

  const survivors = snapshotPgrp(pgid).filter((p) => p !== pid);
  for (const p of survivors) killPid(p);
  return { killed: descendants.length + 1, survivors, method: "group-kill" };
}

// ============================
// Orphan sweep (§5.1)
// ============================

export interface OrphanCandidate {
  pid: number;
  /** RUN-uuid from environ; null when only the cmdline fallback matched. */
  runUuid: string | null;
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
      out.push({ pid, runUuid: run ? run.slice(ENV_RUN.length + 1) : null, source: "environ" });
    } catch {
      // environ unreadable (zombie/racer) — cmdline fallback.
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ");
        if (cmd.includes(ENV_RUN)) out.push({ pid, runUuid: null, source: "cmdline" });
      } catch {
        // Gone — skip.
      }
    }
  }
  return out;
}

/**
 * Kill stale keeper processes. Predicate: RUN-uuid ≠ active-run (a live run's
 * uuid protects the keeper AND its marker-inheriting children — iter-13
 * regression). With no active run, every marker-carrying process is an orphan.
 */
export function sweepKeeperOrphans(activeRunUuid: string | null, logger: Logger): number {
  const candidates = scanKeeperProcesses();
  let killed = 0;
  for (const c of candidates) {
    if (activeRunUuid !== null) {
      if (c.runUuid === activeRunUuid) continue; // live keeper — keep
      if (c.runUuid === null) continue; // cannot distinguish — keep
    }
    if (killPid(c.pid)) killed++;
  }
  if (killed > 0) {
    logger.warn?.(`[memory-keeper] orphan sweep killed ${killed} stale keeper process(es)`);
  }
  return killed;
}

// ============================
// Run wrapper (pipe drain + timeout + kill)
// ============================

export interface ChildRunResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
  killed: KillOutcome | null;
}

export interface RunKeeperOptions extends SpawnKeeperOptions {
  timeoutMs: number;
  logger: Logger;
  /** Called right after spawn — lets the orchestrator register a killer for
   * the gateway SIGTERM/exit path. */
  onChild?: (child: ChildProcess) => void;
}

/**
 * Spawn + live pipe drain + timeout + kill. Resolves on exit, on spawn error
 * (error field set), or on timeout (timedOut + group kill).
 */
export function runKeeperProcess(opts: RunKeeperOptions): Promise<ChildRunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnKeeper(opts);
      opts.onChild?.(child);
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        error: err instanceof Error ? err.message : String(err),
        killed: null,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    // Pipe-drain LIVE: listeners attached immediately.
    child.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      timedOut = true;
      const outcome = killChildGroup(child, opts.logger);
      if (settled) return;
      settled = true;
      resolve({ exitCode: null, signal: "SIGKILL", stdout, stderr, timedOut: true, killed: outcome });
    }, opts.timeoutMs);

    const settle = (exitCode: number | null, signal: string | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, timedOut, error, killed: null });
    };

    child.on("error", (err: Error) => settle(null, null, err.message));
    child.on("exit", (code, sig) => settle(code, sig));
  });
}
