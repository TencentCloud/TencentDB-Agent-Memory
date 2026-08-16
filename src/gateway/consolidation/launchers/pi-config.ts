/**
 * The pi launcher's own slice of the config (tz-06 L1/§Инварианты
 * `no-host-hardcode`).
 *
 * The binary name and the fixed flags belong to the launcher, so their SCHEMA
 * belongs here too — `src/config.ts` composes this fragment without ever
 * naming a pi-specific key.
 *
 * Kept apart from `pi.ts` so that reading config never pulls in
 * node:child_process.
 */
import { z } from "zod";

export const PI_LAUNCHER_ID = "pi";

/** Per-attempt working data lives under `<scratch>/attempts/<attemptId>/`. */
export const ATTEMPTS_DIR = "attempts";

export const DEFAULT_PI_BINARY = "pi";
export const DEFAULT_PI_FLAGS: readonly string[] = ["-p", "--no-context-files"];

/**
 * Extra read-only directories pi scans for subagent definitions.
 *
 * The child runs on a private HOME carrying nothing but its credential, so
 * `~/.pi/agent/agents` — where the operator keeps the definitions — resolves
 * into an empty directory and the role cannot spawn anything. This variable is
 * the host's own way out: the extension documents it for exactly this case
 * ("lets a hermetic wrapper expose bundled agents without copying them into the
 * writable agent dir").
 *
 * The gateway names DIRECTORIES, never an agent: which critic a role calls is
 * written in the role's skill, and TDAI does not get to know it (AGENTS.md).
 */
export const ENV_PI_SUBAGENT_DIRS = "PI_SUBAGENT_EXTRA_AGENT_DIRS";

/**
 * Session flags the launcher OWNS (tz-06 Ф3, `session-per-attempt`).
 *
 * A run without a session cannot be inspected after the fact, and two attempts
 * sharing one session glue their transcripts together — both break the
 * protocol, so an operator's fixed flags may not decide this. Whatever the
 * config says, these are stripped and the launcher appends its own.
 */
export const LAUNCHER_OWNED_FLAGS: readonly string[] = [
  "--no-session",
  "--session-dir",
  "--session",
  "--session-id",
];

/**
 * Owned flags that take a VALUE. Everything else is a switch.
 *
 * The list is explicit because the alternative — guessing from the flag's
 * shape — silently ate the next argument: `--dangerously-skip-permissions -p`
 * stripped BOTH, and a claude launched without `-p` waits on a stdin that is
 * `ignore`d, i.e. hangs until the timeout. Same shape for codex's `--ephemeral
 * exec`, which loses the subcommand and opens a TUI.
 */
const OWNED_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set([
  "--session-dir",
  "--session",
  "--session-id",
  "--resume",
  "--permission-mode",
  "-C",
  "--cd",
  "-s",
  "--sandbox",
  "-m",
  "--model",
  "--tools",
  "--extension",
  "--skill",
  "--prompt-template",
  "--theme",
  "--append-system-prompt",
  "--system-prompt",
  "--mcp-config",
  "--exclude-tools",
  "-t",
  "-xt",
  "-e",
]);

/** Drop launcher-owned flags (and the value of those that take one). Each
 * host owns its OWN session flags, so the list is a parameter. */
export function stripOwnedFlags(
  flags: readonly string[],
  owned: readonly string[] = LAUNCHER_OWNED_FLAGS,
): string[] {
  const kept: string[] = [];
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i]!;
    const name = flag.includes("=") ? flag.slice(0, flag.indexOf("=")) : flag;
    if (!owned.includes(name)) {
      kept.push(flag);
      continue;
    }
    // Consume the value only when the flag has one AND the next token looks
    // like a value: `--resume` is optional-valued on claude, so a following
    // `-p` is the next FLAG, never its argument.
    const next = flags[i + 1];
    if (
      !flag.includes("=") &&
      OWNED_FLAGS_WITH_VALUE.has(name) &&
      next !== undefined &&
      !next.startsWith("-")
    ) {
      i += 1;
    }
  }
  return kept;
}

