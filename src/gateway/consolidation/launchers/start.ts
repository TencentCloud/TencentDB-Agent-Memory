/**
 * The part of a launch that is the SAME on every host (tz-06 Ф5b).
 *
 * Per-attempt session dir, the running handle, and the mapping from a child
 * result to a `HostRunResult` — three copies of this is three places for the
 * "non-zero exit is not success" rule to rot. A launcher decides its argv and
 * its env, and hands them here.
 */
import fs from "node:fs";
import path from "node:path";
import { runChildProcess } from "./child-process.js";
import { killChildGroup } from "../child-spawn.js";
import { ATTEMPTS_DIR } from "./pi-config.js";
import { classifyLaunchError } from "./spawn-errors.js";
import type { Logger } from "../../../core/types.js";
import type { HostRunResult, LaunchInput, LaunchOutcome } from "./types.js";

/** `<cwd>/attempts/<attemptId>/session` — created, not just named. */
export function attemptSessionDir(input: LaunchInput): string {
  const dir = path.join(input.cwd, ATTEMPTS_DIR, input.attemptId, "session");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface StartOptions {
  binary: string;
  args: string[];
  /** Host-specific additions to the pipeline's env (session location). */
  env: Record<string, string>;
  sessionRef: string;
  input: LaunchInput;
  logger: Logger;
}

export function startHosted(opts: StartOptions): LaunchOutcome {
  let cancel: (() => void) | undefined;
  // The handle is returned WITHOUT awaiting the run: a caller that cannot
  // cancel until the child is done has no cancel at all.
  const completion: Promise<HostRunResult> = runChildProcess({
    binary: opts.binary,
    args: opts.args,
    cwd: opts.input.cwd,
    env: opts.env,
    timeoutMs: opts.input.contract.timeoutMs,
    logger: opts.logger,
    onChild: (child) => {
      cancel = () => killChildGroup(child, opts.logger);
      opts.input.onSpawn?.(cancel);
    },
  }).then((res) => ({
    status: res.timedOut
      ? ("timed_out" as const)
      : res.error !== undefined || res.exitCode !== 0
        ? ("failed" as const)
        : ("succeeded" as const),
    exitCode: res.exitCode,
    signal: res.signal,
    stdout: res.stdout,
    stderr: res.stderr,
    error: res.error,
    launchError:
      res.error === undefined ? undefined : classifyLaunchError(res.error),
  }));

  return {
    ok: true,
    handle: {
      sessionRef: opts.sessionRef,
      completion,
      cancelAndWait: async () => {
        cancel?.();
        return completion;
      },
    },
  };
}

/** The pipeline wrote this file; an unreadable one is the host side refusing
 * to start, not the role failing. */
export function readSystemPrompt(
  input: LaunchInput,
): { ok: true; text: string } | { ok: false; outcome: LaunchOutcome } {
  try {
    return { ok: true, text: fs.readFileSync(input.promptPath, "utf-8") };
  } catch (err) {
    return {
      ok: false,
      outcome: {
        ok: false,
        error: {
          kind: "permission-denied",
          message: `system prompt unreadable: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      },
    };
  }
}
