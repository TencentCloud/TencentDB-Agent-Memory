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
import path from "node:path";
import {
  attemptDir,
  attemptSessionDir,
  provideIdentity,
  startHosted,
} from "./start.js";
import { authRootFor } from "./auth-root.js";
import type { Logger } from "../../../core/types.js";
import type { LauncherSettings } from "./pi-config.js";
import { ENV_PI_SUBAGENT_DIRS, PI_LAUNCHER_ID } from "./pi-config.js";
import { piAssetArgs, piFixedFlags } from "./pi-policy.js";
export { piAssetArgs } from "./pi-policy.js";

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

export function createPiLauncher(
  settings: LauncherSettings,
  logger: Logger,
): RoleLauncher {
  return {
    id: PI_LAUNCHER_ID,
    capabilities: PI_CAPABILITIES,
    async launch(input: LaunchInput): Promise<LaunchOutcome> {
      if (
        input.contract.assets.ambientAccess === "none" &&
        (input.contract.assets.extensionPath || input.contract.assets.skillPath)
      )
        return {
          ok: false,
          error: {
            kind: "invalid-binding",
            message: "ambient-none role cannot load extensions or skills",
          },
        };
      // Session per ATTEMPT (tz-06 Ф3): two attempts of one run must not share
      // a transcript, or the second reads as a continuation of the first.
      const sessionRef = attemptSessionDir(input);
      const privateHome = path.join(attemptDir(input), "home");
      const dropIdentity = provideIdentity(
        privateHome,
        authRootFor(PI_LAUNCHER_ID),
        [path.join(".pi", "agent", "auth.json")],
        logger,
        "pi",
      );
      return startHosted({
        binary: settings.binary,
        args: piArgs({
          piBinary: settings.binary,
          // The session flags belong to the launcher, never to the operator's
          // fixed flags — see stripOwnedFlags.
          spawnFlags: [
            ...piFixedFlags(settings, input.contract),
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
        env: {
          ...input.env,
          HOME: privateHome,
          ...subagentDirsEnv(settings, input),
        },
        sessionRef,
        input,
        logger,
        onSettled: dropIdentity,
      });
    },
  };
}

/**
 * The subagent-definition dirs, or nothing.
 *
 * Withheld from an `ambient_access: "none"` role on purpose. Such a role starts
 * with `--no-tools --no-extensions --no-skills`, so it could not spawn anything
 * anyway — but the variable would still hand it a path into the operator's
 * tree, and "hermetic" has to mean the child is told nothing about the outside,
 * not merely that it cannot act on it.
 */
function subagentDirsEnv(
  settings: LauncherSettings,
  input: LaunchInput,
): Record<string, string> {
  const dirs = settings.subagentDirs ?? [];
  if (dirs.length === 0 || input.contract.assets.ambientAccess === "none")
    return {};
  return { [ENV_PI_SUBAGENT_DIRS]: dirs.join(path.delimiter) };
}
