/**
 * The pi launcher (tz-06 Ф1) — the ONLY place that knows pi's binary and
 * flags. Everything moved here verbatim from keeper-run.ts (call shape),
 * role-spawn-args.ts (assets → --extension/--skill) and config.ts (defaults).
 *
 * Semantics are deliberately UNCHANGED in Ф1: `completion` still settles on
 * `exit`, output is still unbounded. Ф2 fixes the lifecycle in this file,
 * with the characterization tests of Ф0 as the before-picture.
 */
import fs from "node:fs";
import path from "node:path";
import { runKeeperProcess } from "./pi-process.js";
import { killChildGroup } from "../child-spawn.js";
import type { Logger } from "../../../core/types.js";
import type { ResolvedRoleContract } from "../role-contract-types.js";
import type { LauncherSettings } from "./pi-config.js";
import { ATTEMPTS_DIR, PI_LAUNCHER_ID, stripOwnedFlags } from "./pi-config.js";

/** @see capabilities.ts — the role's vocabulary, not pi's flag names. */
const PI_CAPABILITIES: ReadonlySet<string> = new Set([
  "session",
  "extension",
  "skill",
  "thinking",
  "tool-subset",
]);
import type {
  HostRunResult,
  LaunchError,
  LaunchInput,
  LaunchOutcome,
  RoleLauncher,
} from "./types.js";

/** Instance assets → CLI args. A role that brings its own extension disables
 * the ambient ones: the forked task-cycle registers the same tool names, and
 * pi treats a tool-name conflict as fatal. */
export function piAssetArgs(contract: ResolvedRoleContract): string[] {
  const args: string[] = [];
  if (contract.assets.extensionPath) {
    args.push("--no-extensions", "--extension", contract.assets.extensionPath);
  }
  if (contract.assets.skillPath) {
    args.push("--skill", contract.assets.skillPath);
  }
  return args;
}

/** ENOENT/EACCES from the spawn are the host refusing, not the role failing —
 * they travel as a typed error on the result (criterion 10, closed in Ф4). */
function classifySpawnError(message: string): LaunchError | undefined {
  if (message.includes("ENOENT")) {
    return { kind: "binary-not-found", message };
  }
  if (message.includes("EACCES") || message.includes("EPERM")) {
    return { kind: "permission-denied", message };
  }
  return undefined;
}

export function createPiLauncher(
  settings: LauncherSettings,
  logger: Logger,
): RoleLauncher {
  return {
    id: PI_LAUNCHER_ID,
    // pi has all of these today; `isolation` is deliberately absent until Ф6
    // gives it a real profile — claiming it now would make L6 unfalsifiable.
    capabilities: PI_CAPABILITIES,
    async launch(input: LaunchInput): Promise<LaunchOutcome> {
      const { contract } = input;
      let cancel: (() => void) | undefined;

      // Session per ATTEMPT (tz-06 Ф3): two attempts of one run must not share
      // a transcript, or the second reads as a continuation of the first.
      const sessionDir = path.join(
        input.cwd,
        ATTEMPTS_DIR,
        input.attemptId,
        "session",
      );
      fs.mkdirSync(sessionDir, { recursive: true });

      // The handle is returned WITHOUT awaiting the run: a caller that cannot
      // cancel until the child is done has no cancel at all.
      const completion: Promise<HostRunResult> = runKeeperProcess({
        piBinary: settings.binary,
        // The session flags belong to the launcher, never to the operator's
        // fixed flags — see stripOwnedFlags.
        spawnFlags: [
          ...stripOwnedFlags(settings.flags),
          "--session-dir",
          sessionDir,
        ],
        extraArgs: piAssetArgs(contract),
        model: contract.binding.model,
        thinking: contract.binding.thinking,
        systemPromptPath: input.promptPath,
        taskPrompt: input.taskPrompt,
        cwd: input.cwd,
        env: input.env,
        timeoutMs: contract.timeoutMs,
        logger,
        onChild: (child) => {
          // Group kill, exactly as before the port existed: the kill policy
          // belongs to child-spawn, not to a launcher (Ф1 changes no
          // semantics).
          cancel = () => killChildGroup(child, logger);
          input.onSpawn?.(cancel);
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
          res.error === undefined ? undefined : classifySpawnError(res.error),
      }));

      return {
        ok: true,
        handle: {
          sessionRef: sessionDir,
          completion,
          cancelAndWait: async () => {
            cancel?.();
            return completion;
          },
        },
      };
    },
  };
}
