/**
 * Launcher registry (tz-06 Ф1).
 *
 * `ExecutionBinding.launcherId` names a host; this turns the name into an
 * implementation. One place to add `claude` (Ф5) and `codex` (Ф5b) — and one
 * place where an unknown id becomes a typed refusal instead of a crash.
 */
import { createPiLauncher } from "./pi.js";
import { CLAUDE_LAUNCHER_ID, createClaudeLauncher } from "./claude.js";
import { CODEX_LAUNCHER_ID, createCodexLauncher } from "./codex.js";
import { PI_LAUNCHER_ID, type LauncherSettings } from "./pi-config.js";
import type { Logger } from "../../../core/types.js";
import type { LaunchOutcome, RoleLauncher } from "./types.js";

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
  const factories: Record<
    string,
    (s: LauncherSettings, l: Logger) => RoleLauncher
  > = {
    [PI_LAUNCHER_ID]: createPiLauncher,
    [CLAUDE_LAUNCHER_ID]: createClaudeLauncher,
    [CODEX_LAUNCHER_ID]: createCodexLauncher,
  };
  for (const [id, factory] of Object.entries(factories)) {
    const s = settings[id];
    if (s) built.set(id, factory(s, logger));
  }
  return (launcherId: string) =>
    built.get(launcherId) ?? refusingLauncher(launcherId);
}
