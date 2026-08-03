/**
 * Keeper run wrapper — spawn + pipe drain + timeout + kill of the pi
 * sub-session. SpawnKeeperOptions/spawnKeeper live here (NOT child-spawn.ts)
 * to avoid a child-spawn ↔ keeper-run import cycle.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "../../core/types.js";
import { killChildGroup } from "./keeper-proc.js";
import type { KillOutcome } from "./keeper-proc.js";

export interface SpawnKeeperOptions {
  piBinary: string;
  /** Config spawnFlags — defaults ["-p","--no-context-files","--no-session"];
   * --model/--thinking/--system-prompt are appended by the orchestrator. */
  spawnFlags: string[];
  /** Optional extra CLI args appended BEFORE --model (e.g. --extension/--skill
   * for the forked task-cycle role wiring, path б). */
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

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    // Pipe-drain LIVE: listeners attached immediately.
    child.stdout!.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr!.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      const outcome = killChildGroup(child, opts.logger);
      if (settled) return;
      settled = true;
      resolve({
        exitCode: null,
        signal: "SIGKILL",
        stdout,
        stderr,
        timedOut: true,
        killed: outcome,
      });
    }, opts.timeoutMs);

    const settle = (
      exitCode: number | null,
      signal: string | null,
      error?: string,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        error,
        killed: null,
      });
    };

    child.on("error", (err: Error) => settle(null, null, err.message));
    child.on("exit", (code, sig) => {
      opts.logger.debug?.(`[keeper] exited pid=${child.pid} code=${code} signal=${sig} timedOut=${timedOut}`);
      settle(code, sig);
    });
  });
}
