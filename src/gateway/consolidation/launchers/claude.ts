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
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stripOwnedFlags } from "./pi-config.js";
import {
  attemptSessionDir,
  provideIdentity,
  readSystemPrompt,
  startHosted,
} from "./start.js";
import type { Logger } from "../../../core/types.js";
import type { LauncherSettings } from "./pi-config.js";
import type { LaunchInput, LaunchOutcome, RoleLauncher } from "./types.js";
import { authRootFor } from "./auth-root.js";

export const CLAUDE_LAUNCHER_ID = "claude";
export const DEFAULT_CLAUDE_BINARY = "claude";
export const DEFAULT_CLAUDE_FLAGS: readonly string[] = ["-p"];

/** @see capabilities.ts. No `extension`/`skill`: claude has no equivalent of
 * pi's `--extension`/`--skill`. No `thinking`: the level is not a per-request
 * flag here.
 *
 * `tool-subset` IS provided, for the same reason pi provides it and not
 * through argv: `copyKeeperTools` (keeper-tools.ts:81) puts only the role's
 * declared helpers into `<scratch>/tools/`, so the child of ANY host sees
 * exactly that subset. An earlier round of this file retracted the capability
 * by reasoning about `--allowedTools`, which is the wrong mechanism — that
 * flag names host tools (`Bash`, `Read`), not the role's helpers, and it is
 * not what enforces the subset. */
const CLAUDE_CAPABILITIES: ReadonlySet<string> = new Set([
  "session",
  "tool-subset",
]);

/** Session flags this launcher owns, for the same reason pi owns its own —
 * plus the permission mode, which is not a preference: `-p` with the default
 * mode cannot write, so the role would exit having produced no candidate.
 * `acceptEdits` is the narrowest mode that lets it write its own run dir;
 * confinement is the L6 bwrap path, not this flag. */
const OWNED = [
  "--session-id",
  "--resume",
  "--continue",
  "--permission-mode",
  "--dangerously-skip-permissions",
];

export const PERMISSION_MODE = "acceptEdits";

export function claudeArgs(
  settings: LauncherSettings,
  input: LaunchInput,
  sessionId: string,
  systemPrompt: string,
): string[] {
  return [
    ...stripOwnedFlags(settings.flags ?? [...DEFAULT_CLAUDE_FLAGS], OWNED),
    "--session-id",
    sessionId,
    "--permission-mode",
    PERMISSION_MODE,
    "--model",
    input.contract.binding.model,
    "--system-prompt",
    systemPrompt,
    input.taskPrompt,
  ];
}

/** The operator's real claude home — where `.credentials.json` lives. */
export function operatorClaudeHome(): string {
  // tz-07 H3: one declared place per host, not a literal per launcher.
  return authRootFor(CLAUDE_LAUNCHER_ID);
}

/** Only the credential file. `settings.json` is deliberately NOT provided: it
 * carries the operator's hooks and permissions, and a role session is not the
 * place to replay them. Verified against the real binary — with the credential
 * the child answers, without it claude prints "Not logged in · Please run
 * /login" and exits 0, so the role would produce no candidate and no error. */
export function provideClaudeIdentity(
  sessionDir: string,
  logger: Logger,
): () => void {
  return provideIdentity(
    sessionDir,
    operatorClaudeHome(),
    [".credentials.json"],
    logger,
    "claude",
  );
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
      // CLAUDE_CONFIG_DIR is BOTH the transcript store and where the login
      // lives, so an empty per-attempt dir means an unauthenticated child.
      const dropIdentity = provideClaudeIdentity(sessionRef, logger);
      const prompt = readSystemPrompt(input);
      if (!prompt.ok) {
        dropIdentity();
        return prompt.outcome;
      }

      return startHosted({
        binary: settings.binary,
        args: claudeArgs(settings, input, randomUUID(), prompt.text),
        // The transcript location IS the session here — CLAUDE_CONFIG_DIR is
        // the only knob, so it points at this attempt's dir and nowhere else.
        env: { ...input.env, CLAUDE_CONFIG_DIR: sessionRef },
        sessionRef,
        input,
        logger,
        onSettled: dropIdentity,
      });
    },
  };
}
