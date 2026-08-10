/**
 * The codex launcher (tz-06 Ф5b) — third host behind the same port.
 *
 * Host differences absorbed here: the session lives under CODEX_HOME (no
 * session flag at all), and there is no system-prompt flag — the prompt the
 * pipeline wrote is prepended to the task text.
 *
 * codex has its own sandbox flag (`-s <mode>`), and it is NOT the package's
 * confinement: L6 is the bwrap wrapper in isolation.ts, applied to every
 * host's argv alike. `-s` only bounds what the child's own shell tool may
 * touch, and it must permit writing the run dir.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

export const CODEX_LAUNCHER_ID = "codex";
export const DEFAULT_CODEX_BINARY = "codex";
/** `exec` is the non-interactive entry; the repo check is off because the
 * scratch dir of a run is not a git worktree. */
export const DEFAULT_CODEX_FLAGS: readonly string[] = [
  "exec",
  "--skip-git-repo-check",
];

/** @see capabilities.ts. `session` is the CODEX_HOME below; `tool-subset` is
 * the host-agnostic one — only the role's declared helpers are copied into
 * `<scratch>/tools/` (keeper-tools.ts:81). No extension/skill/thinking: codex
 * has no equivalent. Confinement is not listed at all: `-s` is codex's own
 * sandbox, NOT the L6 wrapper, and L6 is decided by isolation.ts for every
 * host alike. */
const CODEX_CAPABILITIES: ReadonlySet<string> = new Set([
  "session",
  "tool-subset",
]);

/** Owned by the launcher: the session, the working root and the sandbox mode
 * are decided per attempt, not by an operator flag.
 *
 * `-s` is NOT the L6 confinement (that is bwrap, isolation.ts) — it is what
 * the child's own shell tool may touch, and it must permit writing the run
 * directory. codex exec defaults to `read-only`, under which the role exits 0
 * having written no `diff.json` at all: a silent "no candidate" on every run.
 * The standalone `codex sandbox` subcommand is the broken one here; this flag
 * is a different mechanism and is required. */
const OWNED = ["-C", "--cd", "--ephemeral", "-s", "--sandbox"];

/** The child writes its candidate into its own scratch and nothing else. */
export const SANDBOX_MODE = "workspace-write";

export function codexArgs(
  settings: LauncherSettings,
  input: LaunchInput,
  prompt: string,
): string[] {
  return [
    ...stripOwnedFlags(settings.flags ?? [...DEFAULT_CODEX_FLAGS], OWNED),
    "-C",
    input.cwd,
    "-s",
    SANDBOX_MODE,
    "-m",
    input.contract.binding.model,
    prompt,
  ];
}

/** The operator's real codex home — where auth.json and config.toml live. */
export function operatorCodexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

/** Auth and config for the attempt's private CODEX_HOME. */
export function provideCodexIdentity(
  sessionDir: string,
  logger: Logger,
): () => void {
  return provideIdentity(
    sessionDir,
    operatorCodexHome(),
    ["auth.json", "config.toml"],
    logger,
    "codex",
  );
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
      // attempt dir stays writable and gets its own copies of the operator's
      // auth and config, dropped when the attempt settles.
      const dropIdentity = provideCodexIdentity(sessionRef, logger);
      const prompt = readSystemPrompt(input);
      if (!prompt.ok) {
        dropIdentity();
        return prompt.outcome;
      }

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
        onSettled: dropIdentity,
      });
    },
  };
}
