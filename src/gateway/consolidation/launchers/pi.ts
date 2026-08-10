/**
 * The pi launcher (tz-06 Ф1) — the ONLY place that knows pi's binary and
 * flags. Everything moved here verbatim from keeper-run.ts (call shape),
 * role-spawn-args.ts (assets → --extension/--skill) and config.ts (defaults).
 *
 * Semantics are deliberately UNCHANGED in Ф1: `completion` still settles on
 * `exit`, output is still unbounded. Ф2 fixes the lifecycle in this file,
 * with the characterization tests of Ф0 as the before-picture.
 */
import { piArgs } from "./pi-process.js";
import { attemptSessionDir, startHosted } from "./start.js";
import type { Logger } from "../../../core/types.js";
import type { ResolvedRoleContract } from "../role-contract-types.js";
import type { LauncherSettings } from "./pi-config.js";
import {
  DEFAULT_PI_FLAGS,
  PI_LAUNCHER_ID,
  stripOwnedFlags,
} from "./pi-config.js";

/** @see capabilities.ts — the role's vocabulary, not pi's flag names.
 *
 * `tool-subset` is claimed and delivered, just not through argv: the role's
 * declared helpers are copied into `<scratch>/tools/` by copyKeeperTools, and
 * the child sees exactly those files. That IS the subset for this host. */
const PI_CAPABILITIES: ReadonlySet<string> = new Set([
  "session",
  "extension",
  "skill",
  "thinking",
  "tool-subset",
]);
import type { LaunchInput, LaunchOutcome, RoleLauncher } from "./types.js";

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
      // Session per ATTEMPT (tz-06 Ф3): two attempts of one run must not share
      // a transcript, or the second reads as a continuation of the first.
      const sessionRef = attemptSessionDir(input);
      return startHosted({
        binary: settings.binary,
        args: piArgs({
          piBinary: settings.binary,
          // The session flags belong to the launcher, never to the operator's
          // fixed flags — see stripOwnedFlags.
          spawnFlags: [
            ...stripOwnedFlags(settings.flags ?? [...DEFAULT_PI_FLAGS]),
            "--session-dir",
            sessionRef,
          ],
          extraArgs: piAssetArgs(input.contract),
          model: input.contract.binding.model,
          thinking: input.contract.binding.thinking,
          systemPromptPath: input.promptPath,
          taskPrompt: input.taskPrompt,
          cwd: input.cwd,
          env: input.env,
        }),
        env: input.env,
        sessionRef,
        input,
        logger,
      });
    },
  };
}
