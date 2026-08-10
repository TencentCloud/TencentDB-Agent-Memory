/**
 * The child process lifecycle, host-agnostic (tz-06 Ф2, generalized in Ф5).
 *
 * Lifecycle contract: the terminal result appears only after `close` (every
 * stdio stream done) and the exit has been reaped, never on `exit` alone —
 * otherwise output written between the two is silently lost. `close` may
 * never come if a descendant inherited the pipe and daemonized, so the wait
 * is bounded by REAP_GRACE_MS.
 *
 * Every launcher shares this: only the ARGV is host-specific, and that is
 * what `launchers/<host>.ts` decides. Nothing here names a binary or a flag.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "../../../core/types.js";
import { killChildGroup } from "../keeper-proc.js";
import { createSpool } from "./output-spool.js";
import type { KillOutcome } from "../keeper-proc.js";

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

export interface RunChildOptions {
  binary: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  logger: Logger;
  /** Called right after spawn — lets the orchestrator register a killer for
   * the gateway SIGTERM/exit path. */
  onChild?: (child: ChildProcess) => void;
  /** Where `artifacts/` goes. Defaults to `cwd`, but the keeper and the critic
   * of one run SHARE a cwd, so a per-run spool makes both attempt rows point
   * at one appended file whose size contradicts either row's byte count. */
  artifactRoot?: string;
}

/** Run a child to completion: spawn, drain pipes, wait exit/timeout. */
export function runChildProcess(
  opts: RunChildOptions,
): Promise<ChildRunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(opts.binary, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      opts.onChild?.(child);
      opts.logger.debug?.(`[child] spawned pid=${child.pid}`);
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

    const artifactRoot = opts.artifactRoot ?? opts.cwd;
    const out = createSpool(artifactRoot, "stdout");
    const err = createSpool(artifactRoot, "stderr");
    let timedOut = false;
    let killed: KillOutcome | null = null;
    let settled = false;
    let exited: { code: number | null; signal: string | null } | null = null;
    let spawnError: string | undefined;

    // Pipe-drain LIVE: listeners attached immediately. The pipe is PAUSED
    // while the spool file is behind, so a child that outruns the disk backs
    // up in the kernel pipe instead of in this process's heap.
    const pump = (
      src: NodeJS.ReadableStream,
      spool: ReturnType<typeof createSpool>,
    ): void => {
      spool.onDrain(() => src.resume());
      src.on("data", (d: Buffer) => {
        spool.write(d);
        if (spool.saturated()) src.pause();
      });
    };
    pump(child.stdout!, out);
    pump(child.stderr!, err);

    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reapTimer !== undefined) clearTimeout(reapTimer);
      // The result carries the spool PATHS, so it must not be handed over
      // until those files are complete on disk.
      void Promise.all([out.close(), err.close()]).then(() =>
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
        }),
      );
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
    child.on("exit", (code: number | null, signal: string | null) => {
      exited = { code, signal };
      opts.logger.debug?.(
        `[child] exited pid=${child.pid} code=${code} signal=${signal} timedOut=${timedOut}`,
      );
      // A daemonized grandchild can hold the pipe open forever; waiting for
      // `close` without a bound would wedge the run. Grace, then settle.
      reapTimer = setTimeout(() => settle(), REAP_GRACE_MS);
    });
  });
}
