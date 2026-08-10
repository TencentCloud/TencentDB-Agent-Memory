/**
 * The codex launcher (tz-06 Ф5b) — third host behind the same port.
 *
 * Host differences absorbed here: the session lives under CODEX_HOME (no
 * session flag at all), and there is no system-prompt flag — the prompt the
 * pipeline wrote is prepended to the task text.
 *
 * Unlike pi and claude, codex CAN confine the child: `-s <mode>` is a real
 * sandbox, so this is the one launcher that claims `isolation` (the L6 gate
 * of Ф6 is what proves the claim).
 */
import { stripOwnedFlags } from "./pi-config.js";
import { attemptSessionDir, readSystemPrompt, startHosted } from "./start.js";
import type { Logger } from "../../../core/types.js";
import type { LauncherSettings } from "./pi-config.js";
import type { LaunchInput, LaunchOutcome, RoleLauncher } from "./types.js";

export const CODEX_LAUNCHER_ID = "codex";
export const DEFAULT_CODEX_BINARY = "codex";
/** `exec` is the non-interactive entry; the repo check is off because the
 * scratch dir of a run is not a git worktree. */
export const DEFAULT_CODEX_FLAGS: readonly string[] = [
  "exec",
  "--skip-git-repo-check",
];

/** @see capabilities.ts. `isolation` is real here (`-s`), `session` is the
 * CODEX_HOME below. No extension/skill/thinking: codex has no equivalent. */
const CODEX_CAPABILITIES: ReadonlySet<string> = new Set([
  "session",
  "isolation",
]);

/** Owned by the launcher: the session and the working root are decided per
 * attempt, and the sandbox mode is a SECURITY decision — an operator flag
 * that widens it silently is exactly what L6 forbids. */
const OWNED = ["-C", "--cd", "--ephemeral", "-s", "--sandbox"];

/** Default confinement: the child may write its own scratch and nothing
 * else. Ф6 binds this to `binding.isolationProfileRef` instead. */
export const DEFAULT_SANDBOX_MODE = "workspace-write";

export function codexArgs(
  settings: LauncherSettings,
  input: LaunchInput,
  prompt: string,
): string[] {
  return [
    ...stripOwnedFlags(settings.flags, OWNED),
    "-C",
    input.cwd,
    "-s",
    DEFAULT_SANDBOX_MODE,
    "-m",
    input.contract.binding.model,
    prompt,
  ];
}

export function createCodexLauncher(
  settings: LauncherSettings,
  logger: Logger,
): RoleLauncher {
  return {
    id: CODEX_LAUNCHER_ID,
    capabilities: CODEX_CAPABILITIES,
    async launch(input: LaunchInput): Promise<LaunchOutcome> {
      const sessionRef = attemptSessionDir(input);
      const prompt = readSystemPrompt(input);
      if (!prompt.ok) return prompt.outcome;

      return startHosted({
        binary: settings.binary,
        args: codexArgs(
          settings,
          input,
          `${prompt.text}\n\n${input.taskPrompt}`,
        ),
        // No session flag exists — CODEX_HOME is where the transcript lands,
        // so it points at this attempt and nowhere shared.
        env: { ...input.env, CODEX_HOME: sessionRef },
        sessionRef,
        input,
        logger,
      });
    },
  };
}
