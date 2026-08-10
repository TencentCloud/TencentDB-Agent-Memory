/**
 * Launcher registry (tz-06 Ф1).
 *
 * `ExecutionBinding.launcherId` names a host; this turns the name into an
 * implementation. One place to add `claude` (Ф5) and `codex` (Ф5b) — and one
 * place where an unknown id becomes a typed refusal instead of a crash.
 */
import { createPiLauncher } from "./pi.js";
import { PI_LAUNCHER_ID, type LauncherSettings } from "./pi-config.js";
import type { Logger } from "../../../core/types.js";
import type { LaunchOutcome, RoleLauncher } from "./types.js";

/** A launcher that refuses everything, so an unknown binding surfaces as an
 * `invalid-binding` LaunchError on the run instead of throwing at wiring time
 * (criterion 10: typed errors never reject the service promise). */
function refusingLauncher(id: string): RoleLauncher {
  return {
    id,
    launch: async (): Promise<LaunchOutcome> => ({
      ok: false,
      error: {
        kind: "invalid-binding",
        message: `no launcher registered for "${id}"`,
      },
    }),
  };
}

export function createLauncherRegistry(
  settings: Record<string, LauncherSettings>,
  logger: Logger,
): (launcherId: string) => RoleLauncher {
  const built = new Map<string, RoleLauncher>();
  const piSettings = settings[PI_LAUNCHER_ID];
  if (piSettings) {
    built.set(PI_LAUNCHER_ID, createPiLauncher(piSettings, logger));
  }
  return (launcherId: string) =>
    built.get(launcherId) ?? refusingLauncher(launcherId);
}
