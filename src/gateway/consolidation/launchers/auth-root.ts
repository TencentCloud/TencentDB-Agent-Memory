/**
 * Auth-root per launcher (tz-07 H3).
 *
 * "Where does the executor take its credentials on THIS host" is one declared
 * fact, not a literal repeated per launcher. The package only says WHERE they
 * are read from — handing a key through the child env stays forbidden
 * (`nogo-secrets`, R2), so nothing here is ever put into an env whitelist.
 *
 * pi is the one host with no dedicated variable: opencode-go reads
 * `<authRoot>/.pi/agent/auth.json` itself, through HOME. That is also why pi
 * is the only host with a task tree of its own (`hostTaskRoots`).
 */
import os from "node:os";
import path from "node:path";
import { getEnv } from "../../../utils/env.js";

export const AUTH_ROOT_ENV: Record<string, string | null> = {
  pi: null,
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

const AUTH_ROOT_DIR: Record<string, string | null> = {
  pi: null,
  claude: ".claude",
  codex: ".codex",
};

function home(): string {
  return getEnv("HOME") ?? getEnv("USERPROFILE") ?? os.homedir();
}

/**
 * The directory this launcher's executor logs into. For claude/codex it is
 * ALSO where the transcript lands (claude.ts, codex.ts) — one directory with
 * two jobs, which is why it has to be named once rather than derived twice.
 */
export function authRootFor(launcherId: string): string {
  const envKey = AUTH_ROOT_ENV[launcherId];
  if (envKey !== null && envKey !== undefined) {
    const fromEnv = getEnv(envKey);
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  }
  const dir = AUTH_ROOT_DIR[launcherId];
  return dir === null || dir === undefined ? home() : path.join(home(), dir);
}

/**
 * Where the host itself spools task artifacts, if it does. This is a HOST
 * root, not a memory root: under claude/codex there is none at all, because
 * their per-attempt artifacts already live under scratch (start.ts). Returning
 * an empty list is how "no-op for this host" is expressed — cleanup stays
 * launcher-agnostic and never grows a per-host branch.
 */
export function hostTaskRootFor(launcherId: string): string | null {
  return launcherId === "pi"
    ? path.join(authRootFor("pi"), ".pi", "agent", "tasks")
    : null;
}

/** Task roots for every configured launcher, de-duplicated. */
export function hostTaskRoots(launcherIds: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const id of launcherIds) {
    const root = hostTaskRootFor(id);
    if (root !== null) roots.add(root);
  }
  return [...roots];
}
