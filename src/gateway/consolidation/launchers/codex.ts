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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
 * attempt. `-s/--sandbox` is owned too, but to REMOVE it: confinement in this
 * codebase is the L6 bwrap path (isolation.ts), and codex's own sandbox is a
 * second, different confinement — on this machine it does not even run (it
 * wants a `[permissions]` profile and then dies on a missing vendored
 * binary). Two sandboxes, one of them broken, is worse than one. */
const OWNED = ["-C", "--cd", "--ephemeral", "-s", "--sandbox"];

export function codexArgs(
  settings: LauncherSettings,
  input: LaunchInput,
  prompt: string,
): string[] {
  return [
    ...stripOwnedFlags(settings.flags ?? [...DEFAULT_CODEX_FLAGS], OWNED),
    "-C",
    input.cwd,
    "-m",
    input.contract.binding.model,
    prompt,
  ];
}

/** The operator's real codex home — where auth.json and config.toml live. */
export function operatorCodexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

/** Link (never copy) identity into the attempt home: a copy of auth.json is a
 * second secret on disk with its own lifetime. Best-effort — a codex without
 * credentials fails loudly on its own, and that is a run error, not a launch
 * one. */
export function linkCodexIdentity(sessionDir: string, logger: Logger): void {
  const home = operatorCodexHome();
  for (const name of ["auth.json", "config.toml"]) {
    const src = path.join(home, name);
    const dst = path.join(sessionDir, name);
    try {
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst);
    } catch (err) {
      logger.debug?.(
        `[codex] could not link ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
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
      // CODEX_HOME is BOTH the auth/config home and the session store. Pointing
      // it at an empty per-attempt dir took the credentials away with the
      // isolation — the child would have had nowhere to authenticate from. The
      // attempt dir stays writable and gets read-only links to the operator's
      // auth and config.
      linkCodexIdentity(sessionRef, logger);
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
