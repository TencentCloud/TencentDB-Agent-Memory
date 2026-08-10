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

/** Drop launcher-owned flags (and the value of those that take one). Each
 * host owns its OWN session flags, so the list is a parameter. */
export function stripOwnedFlags(
  flags: readonly string[],
  owned: readonly string[] = LAUNCHER_OWNED_FLAGS,
): string[] {
  const kept: string[] = [];
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i]!;
    if (!owned.includes(flag)) {
      kept.push(flag);
      continue;
    }
    // A `--no-*` switch carries nothing; the rest take a value with them.
    if (!flag.startsWith("--no-")) i += 1;
  }
  return kept;
}

export interface LauncherSettings {
  binary: string;
  flags: string[];
}

/** `memory.consolidation.launchers.<id>` — the new home. */
const launcherSettingsSchema = z.strictObject({
  binary: z.string().min(1).optional(),
  flags: z.array(z.string()).optional(),
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

  const settings: Record<string, LauncherSettings> = {
    [PI_LAUNCHER_ID]: {
      binary: expandHome(
        str(pi, "binary") ?? legacyBinary ?? DEFAULT_PI_BINARY,
      ),
      flags: strArray(pi, "flags") ?? legacyFlags ?? [...DEFAULT_PI_FLAGS],
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
      flags: strArray(cfg, "flags") ?? [],
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
