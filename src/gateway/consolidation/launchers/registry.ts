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
import { checkCapabilities } from "./capabilities.js";
import type { LaunchInput, LaunchOutcome, RoleLauncher } from "./types.js";

/** The capability check belongs to every launcher, so it lives ONCE here
 * rather than in each implementation, where the third one would forget it. */
function withCapabilityGate(inner: RoleLauncher): RoleLauncher {
  return {
    id: inner.id,
    capabilities: inner.capabilities,
    launch: async (input: LaunchInput): Promise<LaunchOutcome> => {
      const error = checkCapabilities(
        inner.id,
        input.contract.requiresCapabilities,
        inner.capabilities,
      );
      return error === null ? inner.launch(input) : { ok: false, error };
    },
  };
}

/** A launcher that refuses everything, so an unknown binding surfaces as an
 * `invalid-binding` LaunchError on the run instead of throwing at wiring time
 * (criterion 10: typed errors never reject the service promise). */
function refusingLauncher(id: string): RoleLauncher {
  return {
    id,
    capabilities: new Set<string>(),
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
  return (launcherId: string) => {
    const launcher = built.get(launcherId);
    // An unregistered id is a BINDING error; gating it on capabilities would
    // report "host-incompatible" for a host that does not exist here at all.
    return launcher === undefined
      ? refusingLauncher(launcherId)
      : withCapabilityGate(launcher);
  };
}
