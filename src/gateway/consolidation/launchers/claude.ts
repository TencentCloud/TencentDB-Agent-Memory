/**
 * The claude launcher (tz-06 Ф5) — second host behind the same port.
 *
 * Two host differences the port absorbs rather than leaks:
 *   - there is no `--session-dir`; the transcript follows CLAUDE_CONFIG_DIR,
 *     so the per-attempt session is an ENV var plus a `--session-id` uuid;
 *   - there is no `--system-prompt-file`; the prompt the pipeline wrote is
 *     read here and passed as text.
 *
 * What claude cannot do at all (a role's own extension bundle, a skill dir,
 * a per-request thinking level) is declared MISSING instead of approximated —
 * that is what makes `host-incompatible` mean something (tz-06 R2/L5).
 */
import { randomUUID } from "node:crypto";
import { stripOwnedFlags } from "./pi-config.js";
import { attemptSessionDir, readSystemPrompt, startHosted } from "./start.js";
import type { Logger } from "../../../core/types.js";
import type { LauncherSettings } from "./pi-config.js";
import type { LaunchInput, LaunchOutcome, RoleLauncher } from "./types.js";

export const CLAUDE_LAUNCHER_ID = "claude";
export const DEFAULT_CLAUDE_BINARY = "claude";
export const DEFAULT_CLAUDE_FLAGS: readonly string[] = ["-p"];

/** @see capabilities.ts. No `extension`/`skill`: claude has no equivalent of
 * pi's `--extension`/`--skill`. No `thinking`: the level is not a per-request
 * flag here. A role needing those is refused, not silently downgraded. */
const CLAUDE_CAPABILITIES: ReadonlySet<string> = new Set([
  "session",
  "tool-subset",
]);

/** Session flags this launcher owns, for the same reason pi owns its own. */
const OWNED = ["--session-id", "--resume", "--continue"];

export function claudeArgs(
  settings: LauncherSettings,
  input: LaunchInput,
  sessionId: string,
  systemPrompt: string,
): string[] {
  const tools = input.contract.toolsSubset;
  return [
    ...stripOwnedFlags(settings.flags ?? [...DEFAULT_CLAUDE_FLAGS], OWNED),
    "--session-id",
    sessionId,
    "--model",
    input.contract.binding.model,
    "--system-prompt",
    systemPrompt,
    ...(tools && tools.size > 0
      ? ["--allowedTools", [...tools].join(",")]
      : []),
    input.taskPrompt,
  ];
}

export function createClaudeLauncher(
  settings: LauncherSettings,
  logger: Logger,
): RoleLauncher {
  return {
    id: CLAUDE_LAUNCHER_ID,
    capabilities: CLAUDE_CAPABILITIES,
    async launch(input: LaunchInput): Promise<LaunchOutcome> {
      const sessionRef = attemptSessionDir(input);
      const prompt = readSystemPrompt(input);
      if (!prompt.ok) return prompt.outcome;

      return startHosted({
        binary: settings.binary,
        args: claudeArgs(settings, input, randomUUID(), prompt.text),
        // The transcript location IS the session here — CLAUDE_CONFIG_DIR is
        // the only knob, so it points at this attempt's dir and nowhere else.
        env: { ...input.env, CLAUDE_CONFIG_DIR: sessionRef },
        sessionRef,
        input,
        logger,
      });
    },
  };
}
