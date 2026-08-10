/**
 * pi's ARGV shape (tz-06 Ф1) — the only place that knows pi's flag names.
 * The lifecycle itself lives in child-process.ts and is shared by every host.
 */
import type { ChildProcess } from "node:child_process";
import type { Logger } from "../../../core/types.js";
import { runChildProcess, type ChildRunResult } from "./child-process.js";

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

export function piArgs(opts: SpawnKeeperOptions): string[] {
  return [
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
}

export interface RunKeeperOptions extends SpawnKeeperOptions {
  timeoutMs: number;
  logger: Logger;
  /** Called right after spawn — lets the orchestrator register a killer for
   * the gateway SIGTERM/exit path. */
  onChild?: (child: ChildProcess) => void;
}

/** Run pi to completion. Thin: argv here, lifetime in child-process.ts. */
export function runKeeperProcess(
  opts: RunKeeperOptions,
): Promise<ChildRunResult> {
  return runChildProcess({
    binary: opts.piBinary,
    args: piArgs(opts),
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    logger: opts.logger,
    onChild: opts.onChild,
  });
}

export { REAP_GRACE_MS, type ChildRunResult } from "./child-process.js";
