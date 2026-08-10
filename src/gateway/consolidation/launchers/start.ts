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
import { confineArgv } from "./isolation.js";
import type { Logger } from "../../../core/types.js";
import type { HostRunResult, LaunchInput, LaunchOutcome } from "./types.js";

/** `<cwd>/attempts/<attemptId>` — the private root of ONE attempt. The run's
 * cwd is shared (the keeper and its critic run in the same scratch), so
 * anything an attempt owns hangs off here and not off the cwd. */
export function attemptDir(input: LaunchInput): string {
  return path.join(input.cwd, ATTEMPTS_DIR, input.attemptId);
}

/** `<cwd>/attempts/<attemptId>/session` — created, not just named. */
export function attemptSessionDir(input: LaunchInput): string {
  const dir = path.join(attemptDir(input), "session");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Give the attempt its own COPY of the identity files from the operator's
 * host home.
 *
 * Every host here locates its credentials through the same env var that also
 * names the session store, so pointing that var at a fresh per-attempt dir
 * takes the login away along with the isolation — the child has to find a
 * credential inside its own writable workspace.
 *
 * This used to be a symlink, and that was wrong: the target of a symlink
 * inside a writable dir is writable too, so the child could overwrite the
 * OPERATOR's real `.credentials.json` through it (probe
 * scripts/tz06-probe/f11-secret-escape.mts: "секрет ПЕРЕЗАПИСАН ребёнком:
 * true"). A copy costs a second secret on disk, which is why it is 0600 and
 * why the returned cleanup unlinks it when the attempt settles — a child that
 * clobbers it now clobbers only its own.
 *
 * Reading it remains possible, and is not a defect: the child cannot
 * authenticate without it.
 *
 * Best-effort: a host without credentials fails loudly by itself, and that is
 * a run error, not a launch one.
 *
 * @returns a cleanup that removes the copies. Idempotent.
 */
export function provideIdentity(
  sessionDir: string,
  home: string,
  names: readonly string[],
  logger: Logger,
  tag: string,
): () => void {
  const copied: string[] = [];
  for (const name of names) {
    const src = path.join(home, name);
    const dst = path.join(sessionDir, name);
    try {
      if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, 0o600);
      copied.push(dst);
    } catch (err) {
      logger.debug?.(
        `[${tag}] could not provide ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return () => {
    for (const dst of copied) {
      try {
        fs.rmSync(dst, { force: true });
      } catch (err) {
        logger.debug?.(
          `[${tag}] could not drop ${path.basename(dst)}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  };
}

export interface StartOptions {
  binary: string;
  args: string[];
  /** Host-specific additions to the pipeline's env (session location). */
  env: Record<string, string>;
  sessionRef: string;
  input: LaunchInput;
  logger: Logger;
  /** Runs once the attempt is terminal — where the identity copies are
   * dropped, so no launcher has to own that lifetime itself. */
  onSettled?: () => void;
}

export function startHosted(opts: StartOptions): LaunchOutcome {
  let cancel: (() => void) | undefined;
  // A cancel is not a failure of the role: the caller asked for it. Without
  // this the two are indistinguishable downstream.
  let cancelled = false;
  // Past the L6 gate (runner-helpers), a role with a profile runs CONFINED —
  // the wrapper is applied here so no launcher can forget it.
  const cmd =
    (opts.input.contract.binding.isolationProfileRef ?? null) === null
      ? { binary: opts.binary, args: opts.args }
      : confineArgv(opts.input.cwd, opts.binary, opts.args);
  // The handle is returned WITHOUT awaiting the run: a caller that cannot
  // cancel until the child is done has no cancel at all.
  const completion: Promise<HostRunResult> = runChildProcess({
    binary: cmd.binary,
    args: cmd.args,
    cwd: opts.input.cwd,
    // Spool into the ATTEMPT's dir: the keeper and its critic share a cwd, so
    // a per-run spool made both attempt rows point at one appended file.
    artifactRoot: attemptDir(opts.input),
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
      : cancelled
        ? ("cancelled" as const)
        : res.error !== undefined || res.exitCode !== 0
          ? ("failed" as const)
          : ("succeeded" as const),
    exitCode: res.exitCode,
    signal: res.signal,
    stdout: res.stdout,
    stderr: res.stderr,
    // The bounded tail is useless without the pointer to the whole stream —
    // "full output available by artifact ref" was the claim (критерий 8).
    stdoutFile: res.stdoutFile ?? null,
    stderrFile: res.stderrFile ?? null,
    stdoutBytes: res.stdoutBytes,
    stderrBytes: res.stderrBytes,
    error: res.error,
    launchError:
      res.error === undefined ? undefined : classifyLaunchError(res.error),
  })).finally(() => opts.onSettled?.());

  return {
    ok: true,
    handle: {
      sessionRef: opts.sessionRef,
      completion,
      cancelAndWait: async () => {
        cancelled = true;
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