export interface LauncherSettings {
  binary: string;
  /** Absent means "the launcher's own defaults" — a host's flags belong to
   * the host (`no-host-hardcode`), so the config only carries an OVERRIDE.
   * An empty array is a deliberate "no flags", not "give me the defaults". */
  flags?: string[];
  /** Directories of subagent definitions the child may read. @see
   * ENV_PI_SUBAGENT_DIRS. Absent means the child spawns nothing. */
  subagentDirs?: string[];
}

/** `memory.consolidation.launchers.<id>` — the new home. */
const launcherSettingsSchema = z.strictObject({
  binary: z.string().min(1).optional(),
  flags: z.array(z.string()).optional(),
  subagentDirs: z.array(z.string().min(1)).optional(),
});

export const launchersSchema = z
  .record(z.string().min(1), launcherSettingsSchema)
  .optional();

/**
 * Keys that used to sit directly under `memory.consolidation`. The schema is
 * strict, so dropping them would turn every existing operator config into a
 * startup error — they stay ACCEPTED here and are mapped below.
 */
export const legacyLauncherKeys = {
  piBinary: z.string().min(1).optional(),
  spawnFlags: z.array(z.string()).optional(),
};

export interface LauncherConfigResult {
  settings: Record<string, LauncherSettings>;
  /** Legacy keys actually seen — the gateway logs them once at startup. */
  deprecated: string[];
}

type Raw = Record<string, unknown> | undefined;

const str = (g: Raw, k: string): string | undefined =>
  typeof g?.[k] === "string" ? (g[k] as string) : undefined;
const strArray = (g: Raw, k: string): string[] | undefined =>
  Array.isArray(g?.[k]) &&
  (g[k] as unknown[]).every((v) => typeof v === "string")
    ? (g[k] as string[])
    : undefined;

/**
 * Read the launcher settings out of `memory.consolidation`.
 * @param expandHome resolves a leading `~/` — the caller owns that helper.
 */
export function readLauncherConfig(
  consolidation: Raw,
  expandHome: (p: string) => string,
): LauncherConfigResult {
  const group = consolidation?.["launchers"] as Raw;
  const pi = group?.[PI_LAUNCHER_ID] as Raw;

  const deprecated: string[] = [];
  const legacyBinary = str(consolidation, "piBinary");
  const legacyFlags = strArray(consolidation, "spawnFlags");
  if (legacyBinary !== undefined) deprecated.push("piBinary");
  if (legacyFlags !== undefined) deprecated.push("spawnFlags");

  // Subagent dirs are PATHS, so `~/` is expanded per entry — the same courtesy
  // `binary` already gets. `flags` deliberately stays raw: an operator's flag
  // list is passed through verbatim, and folding `~` into it now would change
  // how every existing config is read.
  const dirs = (cfg: Raw): string[] | undefined =>
    strArray(cfg, "subagentDirs")?.map(expandHome);

  const settings: Record<string, LauncherSettings> = {
    [PI_LAUNCHER_ID]: {
      binary: expandHome(
        str(pi, "binary") ?? legacyBinary ?? DEFAULT_PI_BINARY,
      ),
      flags: strArray(pi, "flags") ?? legacyFlags ?? [...DEFAULT_PI_FLAGS],
      subagentDirs: dirs(pi),
    },
  };
  // Any OTHER launcher the operator configured. Defaults for a host nobody
  // asked for would be a host silently available — the registry decides what
  // it can build, this only reports what was written down.
  for (const [id, raw] of Object.entries(group ?? {})) {
    if (id === PI_LAUNCHER_ID) continue;
    const cfg = raw as Raw;
    settings[id] = {
      binary: expandHome(str(cfg, "binary") ?? id),
      flags: strArray(cfg, "flags"),
      subagentDirs: dirs(cfg),
    };
  }
  return { settings, deprecated };
}

/** One line for the startup log; empty when nothing legacy was used. */
export function deprecationNotice(deprecated: string[]): string {
  if (deprecated.length === 0) return "";
  return (
    `memory.consolidation.${deprecated.join("/")} is deprecated — ` +
    `move it to memory.consolidation.launchers.${PI_LAUNCHER_ID}.` +
    `{binary,flags}. The old keys still work for now — but the session ` +
    `flags among them (${LAUNCHER_OWNED_FLAGS.join(", ")}) are IGNORED: ` +
    `the launcher owns the session (tz-06 Ф3).`
  );
}
