/**
 * The pi process itself — spawn, pipe drain, timeout, kill, reap (tz-06 Ф2).
 *
 * Lifecycle contract: the terminal result appears only after `close` (every
 * stdio stream done) and the exit has been reaped, never on `exit` alone —
 * otherwise output written between the two is silently lost. `close` may
 * never come if a descendant inherited the pipe and daemonized, so the wait
 * is bounded by REAP_GRACE_MS.
 *
 * Lives here, not in child-spawn.ts, to avoid a child-spawn ↔ launcher cycle.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "../../../core/types.js";
import { killChildGroup } from "../keeper-proc.js";
import { createSpool } from "./output-spool.js";
import type { KillOutcome } from "../keeper-proc.js";

export interface SpawnKeeperOptions {
  piBinary: string;
  /** Fixed flags from the launcher settings; the model/thinking/prompt args
   * are appended below. */
  spawnFlags: string[];
  /** Extra args from the role's instance assets, appended BEFORE the model. */
  extraArgs?: string[];
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
    ...(opts.extraArgs ?? []),
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

export interface ChildRunResult {
  exitCode: number | null;
  signal: string | null;
  /** TAIL of the stream (bounded) — the full text is in the spool file. */
  stdout: string;
  stderr: string;
  /** Bytes the child actually produced, including what the tail dropped. */
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutFile?: string | null;
  stderrFile?: string | null;
  timedOut: boolean;
  error?: string;
  killed: KillOutcome | null;
}

/** How long to wait for `close` after `exit` before giving up on a
 * descendant that inherited the pipe and never let go. */
export const REAP_GRACE_MS = 2000;

export interface RunKeeperOptions extends SpawnKeeperOptions {
  timeoutMs: number;
  logger: Logger;
  /** Called right after spawn — lets the orchestrator register a killer for
   * the gateway SIGTERM/exit path. */
  onChild?: (child: ChildProcess) => void;
}

/** Run the keeper to completion: spawn, drain pipes, wait exit/timeout. */
export function runKeeperProcess(
  opts: RunKeeperOptions,
): Promise<ChildRunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnKeeper(opts);
      opts.onChild?.(child);
      opts.logger.debug?.(`[keeper] spawned pid=${child.pid}`);
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

    const out = createSpool(opts.cwd, "stdout");
    const err = createSpool(opts.cwd, "stderr");
    let timedOut = false;
    let killed: KillOutcome | null = null;
    let settled = false;
    let exited: { code: number | null; signal: string | null } | null = null;
    let spawnError: string | undefined;

    // Pipe-drain LIVE: listeners attached immediately.
    child.stdout!.on("data", (d: Buffer) => out.write(d));
    child.stderr!.on("data", (d: Buffer) => err.write(d));

    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reapTimer !== undefined) clearTimeout(reapTimer);
      out.close();
      err.close();
      resolve({
        exitCode: exited?.code ?? null,
        signal: exited?.signal ?? (timedOut ? "SIGKILL" : null),
        stdout: out.tail(),
        stderr: err.tail(),
        stdoutBytes: out.bytes(),
        stderrBytes: err.bytes(),
        stdoutFile: out.file,
        stderrFile: err.file,
        timedOut,
        error: spawnError,
        killed,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killed = killChildGroup(child, opts.logger);
      // Do NOT settle here: the terminal result still waits for close+reap,
      // so a kill and a natural exit produce the same shape of answer.
    }, opts.timeoutMs);

    // `close` fires when every stdio stream is done, which is AFTER `exit` and
    // after any descendant that inherited the pipe let go of it — that is what
    // makes late output part of the result instead of a lost write.
    let reapTimer: NodeJS.Timeout | undefined;
    child.on("close", () => settle());
    child.on("error", (e: Error) => {
      spawnError = e.message;
      settle();
    });
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      opts.logger.debug?.(
        `[keeper] exited pid=${child.pid} code=${code} signal=${signal} timedOut=${timedOut}`,
      );
      // A daemonized grandchild can hold the pipe open forever; waiting for
      // `close` without a bound would wedge the run. Grace, then settle.
      reapTimer = setTimeout(() => settle(), REAP_GRACE_MS);
    });
  });
}
